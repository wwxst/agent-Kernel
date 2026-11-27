/**
 * 文件目的：一次 Run 的状态账本。Agent 跑任务时要记住问了几次模型、重试了几次、执行了多少工具、
 * 花了多少 token、这轮回了什么，还要判断「连续几批调用和结果都一模一样」——这些数据和判定集中在这里，
 * 主循环只负责决定何时读写它们。
 *
 * 文件职责：保存并判断**一次 Run** 的计数、用量、回复与无进展状态；不请求模型、不执行工具、
 * 不访问 SessionContext、不通知界面（这些归 Agent）；Session 级的累计账单也不在这里，
 * 由 Agent 的 sessionStats 汇总。
 *
 * 内容目录：
 *   - `AgentUsage`：一次 Run 或整个 Session 的用量；成本未知单独计数，不补 0。
 *   - `emptyUsage()`：返回一份全零用量，每次都是新对象，避免共用同一个可变对象。
 *   - `RunState`：一次 Run 独占的状态：请求 / 重试 / 溢出重发 / 工具调用计数、用量、回复列表，
 *     以及最近工具批次的无进展判定。
 *   - `MAX_IDENTICAL_TOOL_BATCHES`：普通工具连续多少批完整相同才判定无进展。
 *   - `toolBatchSignature()`：把一批工具调用规范化成稳定签名；连同宿主侧结果的比较，用于无进展判定。
 *
 * 模块关系：只依赖 `protocol/types.ts` 的消息与工具类型，不认识 Agent、UI、Tools 实现和 Model 实现。
 * `agent.ts` 持有并驱动 `RunState`：Agent 决定何时记录请求与工具批次，这里只返回判断结果。
 */
import type { Message, ToolCall, ToolExecutionResult } from "../protocol/types.ts";

/**
 * 一次任务里能观察到的用量。
 *
 * `unknown` 不是装饰：端点可能不返回 usage，那几个 token 数就只是**已报告部分**的和。
 * 只要 unknown > 0，调用方就不能说「这次任务精确花了 X token」。
 */
export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 已明确报告的缓存命中输入 Token。 */
  cachedPromptTokens: number;
  /** 明确报告缓存用量的请求数；0 与未知分开统计。 */
  cacheUsageReported: number;
  /** 没有缓存用量字段或整个 usage 缺失的请求数。 */
  cacheUsageUnknown: number;
  /** 带 usage 的请求数。 */
  reported: number;
  /**
   * 成本未知的请求数：端点没返回 usage，或者请求在中途失败（可能已产生费用）。
   * 大于 0 时上面的合计只是下限，不能说「这次任务精确花了 X token」。
   */
  unknown: number;
}

/** 一份全零的用量。每次 Run 开始和 Session 创建时各拿一份，避免共用同一个可变对象。 */
export function emptyUsage(): AgentUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    cacheUsageReported: 0,
    cacheUsageUnknown: 0,
    reported: 0,
    unknown: 0,
  };
}

/** 普通工具连续三批完整相同才判定无进展，避免把一次偶然的稳定结果当成死循环。 */
export const MAX_IDENTICAL_TOOL_BATCHES = 3;

/** 将 JSON 参数规范化，让对象键顺序不影响工具批次签名；数组顺序仍保留。 */
function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

/** 参数不是合法 JSON 时保留原文，让坏参数仍能形成稳定签名并交给 ToolRegistry 报错。 */
function canonicalizeArguments(argumentsText: string): string {
  // ToolRegistry 将空参数串作为空对象执行，两种写法必须共用重复计数。
  if (argumentsText === "") return "{}";
  try {
    return JSON.stringify(canonicalizeJson(JSON.parse(argumentsText)));
  } catch {
    return argumentsText;
  }
}

/** 工具调用顺序有意义，所以只规范化每个调用的参数，不排序调用数组。 */
export function toolBatchSignature(calls: readonly ToolCall[]): string {
  return JSON.stringify(calls.map((call) => [
    call.function.name,
    canonicalizeArguments(call.function.arguments),
  ]));
}

/**
 * 两批工具结果是否逐条相同：内容、错误状态、等待状态都一致才算「没有进展」。
 *
 * 比较的是宿主侧结果，不是模型看到的文本：只有这里才知道一次读取是「有效等待」还是「普通稳定输出」。
 */
function sameToolResults(left: readonly ToolExecutionResult[], right: readonly ToolExecutionResult[]): boolean {
  return left.length === right.length && left.every((result, index) => {
    const other = right[index];
    return result.content === other.content && result.isError === other.isError && result.isWaiting === other.isWaiting;
  });
}

/** 一个 Run 独占的状态。开始下一次任务时整体替换，Session 的历史与账单独立保留。 */
export class RunState {
  requests = 0;
  // 两种重发都计入统计，只有真正发出才计数。
  retries = 0;
  overflowRetries = 0;
  toolCalls = 0;
  readonly usage = emptyUsage();
  readonly replies: Message[] = [];
  private lastToolBatch?: {
    signature: string;
    results: readonly ToolExecutionResult[];
    /**
     * 连续相同批次里「没有进展」的次数。只有整串连续相同批次都是有效等待时才不计数 ——
     * 等后台任务不是原地打转；但一旦这串里出现过普通批次，后续的等待批次就照普通规则计数，
     * 也不会把之前的计数清零（见 ADR-0030 的不变量）。
     */
    repetitions: number;
    /**
     * 这串连续相同批次是否每一批都是有效等待。一旦混进非等待批次就永久为 false，
     * 豁免随即失效，不会因为后面又出现一次等待而恢复。
     */
    allWaiting: boolean;
  };

  /** 只有完整批次才记录。直接比较文本和状态，避免把整批大结果再序列化一份。 */
  recordToolBatch(signature: string, results: readonly ToolExecutionResult[], waiting: boolean): void {
    const previous = this.lastToolBatch;
    if (previous === undefined || previous.signature !== signature) {
      this.lastToolBatch = { signature, results, repetitions: waiting ? 0 : 1, allWaiting: waiting };
      return;
    }

    // 结果变化只重置重复次数；同一签名的等待链一旦遇到普通批次，就不能再恢复豁免。
    const allWaiting = previous.allWaiting && waiting;
    const sameResults = sameToolResults(previous.results, results);
    const repetitions = sameResults
      ? (allWaiting ? previous.repetitions : previous.repetitions + 1)
      : (allWaiting ? 0 : 1);
    this.lastToolBatch = { signature, results, repetitions, allWaiting };
  }

  /**
   * 是否该在执行前拦下这一批：上一批同签名、同结果，且不构成有效等待。
   *
   * 有效等待的重复是正常轮询（后台任务还没输出），交给 maxSteps 兜底；
   * 只要链上出现过普通批次，豁免就失效，重复三次仍然会被拦下。
   */
  shouldStopToolBatch(signature: string): boolean {
    const last = this.lastToolBatch;
    if (last === undefined || last.signature !== signature) return false;
    if (last.allWaiting) return false;
    return last.repetitions >= MAX_IDENTICAL_TOOL_BATCHES;
  }
}

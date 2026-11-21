/**
 * 文件目的：整个程序的核心 —— 让 agent loop 跑起来。问模型 → 它要工具就去执行 →
 * 把结果塞回去 → 再问，直到它不再要工具。换模型、换工具集都不改这里，所以它叫「核心」。
 *
 * 一个实例对应一个 Session，可以顺序跑多个 Run；Transcript 跨 Run 累积，超预算时压缩旧内容，预算按 Run 重算。
 * 同时只允许一个 Run，返回的消息与统计都是副本，宿主不能改写已确认的会话状态。
 *
 * 文件职责：负责循环、消息顺序与 id 配对、三类预算（步数 / 工具调用 / token）、
 * 构造期参数校验、无进展循环检测（稳定结果连续重复就停手；只有整批都是「有效等待」才豁免，
 * 且最终仍由步数闸门兜底）、
 * 会话生命周期、用量记账，以及把事件通知给界面（观察者抛异常只计数，不打断任务）。
 * 每步委托 SessionContext 准备可发送的上下文，在服务端报告窗口超限时请求一次恢复。
 *
 * 内容目录：
 *   - `DEFAULT_SYSTEM_PROMPT`：默认系统提示，从 `core/default-system-prompt.ts` 转出，保持既有入口。
 *   - `AgentUsage` / `AgentStats` / `AgentSessionStats`：用量与统计；成本未知单独计数，不补 0；
 *     业务请求与辅助摘要请求分开计数。
 *   - `AgentOptions`：客户端、工具、系统提示、四个预算（步数 / 工具调用 / token / 上下文窗口）、
 *     取消信号与六种观察回调。
 *   - `Agent`：`run(task)` 跑一次任务；`transcript`、`runReplies`、`stats`、`sessionStats`、
 *     `observerFailureCount`、`retryAttempts`、`toolExecutionDisabled`。
 *   - latestConfirmedReply：最后一次业务请求已确认的回复，供展示层结束草稿。
 *   - RunState 与 runLoop()：本轮预算与进展、业务请求、工具批次准入与结果回传。
 *
 * 模块关系：SessionContext 维护对话，ToolRegistry 执行工具，ChatClient 发送请求。
 * CLI、TUI 和 eval 通过 Agent 的任务入口及只读快照观察进度。
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  ChatResponseError,
  ProcessCleanupError,
  isContextOverflowError,
  isRetryableModelError,
} from "../protocol/errors.ts";
import type { ChatClient, ChatOptions, ChatResponse, Message, TokenUsage, ToolCall, ToolDefinition, ToolExecutionResult } from "../protocol/types.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt.ts";
import { SessionContext } from "./session-context.ts";
import type { ContextOptions } from "./session-context.ts";

export { DEFAULT_SYSTEM_PROMPT };

/** 命令行与直接嵌入 Agent 的调用方共享同一套默认 Run 预算。 */
export const DEFAULT_MAX_STEPS = 30;
export const DEFAULT_MAX_TOOL_CALLS = 60;

/**
 * 把一次工具执行结果包装成一条 tool 消息。
 *
 * 关键点：tool_call_id 必须等于模型发起调用时的 call.id。
 * API 靠这个 id 把「结果」和「请求」配对；写错或漏写，整个请求会被判为非法。
 */
function createToolResult(call: ToolCall, result: string): Message {
  return { role: "tool", tool_call_id: call.id, content: result };
}

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
function toolBatchSignature(calls: readonly ToolCall[]): string {
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

/** 取消时抛出的错误：把 signal 上的原因带出来，CLI 才能说清是被什么停掉的。 */
function cancellationError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return new Error(detail.length > 0 ? `cancelled: ${detail}` : "cancelled");
}

/** 一份全零的用量。每次 Run 开始和 Session 创建时各拿一份，避免共用同一个可变对象。 */
function emptyUsage(): AgentUsage {
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

/** 预算是跨模块的运行时输入，不能只依赖 TypeScript 的静态类型。 */
function assertIntegerBudget(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    // 中文对照：配置 {name} 的值 {value} 不合法，需要一个不小于 {minimum} 的整数。
    throw new Error(`invalid ${name}: ${String(value)} (expected an integer >= ${minimum})`);
  }
}

/** 普通工具连续三批完整相同才判定无进展，避免把一次偶然的稳定结果当成死循环。 */
const MAX_IDENTICAL_TOOL_BATCHES = 3;

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

/** 一次 Run 的成本与执行量。和 transcript 一样，失败之后也可以读；跨 Run 的累计见 `sessionStats`。 */
export interface AgentStats {
  /**
   * 本次 Run 发出去的**业务**模型请求数（失败的请求也算一次尝试）。
   * 辅助摘要请求单独记在 `summaryRequests` 里：它们不是 Step，混进来会让「第几步」对不上。
   */
  requests: number;
  /** 本次 Run 为压缩历史而发出的摘要请求数；这些请求的用量已经算进 `usage`。 */
  summaryRequests: number;
  /** 本次 Run 因为上下文超限而额外重发的请求数；它也算在 `requests` 里。 */
  overflowRetries: number;
  /** 本次 Run 已处理的工具调用数：含校验失败，不含因预算跳过的调用。 */
  toolCalls: number;
  usage: AgentUsage;
  /**
   * 本次 Run 的 token 预算状态。`exceeded` 可能在一次**成功**的 Run 之后为 true ——
   * 那个把预算顶穿的最终回复已经被返回，钱也已经花了，只是不再发新请求。
   * 调用方要「硬上限」的话，应该在成功返回后自己检查这个标志。
   */
  tokenBudget: {
    /** undefined = 没有设置预算。 */
    limit?: number;
    /** 已统计到的合计是否达到或超过上限。 */
    exceeded: boolean;
  };
}

/**
 * 整个 Session 的累计用量：跨 Run 求和，用来回答「这轮对话一共花了多少」。
 *
 * 和 `stats` 分开是有意的：预算按 Run 算（一轮任务的花销），账单按 Session 算
 * （**这一个 Agent 实例**从创建到销毁的合计）。
 *
 * 它不是「整个进程」的总账：子 Agent 是独立的 Agent 实例，花销不进父 Agent 这里
 * （ADR-0025 明确这是有意的）。宿主若要报总花费，得自己把各实例的 `sessionStats` 相加。
 */
export interface AgentSessionStats {
  /** 已经开始的 Run 数；失败或取消的 Run 也算一次。 */
  runs: number;
  /** 业务模型请求数；辅助摘要请求另计 `summaryRequests`，两者相加才是这个实例发出的全部请求。 */
  requests: number;
  /** 整个会话为压缩历史发出的摘要请求数。 */
  summaryRequests: number;
  toolCalls: number;
  usage: AgentUsage;
}

export interface AgentOptions extends ContextOptions {
  /** 模型客户端。传接口而不是具体类，测试时才能注入假实现。 */
  llm: ChatClient;
  /** 模型能调用的工具集合。 */
  tools: ToolRegistry;
  /** 不传就用 DEFAULT_SYSTEM_PROMPT。传函数时在每次模型请求前求值，可注入项目指令等动态内容。 */
  systemPrompt?: string | (() => string);
  /** 循环上限。设计稿里是 while (true)，实战必须有这个刹车。 */
  maxSteps?: number;
  /**
   * 一次任务最多处理多少次工具调用。默认 60；参数错误也消耗此额度。
   *
   * 为什么和 maxSteps 分开：`maxSteps` 数的是「问了模型几次」，一次模型回复可以要 3 个工具，
   * 所以 30 步最多能跑 90 次工具。两个预算各管一件事，不能用一个数字假装管住另一个。
   */
  maxToolCalls?: number;
  /**
   * 一次任务累计多少 token（prompt + completion）后停止。不传表示不限制。
   *
   * 这是**软预算 / 请求准入**，不是硬性总量上限：
   *   - 达到上限后不再发新请求、不再执行没有后续请求验证的工具；
   *   - 但把预算顶穿的那一条回复已经产生费用，Agent 会如实记录它；
   *   - 如果那条正好是最终答复，Run 会正常返回成功，`stats.tokenBudget.exceeded` 为 true，
   *     调用方可以据此决定要不要把这次任务标记为超预算。
   *
   * 只统计端点**报告了** usage 的部分；请求失败或没带 usage 时成本记为未知（stats.usage.unknown），
   * 预算拦不住那部分消耗。不假装这是精确的成本上限。
   */
  maxTotalTokens?: number;
  /**
   * 取消信号。CLI 收到 SIGINT / SIGTERM 时 abort 它：
   * 循环不再发起新的模型请求或工具调用，正在跑的 shell 由 Workspace 收掉进程树。
   */
  signal?: AbortSignal;
  /** 每次工具执行完的回调，用来打印进度；Agent 本身不直接 console.log。 */
  onToolResult?: (call: ToolCall, result: string, isError: boolean) => void;
  /**
   * 每次工具**开始执行前**的回调。给 TUI 用：先把「要跑什么」写进运行记录，
   * 再等真实结果，而不是等工具跑完才一次性出现。
   *
   * 不会为被预算/取消跳过的调用触发 —— 那些调用没有执行，不能假装它们开始过。
   */
  onToolCall?: (call: ToolCall, confirmedContent: string | null) => void;
  /**
   * 每次模型请求**发出前**的唯一回调：step 从 1 开始，每个 Run 重新计数。
   * CLI 使用 step 展示阶段，TUI 只需知道开始思考；不能为一次请求重复发送通知。
   */
  onRequestStart?: (step: number) => void;
  /** 仅对确认可重试的请求报告真实进度，不代表一个新的 Agent Step。 */
  onRetry?: (error: unknown, attempt: number, maxRetries: number) => void;
  /** 每个 Step 的暂时网络或服务故障重试上限，默认零。上下文超限恢复另有一次机会。 */
  maxModelRetries?: number;
  /**
   * 流式正文增量。只在 ChatClient 支持流式时才会被调用，且只用于显示：
   * 最终消息仍以 chat() 的返回值为准，回调晚到、漏掉都不影响正确性。
   */
  onDelta?: (text: string) => void;
}

/** 一个 Run 独占的状态。开始下一次任务时整体替换，Session 的历史与账单独立保留。 */
class RunState {
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

export class Agent {
  private readonly llm: ChatClient;
  private readonly tools: ToolRegistry;
  private readonly context: SessionContext;
  private readonly maxSteps: number;
  private readonly maxToolCalls: number;
  private readonly maxTotalTokens?: number;
  private readonly signal?: AbortSignal;
  private readonly onToolResult?: (call: ToolCall, result: string, isError: boolean) => void;
  private readonly onToolCall?: (call: ToolCall, confirmedContent: string | null) => void;
  private readonly onRequestStart?: (step: number) => void;
  private readonly onRetry?: (error: unknown, attempt: number, maxRetries: number) => void;
  private readonly maxModelRetries: number;
  private readonly onDelta?: (text: string) => void;

  /** 展示观察者失败的累计次数；不参与 Agent 执行、Transcript 或 token 统计。 */
  private observerFailures = 0;

  /** 当前或最近完成的 Run，宿主可在下一次 run() 前读取其快照。 */
  private currentRun = new RunState();

  /** 跨 Run 的累计账单。 */
  private sessionRequests = 0;

  private sessionToolCalls = 0;

  private readonly sessionUsage: AgentUsage = emptyUsage();

  /** 已经开始的 Run 数。 */
  private runCount = 0;

  /** 同一时刻只允许一个 Run：两个 run() 同时写一条 transcript，语义无法解释。 */
  private running = false;

  /**
   * 进程树清理未确认后，整个 Agent Session 禁止再次启动工具。
   * 只有宿主确认遗留进程已处理并创建新的 Agent，才能恢复工具执行。
   */
  private processCleanupUnverified = false;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.tools = options.tools;
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.maxTotalTokens = options.maxTotalTokens;
    this.signal = options.signal;
    this.onToolResult = options.onToolResult;
    this.onToolCall = options.onToolCall;
    this.onRequestStart = options.onRequestStart;
    this.onRetry = options.onRetry;
    this.maxModelRetries = options.maxModelRetries ?? 0;
    assertIntegerBudget("maxSteps", this.maxSteps, 1);
    assertIntegerBudget("maxToolCalls", this.maxToolCalls, 0);
    if (this.maxTotalTokens !== undefined) assertIntegerBudget("maxTotalTokens", this.maxTotalTokens, 0);
    assertIntegerBudget("maxModelRetries", this.maxModelRetries, 0);
    this.onDelta = options.onDelta;
    assertIntegerBudget("outputTokenReserve", options.outputTokenReserve ?? 0, 0);
    this.context = new SessionContext(options, systemPrompt, {
      canSummarize: () => !this.budgetExhausted(),
      checkCancelled: () => this.stopIfCancelled(),
      summarize: async messages => (await this.chatAndRecord(messages, [], {})).message,
    });
  }

  /** 最后一步只收尾。准入、压缩、重发共用同一份工具表，避免为无法执行的工具腾窗口。 */
  private toolsForStep(step: number): readonly ToolDefinition[] {
    if (step === this.maxSteps || this.currentRun.toolCalls >= this.maxToolCalls || this.processCleanupUnverified) return [];
    return this.tools.definitions;
  }

  /** Run 累计预算是否已经用完。压缩要花钱，所以先问一句「还付得起吗」。 */
  private budgetExhausted(): boolean {
    return this.maxTotalTokens !== undefined && this.currentRun.usage.totalTokens >= this.maxTotalTokens;
  }

  /**
   * 取消检查点：每一轮模型请求之前、每一次工具调用之前都要过。
   *
   * 光靠 fetch 的 signal 不够 —— 取消可能发生在两次工具调用之间，那里没有网络请求可中断。
   * pending 是「本来接下来要执行的调用」：给它们补上 not run 的结果，Transcript 的
   * assistant / tool 配对才不会断（配对断了，事后拿记录去复盘或重放都会被 API 拒绝）。
   */
  private stopIfCancelled(pending: readonly ToolCall[] = [], start = 0): void {
    if (this.signal?.aborted !== true) return;
    this.skipCalls(pending.slice(start), "task cancelled");
    throw cancellationError(this.signal);
  }

  /**
   * 展示回调属于旁路观察者，不能决定 Agent Loop 是否继续。
   * 同步抛错和意外返回的 rejected Promise 都只计入诊断；不把 UI 故障伪装成工具失败。
   * 不等待 Promise：等待展示回调会让用户界面的慢操作改变工具的执行时机。
   */
  private notifyObserver<T extends unknown[]>(callback: ((...args: T) => void) | undefined, ...args: T): void {
    if (callback === undefined) return;
    try {
      const returned: unknown = callback(...args);
      if (returned !== null && (typeof returned === "object" || typeof returned === "function") &&
          "then" in returned && typeof returned.then === "function") {
        void Promise.resolve(returned).catch(() => {
          this.observerFailures++;
        });
      }
    } catch {
      this.observerFailures++;
    }
  }

  /** 核心成员 observerFailureCount（回调失败数）：累计展示回调失败数；可供宿主诊断，但绝不污染模型消息或工具结果。 */
  get observerFailureCount(): number {
    return this.observerFailures;
  }

  /**
   * 核心成员 retryAttempts（重试次数）：本 Run 里没有产生回复的额外请求数。
   *
   * 包含网络重试与上下文超限重发两类。界面用 `stats.requests - retryAttempts`
   * 判断「最后一次响应是否已经写进 Transcript」，所以这两类必须都记进来。
   */
  get retryAttempts(): number {
    return this.currentRun.retries;
  }

  /**
   * 核心成员 runReplies（本次 Run 的回复）：本次 Run 收到的 assistant 消息，按顺序，深拷贝。
   *
   * 为什么不能直接看 `transcript.slice(起点)`：压缩会从数组前面删消息，下标会整体前移，
   * 用旧的起点切片会切到错的位置 —— 界面上表现为「本轮结果不见了」或「把上一轮当本轮」。
   * 这份列表只追加、不受压缩影响。
   */
  get runReplies(): readonly Message[] {
    return structuredClone(this.currentRun.replies);
  }

  /** 最后一次业务请求已确认的回复。失败期间只复制这一条，避免展示层重算请求与回复配对。 */
  get latestConfirmedReply(): Message | undefined {
    const run = this.currentRun;
    return run.replies.length === run.requests - run.retries ? structuredClone(run.replies.at(-1)) : undefined;
  }

  /**
   * 压缩诊断快照：已提交的历史替换次数、存档失败次数、最近一次压缩没成的原因。
   *
   * 只读诊断口，不参与任何决策。宿主据此判断「上下文是不是靠降级路径撑住的」，
   * 而不是从日志里猜。
   */
  get compactionStats() {
    return this.context.compactionStats;
  }

  /**
   * 核心成员 toolExecutionDisabled（工具是否已被禁用）：进程树清理未确认时为 true。
   *
   * 只读诊断口，给「把子 Agent 包起来」的宿主用：子 Agent 可能跑完一次 Run 正常返回，
   * 但它的 shell 后代进程还没确认停掉。宿主必须据此拒绝把这次结果当成功，
   * 否则父 Agent 会接着改文件，而那个进程还在跑。它不改变任何执行行为。
   */
  get toolExecutionDisabled(): boolean {
    return this.processCleanupUnverified;
  }

  /** 没有执行的调用也要留下一条结果：明确写「没跑」，而不是让它们凭空消失。 */
  private skipCalls(calls: readonly ToolCall[], reason: string): void {
    for (const call of calls) {
      const result = createToolResult(call, `ERROR: not run: ${reason}`);
      this.context.append(result);
    }
  }

  /** 核心成员 stats（本次用量）：本次 Run 的用量快照。返回新对象：调用方改不到内部计数。 */
  get stats(): AgentStats {
    const limit = this.maxTotalTokens;
    return {
      requests: this.currentRun.requests,
      summaryRequests: this.context.runSummaryRequests,
      overflowRetries: this.currentRun.overflowRetries,
      toolCalls: this.currentRun.toolCalls,
      usage: { ...this.currentRun.usage },
      tokenBudget: {
        limit,
        exceeded: this.budgetExhausted(),
      },
    };
  }

  /** 核心成员 sessionStats（累计用量）：跨 Run 的累计快照，整个会话一共跑了多少次、花了多少。 */
  get sessionStats(): AgentSessionStats {
    return {
      runs: this.runCount,
      requests: this.sessionRequests,
      summaryRequests: this.context.compactionStats.summaryRequests,
      toolCalls: this.sessionToolCalls,
      usage: { ...this.sessionUsage },
    };
  }

  /**
   * 记一笔用量。usage 缺失时只增加 unknown，绝不补 0 冒充「没花钱」。
   * 请求失败时也走这里传 undefined：它可能已经产生费用，只是我们不知道多少。
   *
   * 同时记到本次 Run 和整个 Session：预算看 Run，账单看 Session。
   */
  private recordUsage(usage: TokenUsage | undefined): void {
    for (const totals of [this.currentRun.usage, this.sessionUsage]) {
      if (usage === undefined) {
        totals.unknown++;
        totals.cacheUsageUnknown++;
        continue;
      }
      totals.reported++;
      totals.promptTokens += usage.prompt_tokens;
      totals.completionTokens += usage.completion_tokens;
      totals.totalTokens += usage.total_tokens;
      if (usage.cached_prompt_tokens === undefined) {
        totals.cacheUsageUnknown++;
      } else {
        totals.cacheUsageReported++;
        totals.cachedPromptTokens += usage.cached_prompt_tokens;
      }
    }
  }

  /**
   * 预算用尽就停手：不再发请求，也不执行「没有下一次请求去验证」的工具。
   *
   * 只看**本次 Run** 的合计：TUI 里的第二轮不该被第一轮的花费挤掉工具额度。
   * 只在已知合计达到上限时触发；usage 缺失时这条闸门拦不住那部分消耗，
   * 所以错误文案和 stats 都只说「已统计到多少」，不说「实际花了多少」。
   */
  private stopIfBudgetExhausted(pending: readonly ToolCall[] = []): void {
    if (!this.budgetExhausted()) return;
    const budget = this.maxTotalTokens;

    this.skipCalls(pending, `token budget ${budget} reached`);
    const lowerBound = this.currentRun.usage.unknown > 0 ? "at least " : "";
    const unknownNote =
      this.currentRun.usage.unknown > 0
        ? `; ${this.currentRun.usage.unknown} request(s) have no usage (failed or unreported), so the real total is higher`
        : "";
    throw new Error(
      `token budget ${budget} reached: ${lowerBound}${this.currentRun.usage.totalTokens} tokens counted over ` +
        `${this.currentRun.usage.reported} request(s) with usage${unknownNote}`,
    );
  }

  /**
   * 核心成员 transcript（对话上下文）：当前保留、将随下一次请求发给模型的消息。
   *
   * 旧内容可能已按预算压缩；它不是完整审计档案。返回深拷贝：数组复制挡不住 `snapshot[0].content = "..."`，
   * 「只读」才是真的只读，而不是只挡住了 push/splice。
   */
  get transcript(): readonly Message[] {
    return structuredClone(this.context.transcript);
  }

  /**
   * 核心方法 run（跑一次任务）：跑完一次 Run，返回模型的最终回复（一条不带工具调用的消息）。
   *
   * 这就是 **agent loop**：教科书里那个 `while (true)` —— 问模型、执行它要的工具、
   * 把结果塞回去，直到它不再要工具。这里用带计数器的 for 代替 while (true)，
   * 并加了三道闸门：模型请求次数、工具执行次数、取消信号。
   *
   * 一个 Agent 可以连续跑多个 Run（TUI 就是这样一个循环），Transcript 跨 Run 累积，但旧内容可能按预算压缩；
   * 但同一时刻只允许一个 Run —— 两个循环同时往一条 transcript 里写，顺序无法解释。
   *
   * 失败时抛错而不是返回半成品：让调用方明确知道「任务没跑完」，
   * 错误文案里带「已经执行了多少」，此时 transcript 保留当前上下文，较旧内容可能已被压缩。
   *
   * 最后的请求预算留给「收尾」：到第 maxSteps 次请求时，模型只能给最终答复；
   * 它若还想要工具，那些工具不执行 —— 执行了也没有下一次请求去验证结果，
   * 等于制造一批「跑过但没人看过」的副作用。
   */
  async run(task: string): Promise<Message> {
    if (this.running) {
      throw new Error("agent.run() is already running: await the current Run before starting another");
    }
    this.running = true;
    this.currentRun = new RunState();
    this.context.beginRun();
    this.runCount++;
    try {
      // 压缩不在 Run 的开始和结束各做一遍：统一放在每次真实请求前（见 SessionContext.prepareRequest）。
      return await this.runLoop(task);
    } finally {
      this.running = false;
    }
  }

  /** 业务和辅助请求共用记账出口，失败响应携带的 usage 也只登记一次。 */
  private async chatAndRecord(
    messages: readonly Message[], tools: readonly ToolDefinition[], options: ChatOptions,
  ): Promise<ChatResponse> {
    let response: ChatResponse;
    try {
      response = await this.llm.chat(messages, tools, options);
    } catch (error) {
      this.recordUsage(error instanceof ChatResponseError ? error.usage : undefined);
      throw error;
    }
    this.recordUsage(response.usage);
    return response;
  }

  /** 发起一个 Step，处理请求准入、计费与恢复，返回已确认的模型消息。 */
  private async requestStep(step: number): Promise<Message> {
    const tools = this.toolsForStep(step);
    this.stopIfCancelled();
    this.stopIfBudgetExhausted();
    // 请求准入：先测量，再裁剪，必要时总结，验证后才替换。不花模型钱的步骤先做。
    let sentChars = await this.context.prepareRequest(tools);
    let response: ChatResponse;
    // 上下文超限恢复只给一次机会：同一个 Step 内不许反复压、反复试。
    let overflowRetryAt: number | undefined;
    let networkRetries = 0;
    // 重试不构成新的 Agent Step，也不会重放工具；每个真实请求都各自计数、记账。
    // 仅 fetch 阶段的网络错误或 HTTP 408/429/5xx 可重试；流式增量错误禁止重放。
    for (let attempt = 0; ; attempt++) {
      this.stopIfCancelled();
      this.stopIfBudgetExhausted();
      if (attempt === 0) {
        this.notifyObserver(this.onRequestStart, step);
        this.stopIfCancelled();
      }
      // 进入真实的下一次 HTTP 调用才记为 retry；等待期间取消不能预支计数。
      if (attempt > 0) this.currentRun.retries++;
      if (attempt === overflowRetryAt) this.currentRun.overflowRetries++;
      this.currentRun.requests++;
      this.sessionRequests++;
      try {
        response = await this.chatAndRecord(this.context.transcript, tools, {
          onDelta: this.onDelta === undefined ? undefined : (text) => this.notifyObserver(this.onDelta, text),
        });
        break;
      } catch (error) {
        this.stopIfCancelled();
        // 只有上游明确说「输入装不下窗口」才走压缩恢复；普通 400、网络故障、
        // 输出被截断都不能靠压缩救，混进来只会白花一次请求。
        if (overflowRetryAt === undefined && isContextOverflowError(error)) {
          sentChars = await this.context.recoverFromOverflow(tools, sentChars, error);
          overflowRetryAt = attempt + 1;
          continue;
        }
        if (networkRetries >= this.maxModelRetries || !isRetryableModelError(error)) throw error;
        networkRetries++;
        this.notifyObserver(this.onRetry, error, networkRetries, this.maxModelRetries);
        // Ctrl-C 必须能中断退避，不再发新的模型请求。
        // 退避期间取消时 sleep 抛的是裸 AbortError（"The operation was aborted"），
        // signal 上的原因会丢；先过取消出口，CLI 才说得出是被什么停掉的。
        try {
          await sleep(Math.min(100 * 2 ** (networkRetries - 1), 800), undefined, { signal: this.signal });
        } catch (error) {
          this.stopIfCancelled();
          throw error;
        }
      }
    }

    this.context.consumed(sentChars, response.usage?.prompt_tokens);
    this.stopIfCancelled();
    return response.message;
  }

  /** 接受一整批调用或为整批补齐跳过原因，按顺序提交已执行的结果。 */
  private async executeToolBatch(message: Message, calls: readonly ToolCall[], step: number): Promise<void> {
    // 进程树清理未确认是 Session 级安全故障：后续请求不再暴露工具，
    // 即使模型仍返回工具调用，也只补 not-run 结果，绝不再启动副作用。
    if (this.processCleanupUnverified) {
      this.skipCalls(calls, "process tree cleanup unverified; tool execution remains disabled for this Agent session");
      return;
    }

    // 这一轮可能刚好把预算用光：后面的工具没有下一次请求去验证，不能执行。
    this.stopIfBudgetExhausted(calls);

    // 最后一次请求只留给最终答复：要工具也不再执行 —— 没有下一次请求能验证它的结果。
    //    未执行的调用仍补一条 not run 结果，保证 assistant / tool 配对完整。
    if (step === this.maxSteps) {
      this.skipCalls(calls, "no model request left to verify the result");
      throw new Error(
        `step limit ${this.maxSteps} reached after executing ${this.currentRun.toolCalls} tool call(s); ` +
          `the final model response asked for ${calls.length} more, which were not run`,
      );
    }

    // 整批先算预算：执行到一半才发现超限，会留下一批「跑了但没回报」的调用。
    if (this.currentRun.toolCalls + calls.length > this.maxToolCalls) {
      this.skipCalls(calls, `tool call budget ${this.maxToolCalls} would be exceeded`);
      throw new Error(
        `tool call budget ${this.maxToolCalls} exceeded: ${this.currentRun.toolCalls} already executed in this Run, ` +
          `this batch asks for ${calls.length}; none of them were run`,
      );
    }

    // 预算和最后一步的失败原因优先；稳定结果重复才算无进展。
    // 整批都是「有效等待」（真的等过、没有新输出、任务仍在运行）时，重复调用是等待中的有效动作，
    // 让它继续到状态变化或 maxSteps 兜底，避免第四次读取恰好早于任务完成。
    // 判定用的是工具给出的结构化状态，不是结果文本 —— 文本里出现同样的字样不能换来豁免。
    const batchSignature = toolBatchSignature(calls);
    if (this.currentRun.shouldStopToolBatch(batchSignature)) {
      this.skipCalls(calls, "repeated identical tool batch made no progress");
      throw new Error(
        `agent loop stopped after ${MAX_IDENTICAL_TOOL_BATCHES} identical tool batches; ` +
          "the model made no progress",
      );
    }

    // 有工具调用就逐个执行，并把结果写回对话记录。
    //    这里刻意串行：简单，且消息顺序与模型给出的顺序一一对应。
    //    （并发执行能更快，但结果回灌顺序会乱，属于优化，不属于内核。）
    const batchResults: ToolExecutionResult[] = [];
    for (let index = 0; index < calls.length; index++) {
      // 取消可能正好发生在两次调用之间：剩下的调用不再启动，但每条都要留下结果。
      this.stopIfCancelled(calls, index);
      const call = calls[index];
      // 「要跑了」先于「跑完了」：TUI 靠这个回调把工具调用写进运行记录，
      // 长命令执行期间也看得见它在干什么。这里没有 await，不会给取消留出新的缝隙。
      // 观察者只收到副本：改动工具名、JSON 参数或 id 都不能改变真实调用和消息配对。
      if (this.onToolCall !== undefined) {
        this.notifyObserver(this.onToolCall, structuredClone(call), message.content);
      }
      // 同步回调若触发取消，也不能在同一个事件循环内继续启动工具。
      this.stopIfCancelled(calls, index);
      let outcome: ToolExecutionResult;
      try {
        outcome = await this.tools.executeWithStatus(call);
      } catch (error) {
        if (!(error instanceof ProcessCleanupError)) throw error;
        this.processCleanupUnverified = true;
        outcome = { content: `ERROR: ${error.message}`, isError: true };
      }

      this.currentRun.toolCalls++;
      this.sessionToolCalls++;
      const result = createToolResult(call, outcome.content);
      this.context.append(result);
      if (this.onToolResult !== undefined) {
        this.notifyObserver(this.onToolResult, structuredClone(call), outcome.content, outcome.isError);
      }
      if (this.processCleanupUnverified) {
        this.skipCalls(calls.slice(index + 1), "process tree cleanup unverified");
        return;
      }
      batchResults.push(outcome);
    }
    // 只有整批都是有效等待才豁免：任何一个工具是普通结果（包括 wait: 0 的立即读取、
    // 拿到新输出、任务已结束），这一批就按普通结果参与无进展判定。
    const allWaiting = batchResults.length > 0 &&
      batchResults.every(result => !result.isError && result.isWaiting === true);
    this.currentRun.recordToolBatch(batchSignature, batchResults, allWaiting);
  }

  private async runLoop(task: string): Promise<Message> {
    // 取消发生在任务开始之前：用户已经按了 Ctrl-C，就不该再花一次模型请求。
    this.stopIfCancelled();

    // 用户消息先入栈；之后每次请求模型，都带着当前保留的上下文（旧内容可能已按预算压缩）。
    this.context.append({ role: "user", content: task });

    for (let step = 1; step <= this.maxSteps; step++) {
      const message = await this.requestStep(step);
      this.stopIfCancelled();
      this.context.append(message);
      // 压缩会改 transcript 的下标，所以本轮回复另存一份：界面靠它认「这一轮到底回了什么」。
      this.currentRun.replies.push(structuredClone(message));

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        // 没有工具调用 = 模型认为可以交卷了，本轮结束。
        //    但「交卷」得真有东西：空回复不是成功，是模型没说话 ——
        //    内容被过滤、生成被截断、服务端半截响应，都会走到这一条。
        if ((message.content ?? "").trim() === "") {
          throw new Error("model returned an empty final answer");
        }
        return structuredClone(message);
      }

      await this.executeToolBatch(message, calls, step);
    }

    // 进程清理未确认且模型一直索要工具时，每一步都只补跳过结果，耗尽步数后在这里收尾。
    // 中文对照：已达到步数上限 {n} 步，已执行 {m} 次工具调用。
    throw new Error(
      `step limit ${this.maxSteps} reached after executing ${this.currentRun.toolCalls} tool call(s)`,
    );
  }
}

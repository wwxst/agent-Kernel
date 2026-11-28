#!/usr/bin/env node
/**
 * 文件目的：给上下文压缩这一层加一条面向真实模型的专项评测 —— 业务回合全部由脚本回放，
 * 只有摘要请求花钱，因此可以用极少的付费 token 验证「真实模型写出的摘要能不能走完压缩链」。
 *
 * 为什么单独一个文件：`eval/scenarios/run.mjs` 的离线场景用假摘要，证明不了真实摘要在
 * `validateSummary()` 下能不能提交；v6 任务集的窗口又通常不触发压缩。这里把两件事拆开：
 * 业务对话和工具结果由脚本决定（没有模型方差），只有摘要请求发给真实 `Llm`。
 *
 * 文件职责：负责构造脚本化 ChatClient、把摘要请求转发给真实 `Llm`、用确定性合成回复
 * 注入超长摘要故障、运行四个场景并断言 Agent 的外部行为、累计付费 token 并在超预算时中止。
 * 不负责修改内核压缩逻辑（在 `src/core/session-context.ts`），不负责替代离线场景
 * （`eval/scenarios/run.mjs`）和 v6 任务集（`eval/run.mjs`）。
 *
 * 内容目录：
 *   - 常量区：两套窗口/输出预留（大窗口与 v5 场景）、步数上限、业务内容长度、默认预算。
 *   - `CompactionChat`：脚本化业务回复 + 真实/合成摘要；识别摘要提示词、注入故障、分别记账。
 *   - `BudgetTracker` / `BudgetExceededError`：付费 token 累计与超预算中止。
 *   - `createRecordTool()` / `businessMessage()` / `recordResult()`：固定大小的业务回合。
 *   - `syntheticOverLimitSummary()`：形状合法、固定 1.5 倍硬上限的合成摘要。
 *   - 断言辅助：摘要计数（总请求/真实尝试/真实回复/合成回复）、Transcript 形状、工具配对。
 *   - `runSingleCompaction()` / `runConsecutiveCompactions()` / `runSummaryRetry()` /
 *     `runPersistentOverLimit()`：四个场景。
 *   - `main()`：CLI 入口、逐场景输出、预算与最终统计、`--help`、`--only`。
 *
 * 模块关系：依赖 `src/core/agent.ts`、`src/core/context-compact.ts`、`src/core/tool-registry.ts`
 * 与 `src/model/llm.ts`；由 `package.json` 的 `eval:compaction` 脚本启动。
 */
import { Agent } from "../src/core/agent.ts";
import {
  SUMMARY_SECTIONS,
  SUMMARY_SYSTEM_PROMPT,
  requestChars,
  validateSummary,
} from "../src/core/context-compact.ts";
import { ToolRegistry } from "../src/core/tool-registry.ts";
import { ChatResponseError } from "../src/protocol/errors.ts";
import { Llm } from "../src/model/llm.ts";
import { isDeepStrictEqual } from "node:util";

/** 默认的付费 token 上限；可用 `EVAL_BUDGET_TOKENS` 覆盖。 */
const DEFAULT_BUDGET_TOKENS = 200_000;

/**
 * 单次/连续压缩用大窗口：真实摘要需要足够的输出 token 容量，才不会被 hy3 的 reasoning 吃掉。
 *
 * 大窗口只增加脚本业务回合数（不花钱）；摘要请求的输入/输出仍然受压缩预算约束。
 * maxSteps 放宽到 100，是为了给「60 回合还不够时提到 80 回合」留出收尾请求。
 */
const BIG_WINDOW = {
  label: "32768/2048",
  contextWindowTokens: 32_768,
  outputTokenReserve: 2_048,
  maxSteps: 100,
  maxToolCalls: 160,
};

/** 超长纠正与持续超长对齐 v5 的真实场景（8192 / 1024）。 */
const V5_WINDOW = {
  label: "8192/1024",
  contextWindowTokens: 8_192,
  outputTokenReserve: 1_024,
  maxSteps: 80,
  maxToolCalls: 120,
};

/** 业务脚本的兜底上限：压缩一直不发生时也要收尾，让断言给出明确失败而不是跑飞。 */
const MAX_BUSINESS_TURNS = 60;

/** 工具结果长度要求 1,200–2,000 字符；固定 1,800 让触发线可预测。 */
const BUSINESS_TOOL_RESULT_CHARS = 1_800;

/**
 * 业务 assistant 正文长度。
 *
 * 为什么不能只靠工具结果撑体积：`prepareRequest()` 会先做确定性的工具结果 Snip（1,800 → 800 → 240），
 * 光有结果时压缩可能被 Snip 一直挡住。正文不参与 Snip，能确保最终必须走摘要压缩。
 */
const BUSINESS_NOTE_CHARS = 1_800;

/**
 * 业务请求的假 usage 密度。
 *
 * 4 字符/token 与英文和 JSON 的常见比例相符；固定这个密度后，Agent 的窗口估算稳定，
 * 触发线不会因为假 usage 的波动而漂移。它只影响估算，不进入付费账。
 */
const BUSINESS_CHARS_PER_TOKEN = 4;

/**
 * 合成超长摘要的倍数：形状合法，但长度是本次压缩硬上限的 1.5 倍。
 *
 * 第一次纠正请求会按观测比例把目标收紧（约 0.63 倍硬上限）；合成回复仍然按硬上限的
 * 1.5 倍生成，所以一次压缩尝试必定停在「首发 + 纠正」两次请求，不会无限重试。
 */
const SYNTHETIC_SUMMARY_FACTOR = 1.5;

/**
 * 场景 4 的 Run 1 长回复长度。
 *
 * 它需要在没有工具结果的情况下把失败 Run 的第一条请求推过触发线，同时让失败 Run 走完
 * 一次工具回合后仍低于硬上限（否则会触发「未消费结果」的最后手段 Snip，改写 system 清单）。
 * 已知边界：这个数字与 8192/1024、1,800 字业务正文绑定；窗口或正文长度变化时要重新算。
 */
const PERSISTENT_RUN1_FINAL_CHARS = 22_500;

/** 业务请求的固定短系统提示：把窗口预算留给历史，避免默认提示本身占掉大半窗口。 */
const EVAL_SYSTEM_PROMPT =
  "You are the compaction evaluation agent. Keep the user's task in mind and record one decision per step.";

/** 摘要提示词的稳定开头；用它识别「这次请求不是业务回合」。 */
const SUMMARY_PROMPT_MARKER = "detailed summary of the conversation so far";
const SUMMARY_PROMPT_OPENING = SUMMARY_SYSTEM_PROMPT.split("\n")[0] ?? SUMMARY_PROMPT_MARKER;

/** 摘要系统提示里写着本次允许的长度上限。 */
const SUMMARY_LIMIT_PATTERN = /under (\d+) characters/;

const numberFormat = new Intl.NumberFormat("en-US");

/** 一条被付费调用消耗掉的用量账本；`unknown` 表示端点没报 usage，绝不补 0。 */
function emptyUsage() {
  return { requests: 0, prompt: 0, completion: 0, total: 0, unknown: 0 };
}

/** 把一次真实摘要响应的 usage 记进账本。 */
function addUsage(ledger, usage) {
  ledger.requests++;
  if (usage === undefined) {
    ledger.unknown++;
    return;
  }
  ledger.prompt += usage.prompt_tokens;
  ledger.completion += usage.completion_tokens;
  ledger.total += usage.total_tokens;
}

function describeError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** 真实摘要请求是否因端点输出上限被截断；这是「能靠更短目标恢复」的一类失败。 */
function isTruncatedSummaryError(error) {
  return error instanceof ChatResponseError && /finish_reason "length"/.test(error.message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formatNumber(value) {
  return numberFormat.format(value);
}

/** 超预算是一个单独的错误类型，主循环据此停止剩余场景。 */
class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** 整个运行共享的付费额度；只有摘要请求记账。 */
class BudgetTracker {
  constructor(cap) {
    this.cap = cap;
    this.usage = emptyUsage();
    this.exceeded = false;
  }

  add(usage) {
    addUsage(this.usage, usage);
    if (this.usage.total > this.cap) this.exceeded = true;
    return this.exceeded;
  }
}

/** 业务回合的固定工具：返回一段长度固定的记录文本，不碰文件、不调模型。 */
function createRecordTool() {
  return {
    name: "record",
    description: "Record one decision step and return a fixed-size log line.",
    parameters: {
      type: "object",
      properties: {
        value: { type: "string", description: "The decision step number." },
      },
      required: ["value"],
    },
    run: async (args) => recordResult(String(args.value ?? "")),
  };
}

function recordResult(value) {
  const header = `recorded decision ${value}: keep the migration archive path stable. `;
  const filler = "The compaction eval keeps this line so the summary can preserve the exact decision. ";
  let text = header;
  while (text.length < BUSINESS_TOOL_RESULT_CHARS) text += filler;
  return text.slice(0, BUSINESS_TOOL_RESULT_CHARS);
}

/** 业务 assistant 正文：不参与 Snip，用来保证上下文最终一定压到摘要路径。 */
function businessNote(turn) {
  const header = `Step ${turn}. `;
  const note = "Decision: preserve the original task, keep the archive path stable, and explain this step. ";
  let text = header;
  while (text.length < BUSINESS_NOTE_CHARS) text += note;
  return text.slice(0, BUSINESS_NOTE_CHARS);
}

/** 一次业务回合：一条 assistant 消息 + 一个 `record` 调用；结果由 registry 执行脚本工具产生。 */
function businessMessage(turn) {
  return {
    role: "assistant",
    content: businessNote(turn),
    tool_calls: [{
      id: `call-${turn}`,
      type: "function",
      function: { name: "record", arguments: JSON.stringify({ value: String(turn) }) },
    }],
  };
}

/**
 * 业务响应的假 usage：按序列化后的真实请求体积折算，保持校准锚点稳定。
 * 这些 token 不花钱，但 Agent 会拿它们更新窗口估算。
 */
function businessUsage(messages, tools, message) {
  // 必须用与 SessionContext 相同的口径（含工具定义的 OpenAI 包装）折算，否则校准锚点
  // 会把字符/token 比例估高，压缩触发线被推迟，场景回合数也跟着漂移。
  const prompt_tokens = Math.max(1, Math.ceil(requestChars(messages, tools) / BUSINESS_CHARS_PER_TOKEN));
  const completion_tokens = Math.max(1, Math.ceil(JSON.stringify(message).length / BUSINESS_CHARS_PER_TOKEN));
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function isSummaryRequest(messages) {
  const first = messages[0];
  if (first?.role !== "system" || typeof first.content !== "string") return false;
  return first.content.startsWith(SUMMARY_PROMPT_OPENING) || first.content.includes(SUMMARY_PROMPT_MARKER);
}

function statedSummaryLimit(messages) {
  const content = messages[0]?.content;
  if (typeof content !== "string") return undefined;
  const match = SUMMARY_LIMIT_PATTERN.exec(content);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 合成一份形状合法、长度固定为 `hardLimit × 1.5` 的摘要。
 *
 * 九节标题顺序与 `validateSummary()` 的要求一致，超长部分补在最后一节正文里，
 * 所以它被拒绝的唯一原因是「太长」，不是结构错误。补在末尾而不是塞进标题，
 * 是为了让场景能证明内核确实走了纠正重试，而不是碰巧被结构校验拦下。
 */
function syntheticOverLimitSummary(hardLimit) {
  const base = SUMMARY_SECTIONS
    .map((section) => `## ${section}\n` + "x".repeat(24))
    .join("\n");
  const target = Math.ceil(hardLimit * SYNTHETIC_SUMMARY_FACTOR);
  return base.length >= target ? base : base.padEnd(target, "x");
}

/**
 * 脚本化业务客户端 + 真实摘要客户端。
 *
 * 只有系统提示以摘要提示词开头的请求才会转发给 `real`；其余请求一律用 `plan` 回放。
 * 这样付费面只有摘要，业务侧没有模型方差。摘要请求按「距离上一次业务请求」分组：
 * 同一组是同一个压缩尝试里的首发与纠正重试，共用同一个硬上限。
 */
class CompactionChat {
  constructor(options) {
    this.real = options.real;
    this.budget = options.budget;
    this.controller = options.controller;
    this.plan = options.plan;
    this.synthesizeSummary = options.synthesizeSummary;
    this.maxTurns = options.maxTurns ?? MAX_BUSINESS_TURNS;

    this.usage = emptyUsage();
    this.problems = [];
    // 每一次摘要请求都留一条记录：合成的、真实成功的、真实失败的都在里面。
    // 这样失败时能解释「第几次请求、硬上限多少、收到多少字符」。
    this.summaryLog = [];
    // 内核在发送前就计数的摘要请求总数；它等于真实尝试数 + 合成回复数。
    this.summaryAttempts = 0;
    // 真实请求尝试数（含被端点截断/报错的那次）与成功拿到回复的次数，分开记账。
    this.realAttempts = 0;
    this.realReplies = 0;
    this.syntheticReplies = 0;
    this.businessRequests = 0;
    this.businessTurnsThisPlan = 0;
    this.summarySinceBusiness = 0;
    this.compactionHardLimit = undefined;
  }

  /** 同一个 Agent 跨 Run 复用时，换剧本并重置本 Run 的回合计数。 */
  setPlan(plan) {
    this.plan = plan;
    this.businessTurnsThisPlan = 0;
  }

  /** 内核在发送前计数的摘要请求总数；与 Run/Session/压缩诊断三处对齐。 */
  get summaryRequests() {
    return this.summaryAttempts;
  }

  async chat(messages, tools, options) {
    if (isSummaryRequest(messages)) return this.summary(messages, tools, options);
    return this.business(messages, tools);
  }

  business(messages, tools) {
    this.businessRequests++;
    // 新的业务请求意味着下一次摘要属于新的压缩尝试。
    this.summarySinceBusiness = 0;
    this.compactionHardLimit = undefined;

    const final = !this.continueBusiness();
    if (!final) this.businessTurnsThisPlan++;
    const message = final
      ? { role: "assistant", content: this.plan.finalContent }
      : businessMessage(this.businessRequests);
    return { message, usage: businessUsage(messages, tools, message) };
  }

  /** 是否继续回放工具回合。到目标就交卷；到兜底上限也交卷，并留下诊断。 */
  continueBusiness() {
    if (this.businessTurnsThisPlan >= this.maxTurns) {
      this.problems.push(`business turn cap ${this.maxTurns} reached before the scenario target`);
      return false;
    }
    if (this.plan.stopAfterTurns !== undefined) {
      return this.businessTurnsThisPlan < this.plan.stopAfterTurns;
    }
    if (this.plan.finishWhen?.() === true) return false;
    return true;
  }

  async summary(messages, tools, options) {
    this.summaryAttempts++;
    this.summarySinceBusiness++;
    const statedLimit = statedSummaryLimit(messages);
    if (statedLimit === undefined) this.problems.push("summary request does not state a character limit");
    if (this.summarySinceBusiness === 1) this.compactionHardLimit = statedLimit;
    const hardLimit = this.compactionHardLimit ?? statedLimit;
    const context = {
      hardLimit,
      statedLimit,
      sequenceInCompaction: this.summarySinceBusiness,
      ordinal: this.summaryAttempts,
    };

    // 确定性故障注入：返回字符串就不再调用真实模型。合成回复不计费、不产生 usage；
    // 它仍然是一次内核可见的摘要请求，所以 requestSummary() 会计数。
    const synthesized = this.synthesizeSummary?.(context);
    if (synthesized !== undefined) {
      this.syntheticReplies++;
      const text = synthesized.trim();
      const zeroUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      this.summaryLog.push({
        ordinal: context.ordinal,
        sequenceInCompaction: context.sequenceInCompaction,
        statedLimit,
        hardLimit,
        synthetic: true,
        failed: false,
        originalChars: 0,
        finalChars: text.length,
        usage: zeroUsage,
        content: text,
        error: "",
      });
      return { message: { role: "assistant", content: text }, usage: zeroUsage };
    }

    this.realAttempts++;
    let response;
    try {
      response = await this.real.chat(messages, tools, options);
    } catch (error) {
      // 响应不合法时 Llm 会把已经产生的 usage 带在错误里；这笔钱不能漏记。
      const usage = error instanceof ChatResponseError ? error.usage : undefined;
      this.recordUsage(usage);
      this.summaryLog.push({
        ordinal: context.ordinal,
        sequenceInCompaction: context.sequenceInCompaction,
        statedLimit,
        hardLimit,
        synthetic: false,
        failed: true,
        truncated: isTruncatedSummaryError(error),
        originalChars: 0,
        finalChars: 0,
        usage,
        content: "",
        error: describeError(error),
      });
      this.problems.push(`summary request failed: ${describeError(error)}`);
      if (this.budget.exceeded) this.abortForBudget();
      throw error;
    }

    this.realReplies++;
    this.recordUsage(response.usage);
    const content = response.message.content ?? "";
    this.summaryLog.push({
      ordinal: context.ordinal,
      sequenceInCompaction: context.sequenceInCompaction,
      statedLimit,
      hardLimit,
      synthetic: false,
      failed: false,
      originalChars: content.trim().length,
      finalChars: content.trim().length,
      usage: response.usage,
      content: content.trim(),
      error: "",
    });

    if (this.budget.exceeded) this.abortForBudget();
    return { message: response.message, usage: response.usage };
  }

  recordUsage(usage) {
    addUsage(this.usage, usage);
    this.budget.add(usage);
  }

  /**
   * 超预算时中止本场景的 HTTP 请求，并把错误抛给 Agent。
   *
   * Agent 会把摘要请求的异常折成一次「摘要失败」而不是直接结束 Run，所以这里同时 abort
   * 取消信号：`SessionContext` 的取消检查点会重新抛出带有本条原因的取消错误，主循环
   * 才能停止剩余场景。
   */
  abortForBudget() {
    const error = new BudgetExceededError(
      `EVAL_BUDGET_TOKENS ${this.budget.cap} exceeded: ${this.budget.usage.total} paid token(s) counted ` +
        `across ${this.budget.usage.requests} summary request(s)`,
    );
    if (!this.controller.signal.aborted) this.controller.abort(error);
    throw error;
  }
}

function createAgent(driver, signal, window) {
  return new Agent({
    llm: driver,
    tools: new ToolRegistry([createRecordTool()]),
    systemPrompt: EVAL_SYSTEM_PROMPT,
    contextWindowTokens: window.contextWindowTokens,
    outputTokenReserve: window.outputTokenReserve,
    maxSteps: window.maxSteps,
    maxToolCalls: window.maxToolCalls,
    signal,
  });
}

function usageSnapshot(driver) {
  return { ...driver.usage };
}

/** 结果里统一带上：总请求、真实尝试/成功、合成回复、付费 usage。 */
function summaryCounts(driver) {
  return {
    summaryRequests: driver.summaryRequests,
    realSummaryAttempts: driver.realAttempts,
    realSummaryReplies: driver.realReplies,
    syntheticSummaryReplies: driver.syntheticReplies,
    usage: usageSnapshot(driver),
  };
}

/** 失败时的摘要请求摘要：次数、来源、硬上限、收到长度；用来解释「为什么没提交」。 */
function formatSummaryTrace(driver) {
  if (driver === undefined || driver.summaryLog.length === 0) return "";
  return driver.summaryLog.map((entry) => {
    const source = entry.synthetic ? "synthetic" : entry.failed ? "real FAILED" : "real";
    const result = entry.failed ? `error=${entry.error}` : `got=${entry.finalChars}`;
    return `#${entry.ordinal} ${source} limit=${entry.statedLimit ?? "?"} ` +
      `hard=${entry.hardLimit ?? "?"} ${result}`;
  }).join(", ");
}

/** 被截断的真实摘要请求：允许作为 transient warning 报告，而不是安全失败。 */
function summaryTruncationWarnings(driver) {
  if (driver === undefined) return [];
  return driver.summaryLog
    .filter((entry) => entry.failed && entry.truncated)
    .map((entry) => `summary #${entry.ordinal} truncated ` +
      `(limit ${entry.statedLimit ?? "?"}, hard ${entry.hardLimit ?? "?"})`);
}

/** 从 driver 的问题列表里去掉「截断」这一可恢复类别，剩下的才是真正的场景失败。 */
function summaryFatalProblems(driver) {
  if (driver === undefined) return [];
  const truncationTexts = new Set(
    driver.summaryLog
      .filter((entry) => entry.failed && entry.truncated)
      .map((entry) => `summary request failed: ${entry.error}`),
  );
  return driver.problems.filter((problem) => !truncationTexts.has(problem));
}

/**
 * 摘要计数必须都在内核账上，并且不能把「请求尝试」当成「成功回复」。
 *
 * 三个计数各管一件事：
 *   - `summaryRequests`：内核在发送前就计数的总请求数（真实尝试 + 合成回复）；
 *   - `realAttempts` / `realReplies`：真实 HTTP 请求数与真正拿到回复的次数；
 *   - `syntheticReplies`：完全不调用端点的确定性回复数。
 *
 * 内核计数等于总请求数，且必然不小于真实成功回复数（合成回复和失败尝试都只能让左边更大）。
 */
function assertSummaryAccounting(agent, driver) {
  assert(driver.summaryRequests === driver.realAttempts + driver.syntheticReplies,
    `driver summary requests ${driver.summaryRequests} != ` +
      `${driver.realAttempts} real attempt(s) + ${driver.syntheticReplies} synthetic reply/replies`);
  assert(driver.realAttempts >= driver.realReplies,
    `real attempts ${driver.realAttempts} cannot be fewer than real replies ${driver.realReplies}`);
  assert(agent.compactionStats.summaryRequests === driver.summaryRequests,
    `session compaction stats counted ${agent.compactionStats.summaryRequests} summary request(s), ` +
      `but the driver saw ${driver.summaryRequests}`);
  assert(agent.stats.summaryRequests === driver.summaryRequests,
    `run stats counted ${agent.stats.summaryRequests} summary request(s), ` +
      `but the driver saw ${driver.summaryRequests}`);
  assert(agent.sessionStats.summaryRequests === driver.summaryRequests,
    `sessionStats counted ${agent.sessionStats.summaryRequests} summary request(s), ` +
      `but the driver saw ${driver.summaryRequests}`);
  assert(agent.compactionStats.summaryRequests >= driver.realReplies,
    `kernel counted ${agent.compactionStats.summaryRequests} summary request(s), ` +
      `but only ${driver.realReplies} real reply/replies returned`);
}

/** 每条 assistant 的 tool_call 必须紧跟同 id 的 tool 结果，且不能出现孤立结果。 */
function assertCompleteToolPairs(messages) {
  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    assert(message.role !== "tool", `orphan tool result at transcript index ${index}`);
    if (message.role !== "assistant" || message.tool_calls === undefined || message.tool_calls.length === 0) {
      continue;
    }
    const ids = new Set();
    for (const call of message.tool_calls) {
      assert(!ids.has(call.id), `duplicate tool call id ${call.id}`);
      ids.add(call.id);
      const result = messages[index + 1];
      assert(result?.role === "tool" && result.tool_call_id === call.id,
        `tool call ${call.id} is not paired with its tool result`);
      index++;
    }
  }
}

/** 压缩链的共同验收：system 仍在首位、当前任务还在、配对完整、最后一条 assistant 回复是本次收尾。 */
function assertTranscriptShape(agent, task, finalContent, reply, options = {}) {
  assert(reply?.content === finalContent,
    `unexpected final reply: ${JSON.stringify(reply?.content)}`);
  const transcript = agent.transcript;
  assert(transcript[0]?.role === "system", "the system message must stay first");
  assert(transcript.some((message) => message.role === "user" && message.content === task),
    "the current task user message is missing");
  assertCompleteToolPairs(transcript);
  const last = transcript[transcript.length - 1];
  assert(last?.role === "assistant" && last.content === finalContent,
    "the last assistant reply was not preserved as the final transcript message");

  const memoryCount = transcript.filter((message) =>
    message.role === "user" && /Untrusted conversation memory/.test(String(message.content ?? ""))).length;
  if (options.expectSummary === true) {
    assert(memoryCount === 1, `expected exactly one committed summary message, found ${memoryCount}`);
  }
  if (options.expectSummary === false) {
    assert(memoryCount === 0, "no summary message should be committed");
  }
}

/**
 * 摘要失败后的历史保留检查：失败 Run 开始前的整段 Transcript 必须逐字节不变。
 *
 * 这条只在 synthetic 摘要场景使用：回复完全由脚本生成，没有模型方差；场景也刻意让
 * 「失败 Run 开始前的历史」里没有工具结果，避免确定性 Snip 合法地改写 tool 正文。
 * 因此这里可以直接比较完整前缀，而不是只比较 message 身份。
 */
function assertHistoryPrefixUnchanged(before, after, label) {
  const prefix = after.slice(0, before.length);
  if (isDeepStrictEqual(prefix, before)) return;
  for (let index = 0; index < before.length; index++) {
    if (isDeepStrictEqual(prefix[index], before[index])) continue;
    throw new Error(
      `${label}: transcript message ${index} (${before[index]?.role ?? "?"}) changed; ` +
        `before=${JSON.stringify(before[index]).slice(0, 240)} ` +
        `after=${JSON.stringify(prefix[index]).slice(0, 240)}`,
    );
  }
  throw new Error(`${label}: the transcript before the failure run must stay byte-for-byte identical`);
}

/**
 * 场景 1：一次压缩提交，system / 任务 / 配对 / 最后回复都必须成立。
 *
 * 允许有界的 transient 截断：hy3 的 reasoning 可能撞上输出上限，这是容量问题；
 * 只要之后恢复并提交、失败配额回到 0，就记 warning 而不是安全失败。非截断错误仍 FAIL。
 */
async function runSingleCompaction(environment, ctx) {
  const controller = new AbortController();
  const state = { agent: undefined };
  const finalContent = "FINAL[single-compaction]: one compaction preserved the current task.";
  const driver = new CompactionChat({
    real: environment.realLlm,
    budget: environment.budget,
    controller,
    plan: {
      finishWhen: () => state.agent.compactionStats.compactions >= 1,
      finalContent,
    },
  });
  ctx.driver = driver;
  ctx.window = BIG_WINDOW.label;
  const agent = createAgent(driver, controller.signal, BIG_WINDOW);
  state.agent = agent;
  ctx.agent = agent;

  const task = "single-compaction: keep this exact task while old steps are folded.";
  const reply = await agent.run(task);
  const stats = agent.compactionStats;
  // 截断是 transient：只要随后恢复并提交，就只记 warning；其他请求失败仍算场景失败。
  const warnings = summaryTruncationWarnings(driver);
  const fatalProblems = summaryFatalProblems(driver);

  assert(stats.compactions >= 1, `expected at least one committed compaction, got ${stats.compactions}`);
  assert(driver.summaryRequests >= 1, `expected at least one summary request, got ${driver.summaryRequests}`);
  assert(driver.realAttempts >= 1, `expected at least one real summary attempt, got ${driver.realAttempts}`);
  assert(driver.realReplies >= 1, `expected at least one real summary reply, got ${driver.realReplies}`);
  // `compactionStats.summaryFailures` 是 Session 累计值，而不是本次 Run 的失败配额：一次
  // transient 截断即使后来提交，这个累计数也不会回到 0。干净的 Run 仍然要求它为 0；
  // 有 warning 时用「提交后 lastError 被清空」证明 Run 失败配额已重置（内核在提交时同时
  // 清 runSummaryFailures 和 lastCompactionError，后者是唯一公开可观测的那一半）。
  if (warnings.length === 0) {
    assert(stats.summaryFailures === 0,
      `expected a clean Run to have no summary failures, got ${stats.summaryFailures}`);
  } else {
    assert(stats.lastError === "",
      `transient truncation must be followed by a successful commit, but lastError is: ${stats.lastError}`);
  }
  assert(driver.realAttempts <= 4,
    `transient truncation must stay bounded at 4 real attempts, got ${driver.realAttempts}`);
  assert(driver.summaryLog.length === 0 || driver.summaryLog[driver.summaryLog.length - 1].failed !== true,
    "the Run must not finish on a failed summary attempt; a later attempt must recover and commit");
  assertSummaryAccounting(agent, driver);
  assertTranscriptShape(agent, task, finalContent, reply, { expectSummary: true });
  assert(fatalProblems.length === 0, fatalProblems.join("; "));

  const recovered = warnings.length === 0
    ? ""
    : `; recovered after ${warnings.length} transient truncation(s)`;
  return {
    window: BIG_WINDOW.label,
    ...summaryCounts(driver),
    warnings,
    compactions: stats.compactions,
    detail: `${stats.compactions} compaction(s) after ${driver.businessRequests} business turn(s)${recovered}`,
  };
}

/** 场景 2：同一个 Run 里连续两次提交压缩，第二次之后任务目标仍在。 */
async function runConsecutiveCompactions(environment, ctx) {
  const controller = new AbortController();
  const state = { agent: undefined };
  const finalContent = "FINAL[consecutive-compactions]: both compactions kept the original goal.";
  const driver = new CompactionChat({
    real: environment.realLlm,
    budget: environment.budget,
    controller,
    plan: {
      finishWhen: () => state.agent.compactionStats.compactions >= 2,
      finalContent,
    },
  });
  ctx.driver = driver;
  ctx.window = BIG_WINDOW.label;
  const agent = createAgent(driver, controller.signal, BIG_WINDOW);
  state.agent = agent;
  ctx.agent = agent;

  const task = "consecutive-compactions: keep this exact goal across two compactions.";
  const reply = await agent.run(task);
  const stats = agent.compactionStats;

  assert(stats.compactions >= 2, `expected at least two committed compactions in one Run, got ${stats.compactions}`);
  assert(driver.realAttempts >= 2, `expected at least two real summary attempts, got ${driver.realAttempts}`);
  assert(driver.realReplies >= 2, `expected at least two real summary replies, got ${driver.realReplies}`);
  assertSummaryAccounting(agent, driver);
  assertTranscriptShape(agent, task, finalContent, reply, { expectSummary: true });
  assert(driver.problems.length === 0, driver.problems.join("; "));

  return {
    window: BIG_WINDOW.label,
    ...summaryCounts(driver),
    compactions: stats.compactions,
    detail: `${stats.compactions} compactions in one Run, ${driver.businessRequests} business turn(s)`,
  };
}

/**
 * 场景 3（v5）：第一次摘要**不调用真实模型**，直接合成一份形状合法、1.5 倍硬上限的回复。
 *
 * 这样纠正路径完全确定：内核必须拒绝首发、按观测比例收紧目标、再发一次真实请求；
 * 第二次请求才使用真实模型。若真实重试被截断或超过硬上限，场景失败并带上请求层原因。
 */
async function runSummaryRetry(environment, ctx) {
  const controller = new AbortController();
  const state = { agent: undefined };
  const finalContent = "FINAL[summary-retry]: the corrective retry committed the summary.";
  const driver = new CompactionChat({
    real: environment.realLlm,
    budget: environment.budget,
    controller,
    plan: {
      finishWhen: () => driver.summaryRequests >= 1,
      finalContent,
    },
    // 只有第一次请求注入；纠正重试必须由真实模型回答。
    synthesizeSummary: ({ hardLimit, sequenceInCompaction }) =>
      sequenceInCompaction === 1 ? syntheticOverLimitSummary(hardLimit) : undefined,
  });
  ctx.driver = driver;
  ctx.window = V5_WINDOW.label;
  const agent = createAgent(driver, controller.signal, V5_WINDOW);
  state.agent = agent;
  ctx.agent = agent;

  const task = "summary-retry: reject one over-long summary and commit the corrective retry.";
  const reply = await agent.run(task);
  const stats = agent.compactionStats;
  const log = driver.summaryLog;

  assert(log.length === 2,
    `expected exactly two summary requests for the single compaction, got ${log.length}`);
  const [first, retry] = log;
  assert(first.synthetic === true, "the first summary reply must be the deterministic synthesis");
  assert(first.failed === false, "the synthetic first summary reply must not be a request failure");
  assert(first.statedLimit !== undefined, "the first summary request did not state a character limit");
  assert(typeof first.hardLimit === "number", "the first summary request did not record a hard limit");
  assert(first.finalChars > first.hardLimit,
    `the synthetic first reply is ${first.finalChars} chars, not over the hard limit ${first.hardLimit}`);
  const firstRejection = validateSummary(first.content, first.hardLimit);
  assert(firstRejection?.startsWith("summary is too long") === true,
    `the synthetic first reply was rejected as "${firstRejection ?? "valid"}", not as too long`);

  assert(retry.statedLimit !== undefined && retry.statedLimit < first.statedLimit,
    `the corrective request must tighten the stated limit (${first.statedLimit} -> ${retry.statedLimit})`);
  assert(retry.synthetic === false, "the corrective retry must use the real model, not synthesis");
  assert(retry.failed === false,
    `the real corrective retry failed: ${retry.error || "no reply"}`);
  // 内核用第一次请求的硬上限校验纠正重试，而不是提示词里更紧的目标长度。真模型可能比目标多写
  // 几十个字符却仍然合格；这类回复会被提交，应该在结果里写清楚，而不是当成场景失败。
  assert(retry.finalChars <= first.hardLimit,
    `the real corrective reply is ${retry.finalChars} chars, above the hard limit ${first.hardLimit}`);
  const tightenedOvershoot = retry.finalChars > retry.statedLimit
    ? ` (${retry.finalChars - retry.statedLimit} chars over the tightened prompt, still within the hard limit)`
    : "";
  const retryRejection = validateSummary(retry.content, first.hardLimit);
  assert(retryRejection === undefined, `the real corrective reply is invalid: ${retryRejection}`);

  assert(stats.compactions === 1, `expected exactly one committed compaction, got ${stats.compactions}`);
  assert(stats.summaryFailures === 0, `expected no summary failures after the corrective retry, got ${stats.summaryFailures}`);
  assert(stats.lastError === "", `unexpected last compaction error: ${stats.lastError}`);
  assert(driver.realAttempts === 1, `expected exactly one real request, got ${driver.realAttempts}`);
  assert(driver.realReplies === 1, `expected exactly one real reply, got ${driver.realReplies}`);
  assert(driver.syntheticReplies === 1, `expected exactly one synthetic reply, got ${driver.syntheticReplies}`);
  assertSummaryAccounting(agent, driver);
  assertTranscriptShape(agent, task, finalContent, reply, { expectSummary: true });
  assert(driver.problems.length === 0, driver.problems.join("; "));

  return {
    window: V5_WINDOW.label,
    ...summaryCounts(driver),
    compactions: 1,
    detail: `synthetic ${first.finalChars} chars (hard ${first.hardLimit}) -> ` +
      `real retry ${retry.finalChars} chars (tightened ${retry.statedLimit})${tightenedOvershoot}`,
  };
}

/** 场景 4 的 Run 1 长回复：只包含最终答复，不引入可被 Snip 的工具结果。 */
function persistentRun1Final() {
  const marker = "FINAL[persistent-over-limit:run-1]: baseline task complete. ";
  const filler = "baseline decision preserved. ";
  let text = marker;
  while (text.length < PERSISTENT_RUN1_FINAL_CHARS) text += filler;
  return text.slice(0, PERSISTENT_RUN1_FINAL_CHARS);
}

/** 把摘要记录按「压缩尝试」分组：每次尝试以 sequenceInCompaction === 1 开头。 */
function summaryAttemptGroups(summaryLog) {
  const groups = [];
  for (const entry of summaryLog) {
    if (entry.sequenceInCompaction === 1 || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(entry);
  }
  return groups;
}

/**
 * 场景 4（v5）：所有摘要回复都由脚本合成，固定 1.5 倍硬上限，不调用真实模型。
 *
 * 预期：两次压缩尝试、每次最多两次请求，失败配额用完就停；不提交，并且失败 Run 之前的
 * 整段 Transcript 逐字节不变。Run 1 刻意只留一条长最终答复（没有工具结果），这样
 * 失败 Run 里的确定性 Snip 不会合法地改写「原历史」。
 */
async function runPersistentOverLimit(environment, ctx) {
  const controller = new AbortController();
  const run1Final = persistentRun1Final();
  const finalContent = "FINAL[persistent-over-limit:run-2]: the task finishes without committing a summary.";
  const driver = new CompactionChat({
    real: environment.realLlm,
    budget: environment.budget,
    controller,
    plan: { finishWhen: () => true, finalContent: run1Final },
    // 每一次摘要回复都按本次压缩的硬上限合成超长回复；纠正请求的提示更紧也不放宽。
    synthesizeSummary: ({ hardLimit }) => syntheticOverLimitSummary(hardLimit),
  });
  ctx.driver = driver;
  ctx.window = V5_WINDOW.label;
  const agent = createAgent(driver, controller.signal, V5_WINDOW);
  ctx.agent = agent;

  const task1 = "persistent-over-limit: establish a previous task before the failure run.";
  const firstReply = await agent.run(task1);
  assert(firstReply.content === run1Final, "run 1 should finish with its own final reply");
  const before = agent.transcript;
  assert(agent.compactionStats.compactions === 0, "run 1 must not compact yet");
  assert(driver.summaryRequests === 0, "run 1 must not ask for a summary yet");

  driver.setPlan({
    finishWhen: () => agent.compactionStats.summaryFailures >= 2,
    finalContent,
  });
  const task2 = "persistent-over-limit: keep working while every summary reply overshoots.";
  const reply = await agent.run(task2);
  const stats = agent.compactionStats;
  const groups = summaryAttemptGroups(driver.summaryLog);

  assert(stats.compactions === 0, `persistent over-limit summaries must never commit, got ${stats.compactions}`);
  assert(stats.summaryFailures === 2, `expected two failed summary attempts, got ${stats.summaryFailures}`);
  assert(groups.length === 2, `expected two compaction attempts, got ${groups.length}`);
  assert(groups.every((group) => group.length <= 2),
    `each compaction attempt must use at most two summary requests, got ${groups.map((group) => group.length).join("/")}`);
  assert(driver.summaryRequests === groups.reduce((total, group) => total + group.length, 0),
    "summary request count must match the grouped attempts");
  assert(driver.summaryRequests <= 4,
    `summary requests must stay bounded at 4, got ${driver.summaryRequests}`);
  assert(driver.syntheticReplies === driver.summaryRequests,
    `all replies in this scenario must be synthetic, got ${driver.syntheticReplies}/${driver.summaryRequests}`);
  assert(driver.realAttempts === 0, `this scenario must not call the real model, got ${driver.realAttempts} attempt(s)`);
  assert(driver.realReplies === 0, `this scenario must not receive real replies, got ${driver.realReplies}`);
  assert(driver.summaryLog.every((entry) => entry.synthetic && entry.hardLimit !== undefined &&
    entry.finalChars > entry.hardLimit),
    "every synthetic reply must exceed its compaction's hard limit");
  assert(stats.lastError !== "" && /too long|length/i.test(stats.lastError),
    `unexpected last compaction error: ${stats.lastError}`);
  assertHistoryPrefixUnchanged(before, agent.transcript, "persistent-over-limit");
  assertSummaryAccounting(agent, driver);
  assertTranscriptShape(agent, task2, finalContent, reply, { expectSummary: false });
  assert(driver.problems.length === 0, driver.problems.join("; "));

  return {
    window: V5_WINDOW.label,
    ...summaryCounts(driver),
    compactions: 0,
    detail: `${groups.length} failed attempts (${groups.map((group) => group.length).join("/")} requests), ` +
      `${driver.summaryRequests} synthetic request(s), no commit, original transcript intact`,
  };
}

const SCENARIOS = [
  { name: "single-compaction", run: runSingleCompaction },
  { name: "consecutive-compactions", run: runConsecutiveCompactions },
  { name: "summary-retry", run: runSummaryRetry },
  { name: "persistent-over-limit", run: runPersistentOverLimit },
];

/** 跑一个场景；失败时连同已经花掉的摘要用量一起交给主循环报告。 */
async function evaluateScenario(spec, environment) {
  const ctx = { driver: undefined, agent: undefined };
  try {
    const result = await spec.run(environment, ctx);
    return { name: spec.name, ok: true, ...result };
  } catch (error) {
    const problems = ctx.driver?.problems ?? [];
    const trace = formatSummaryTrace(ctx.driver);
    const reason = [
      describeError(error),
      ...problems,
      trace === "" ? "" : `summary trace: ${trace}`,
    ].filter((part) => part !== "").join("; ");
    const counts = ctx.driver === undefined
      ? {
        summaryRequests: 0,
        realSummaryAttempts: 0,
        realSummaryReplies: 0,
        syntheticSummaryReplies: 0,
        usage: emptyUsage(),
      }
      : summaryCounts(ctx.driver);
    return {
      name: spec.name,
      ok: false,
      error: reason,
      window: ctx.window ?? "?",
      warnings: summaryTruncationWarnings(ctx.driver),
      ...counts,
      compactions: ctx.agent?.compactionStats.compactions ?? 0,
    };
  }
}

function printResultLine(result) {
  const usage = result.usage ?? emptyUsage();
  const tokens = `${formatNumber(usage.total)} tokens ` +
    `(prompt ${formatNumber(usage.prompt)} / completion ${formatNumber(usage.completion)})`;
  const summaries = `summary requests=${result.summaryRequests} ` +
    `(real attempts ${result.realSummaryAttempts}, real replies ${result.realSummaryReplies}, ` +
    `synthetic ${result.syntheticSummaryReplies})`;
  const label = result.name.padEnd(24);
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${label} window=${result.window ?? "?"}  ${summaries}  ${tokens}`);
  if (result.detail !== undefined) console.log(`      ${result.detail}`);
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    console.log(`      warnings: ${result.warnings.join("; ")}`);
  }
  if (!result.ok) console.log(`      reason: ${result.error}`);
}

function printSummary(results, budget, total = SCENARIOS.length) {
  console.log("\nPer-scenario paid usage:");
  for (const result of results) {
    const usage = result.usage ?? emptyUsage();
    const unknown = usage.unknown > 0 ? `, ${usage.unknown} unknown` : "";
    console.log(
      `  ${result.name.padEnd(24)} window=${String(result.window ?? "?").padEnd(11)} ` +
        `${String(result.summaryRequests).padStart(2)} request(s) ` +
        `[real ${result.realSummaryAttempts} attempted / ${result.realSummaryReplies} replied, ` +
        `synthetic ${result.syntheticSummaryReplies}]  ` +
        `prompt ${formatNumber(usage.prompt).padStart(8)}  ` +
        `completion ${formatNumber(usage.completion).padStart(7)}  ` +
        `total ${formatNumber(usage.total).padStart(8)}${unknown}`,
    );
  }

  const usage = budget.usage;
  console.log(
    `\nTotal: ${usage.requests} paid summary request(s), prompt ${formatNumber(usage.prompt)}, ` +
      `completion ${formatNumber(usage.completion)}, total ${formatNumber(usage.total)} ` +
      `of ${formatNumber(budget.cap)} budget.`,
  );
  if (usage.unknown > 0) {
    console.log(`Warning: ${usage.unknown} summary response(s) reported no usage; the total is a lower bound.`);
  }
  if (results.length < total) {
    console.log(`Remaining ${total - results.length} scenario(s) were not run.`);
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const ok = failed === 0 && !budget.exceeded;
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} (${passed}/${results.length} scenarios run)`);
}

/** 只认正整数的付费上限；配错了就在发请求之前报出来。 */
function readBudget() {
  const raw = process.env.EVAL_BUDGET_TOKENS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUDGET_TOKENS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid EVAL_BUDGET_TOKENS: ${JSON.stringify(raw)} (expected a positive integer)`);
  }
  return value;
}

/** 缺任何一项都在发请求之前失败：这个评测不会退回默认端点或默认模型。 */
function createRealLlm() {
  const baseUrl = process.env.BASE_URL?.trim() ?? "";
  const apiKey = process.env.API_KEY?.trim() ?? "";
  const model = process.env.MODEL?.trim() ?? "";
  const missing = [
    ["BASE_URL", baseUrl],
    ["API_KEY", apiKey],
    ["MODEL", model],
  ].filter(([, value]) => value === "").map(([name]) => name);
  if (missing.length > 0) {
    console.error(
      `missing ${missing.join(", ")}; the compaction eval forwards summary requests to the real model. ` +
        "Set them in .env (see .env.example) or in the environment.",
    );
    return undefined;
  }
  return new Llm({ baseUrl, apiKey, model });
}

function printHelp() {
  console.log(`compaction eval - drive the real context-compaction chain with scripted business turns

Usage:
  npm run eval:compaction
  node --env-file-if-exists=.env eval/compaction.mjs
  node --env-file-if-exists=.env eval/compaction.mjs --only summary-retry

Only summary requests go to the real model. Business turns, tool calls, and tool results are
scripted, so the run spends paid tokens on summaries only.

Options:
  --only <name[,name]>  run only the named scenario(s); useful for a cheap targeted rerun

Required environment:
  BASE_URL   chat/completions endpoint (for example, https://api.example.com/v1)
  API_KEY    bearer key
  MODEL      model id

Optional environment:
  EVAL_BUDGET_TOKENS   paid-token cap for this run (default ${DEFAULT_BUDGET_TOKENS}).
                       When the known total exceeds it, remaining scenarios are aborted
                       and the process exits with code 1.

Scenarios:
  1. single-compaction        one committed compaction (32768/2048 window)
  2. consecutive-compactions  two committed compactions in one Run (32768/2048)
  3. summary-retry            synthetic over-long first reply, real corrective retry, one commit (8192/1024)
  4. persistent-over-limit    synthetic over-long replies stay bounded, never commit, history intact (8192/1024)

Exit code: 0 only when every scenario passes and the budget is not exceeded.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }

  // `--only` 让复验单个场景时不用为其余场景付钱；它不改变任何场景内部的断言。
  const requested = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--only") {
      const value = args[++index];
      if (value === undefined || value.trim() === "") {
        console.error("--only requires a scenario name");
        return 1;
      }
      requested.push(...value.split(",").map((name) => name.trim()).filter((name) => name !== ""));
      continue;
    }
    if (arg.startsWith("--only=")) {
      requested.push(...arg.slice("--only=".length).split(",").map((name) => name.trim()).filter((name) => name !== ""));
      continue;
    }
    console.error(`unknown argument: ${arg}`);
    console.error("run with --help for usage");
    return 1;
  }

  const names = new Set(SCENARIOS.map((scenario) => scenario.name));
  const unknown = requested.filter((name) => !names.has(name));
  if (unknown.length > 0) {
    console.error(`unknown scenario: ${unknown.join(", ")} (available: ${[...names].join(", ")})`);
    return 1;
  }
  const only = new Set(requested);
  const selected = only.size === 0 ? SCENARIOS : SCENARIOS.filter((scenario) => only.has(scenario.name));

  let cap;
  try {
    cap = readBudget();
  } catch (error) {
    console.error(describeError(error));
    return 1;
  }
  const realLlm = createRealLlm();
  if (realLlm === undefined) return 1;

  const budget = new BudgetTracker(cap);
  console.log(
    `compaction eval: model=${process.env.MODEL} budget=${formatNumber(cap)} ` +
      `scenarios=${selected.map((scenario) => scenario.name).join(",")}`,
  );
  console.log(
    `windows: single/consecutive=${BIG_WINDOW.label}; summary-retry/persistent=${V5_WINDOW.label}`,
  );
  console.log(
    "only summary requests reach the real model; summary-retry/persistent inject synthetic replies; " +
      "business turns are scripted.\n",
  );

  const results = [];
  let aborted = false;
  for (const spec of selected) {
    if (budget.exceeded) {
      aborted = true;
      break;
    }
    const result = await evaluateScenario(spec, { realLlm, budget });
    results.push(result);
    printResultLine(result);
    if (budget.exceeded) {
      aborted = true;
      break;
    }
  }

  if (aborted) {
    console.error(
      `\nBUDGET ABORT: EVAL_BUDGET_TOKENS ${formatNumber(cap)} exceeded after ` +
        `${formatNumber(budget.usage.total)} paid token(s); remaining scenarios were not run.`,
    );
  }

  printSummary(results, budget, selected.length);
  return aborted || budget.exceeded || results.some((result) => !result.ok) ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`compaction eval crashed: ${describeError(error)}`);
  process.exitCode = 1;
}

/**
 * Agent 内核：一个类 + 一个循环。
 *
 * 整个 agent 就是不断重复同一件事：
 *
 *   messages ──▶ llm.chat() ──▶ 有 tool_calls？
 *                                   │否
 *                                   ├──▶ 返回最终回复，本轮结束
 *                                   │是
 *                                   ▼
 *              执行工具 ──▶ 结果作为 tool 消息入栈 ──┐
 *                                   ▲              │
 *                                   └──────────────┘（回到 llm.chat）
 *
 * 换个大模型、换个工具集，这个循环都不用改 —— 这就是「内核」的含义。
 * 它只依赖两样东西：一个能聊天的客户端，一个能执行工具调用的工具注册表。
 *
 * 生命周期：一个实例 = 一次任务。第一次 `run()` 之后实例即作废 ——
 * 再调用会抛生命周期错误，而不是悄悄继承上一条 transcript 继续跑。
 *
 * 理由：这个内核的定位是「一个 Agent 实例执行一个任务」。允许复用就必须回答
 * 「谁重置 transcript、失败后算不算已消费、并发调用怎么排队」，那是一整套会话管理，
 * 不在当前范围内。显式拒绝比隐式继承便宜得多。
 */
import { ChatResponseError } from "./errors.ts";
import type { ChatClient, ChatResponse, Message, TokenUsage, ToolCall } from "./types.ts";
import type { ToolRegistry } from "./tool-registry.ts";

/**
 * 系统提示词：告诉模型「你是谁、有哪些工具、什么时候该停」。
 * 它是英文的，因为这是给模型看的；源码注释才是给读代码的人看的中文。
 * 每一行英文上面是它的中文对照 —— 中文只留在源码里，发给模型的只有英文那一行。
 */
export const DEFAULT_SYSTEM_PROMPT = [
  // 你是一个在当前工作区里干活的编码 agent。
  "You are a coding agent working inside the current workspace.",
  // 可用工具：read、write、edit、glob、grep、ls、shell。用它，不要靠猜。
  "Tools: read, write, edit, glob, grep, ls, shell. Use them instead of guessing.",
  // 动手改之前先看；每次改动小一点；做完跑一次检查或测试来验证。
  "Inspect before editing, keep changes small, and verify your work with a check or test.",
  // 非关键歧义自己合理判断；影响正确性、文件范围或重要操作的歧义可以问用户。
  "Ask when an ambiguity affects correctness, the files in scope, or an important operation; otherwise make a reasonable assumption and continue.",
  // 不要声称跑过没跑的命令或测试；无法验证时明确说明。
  "Never claim to have run a command or test that you did not run. If you cannot verify something, say so explicitly.",
  // 完成后用一小段总结收尾，然后停止调用工具。
  "Reply with a short summary when done, then stop calling tools.",
  // 每次只跑一条 shell 命令、用简单语法；不要用竖线串联命令，也不要换着引号写。
  "Run one shell command per call with simple syntax; do not use | to sequence commands or alternate quoting.",
].join("\n");

/**
 * 把一次工具执行结果包装成一条 tool 消息。
 *
 * 关键点：tool_call_id 必须等于模型发起调用时的 call.id。
 * API 靠这个 id 把「结果」和「请求」配对；写错或漏写，整个请求会被判为非法。
 */
function createToolResult(call: ToolCall, result: string): Message {
  return { role: "tool", tool_call_id: call.id, content: result };
}

/** 取消时抛出的错误：把 signal 上的原因带出来，CLI 才能说清是被什么停掉的。 */
function cancellationError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return new Error(detail.length > 0 ? `cancelled: ${detail}` : "cancelled");
}

/** 一份全零的用量。每次 Run 开始和 Session 创建时各拿一份，避免共用同一个可变对象。 */
function emptyUsage(): AgentUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, reported: 0, unknown: 0 };
}

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
  /** 本次 Run 发出去的模型请求数（失败的请求也算一次尝试）。 */
  requests: number;
  /** 本次 Run 真正执行的工具调用数；Tool call budget 按这个数算。 */
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
 * 和 `stats` 分开是有意的：预算按 Run 算（一轮任务的花销），账单按 Session 算（整个进程）。
 * 两个数字混在一起，就没有办法既限制单轮、又看清总量。
 */
export interface AgentSessionStats {
  /** 已经开始的 Run 数；失败或取消的 Run 也算一次。 */
  runs: number;
  requests: number;
  toolCalls: number;
  usage: AgentUsage;
}

export interface AgentOptions {
  /** 模型客户端。传接口而不是具体类，测试时才能注入假实现。 */
  llm: ChatClient;
  /** 模型能调用的工具集合。 */
  tools: ToolRegistry;
  /** 不传就用 DEFAULT_SYSTEM_PROMPT。传函数时在每次模型请求前求值，用于动态权限说明。 */
  systemPrompt?: string | (() => string);
  /** 循环上限。设计稿里是 while (true)，实战必须有这个刹车。 */
  maxSteps?: number;
  /**
   * 一次任务最多执行多少次工具调用。默认 60。
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
  onToolResult?: (call: ToolCall, result: string) => void;
  /**
   * 流式正文增量。只在 ChatClient 支持流式时才会被调用，且只用于显示：
   * 最终消息仍以 chat() 的返回值为准，回调晚到、漏掉都不影响正确性。
   */
  onDelta?: (text: string) => void;
}

export class Agent {
  private readonly llm: ChatClient;
  private readonly tools: ToolRegistry;
  private readonly systemPrompt: () => string;
  private readonly maxSteps: number;
  private readonly maxToolCalls: number;
  private readonly maxTotalTokens?: number;
  private readonly signal?: AbortSignal;
  private readonly onToolResult?: (call: ToolCall, result: string) => void;

  private readonly onDelta?: (text: string) => void;

  /** 本次 Run 已经执行的工具调用数；Tool call budget 按它算，也用它写「部分执行」的失败报告。 */
  private runToolCalls = 0;

  /** 本次 Run 发出去的模型请求数：在 await 之前加，所以取消/失败的请求也算一次尝试。 */
  private runRequests = 0;

  /** 本次 Run 的用量；Token budget 按它算。每次 Run 开始时归零。 */
  private runUsage: AgentUsage = emptyUsage();

  /** 跨 Run 的累计账单。 */
  private sessionRequests = 0;

  private sessionToolCalls = 0;

  private readonly sessionUsage: AgentUsage = emptyUsage();

  /** 已经开始的 Run 数。 */
  private runCount = 0;

  /** 同一时刻只允许一个 Run：两个 run() 同时写一条 transcript，语义无法解释。 */
  private running = false;

  /**
   * 完整对话记录。它是 Agent 唯一的状态，也是每一轮要重发给模型的全部上下文。
   * 注意「重发」：模型是无状态的，它记得多少，完全取决于我们发过去多少。
   * 对外只读：调用方可以看，但不能绕过循环往里塞消息。
   */
  private readonly messages: Message[] = [];

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.tools = options.tools;
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.systemPrompt = typeof systemPrompt === "string" ? () => systemPrompt : systemPrompt;
    this.maxSteps = options.maxSteps ?? 30;
    this.maxToolCalls = options.maxToolCalls ?? 60;
    this.maxTotalTokens = options.maxTotalTokens;
    this.signal = options.signal;
    this.onToolResult = options.onToolResult;
    this.onDelta = options.onDelta;

    // 系统提示词只放一条，之后每轮都跟着 messages 一起发出去；内容可由 provider 在请求前刷新。
    this.messages.push({ role: "system", content: this.systemPrompt() });
  }

  /**
   * 刷新唯一的 system 消息。
   *
   * 动态权限说明只改这一条消息的内容，不追加新的 system 消息：
   * 追加会改变消息顺序，也会让模型同时看到新旧两套规则。原地更新保留
   * 「一条 system + 一条 user + assistant/tool 配对」的 Transcript 形状。
   */
  private refreshSystemPrompt(): void {
    // 构造函数保证 index 0 是唯一的 system 消息；这里只刷新内容，不追加、不重复校验。
    this.messages[0].content = this.systemPrompt();
  }

  /**
   * 取消检查点：每一轮模型请求之前、每一次工具调用之前都要过。
   *
   * 光靠 fetch 的 signal 不够 —— 取消可能发生在两次工具调用之间，那里没有网络请求可中断。
   * pending 是「本来接下来要执行的调用」：给它们补上 not run 的结果，Transcript 的
   * assistant / tool 配对才不会断（配对断了，事后拿记录去复盘或重放都会被 API 拒绝）。
   */
  private stopIfCancelled(pending: readonly ToolCall[] = []): void {
    if (this.signal?.aborted !== true) return;
    this.skipCalls(pending, "task cancelled");
    throw cancellationError(this.signal);
  }

  /** 没有执行的调用也要留下一条结果：明确写「没跑」，而不是让它们凭空消失。 */
  private skipCalls(calls: readonly ToolCall[], reason: string): void {
    for (const call of calls) {
      this.messages.push(createToolResult(call, `ERROR: not run: ${reason}`));
    }
  }

  /** 本次 Run 的用量快照。返回新对象：调用方改不到内部计数。 */
  get stats(): AgentStats {
    const limit = this.maxTotalTokens;
    return {
      requests: this.runRequests,
      toolCalls: this.runToolCalls,
      usage: { ...this.runUsage },
      tokenBudget: {
        limit,
        exceeded: limit !== undefined && this.runUsage.totalTokens >= limit,
      },
    };
  }

  /** 跨 Run 的累计快照：整个 Session 一共跑了多少次、花了多少。 */
  get sessionStats(): AgentSessionStats {
    return {
      runs: this.runCount,
      requests: this.sessionRequests,
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
    if (usage === undefined) {
      this.runUsage.unknown++;
      this.sessionUsage.unknown++;
      return;
    }
    this.runUsage.reported++;
    this.sessionUsage.reported++;
    this.runUsage.promptTokens += usage.prompt_tokens;
    this.sessionUsage.promptTokens += usage.prompt_tokens;
    this.runUsage.completionTokens += usage.completion_tokens;
    this.sessionUsage.completionTokens += usage.completion_tokens;
    this.runUsage.totalTokens += usage.total_tokens;
    this.sessionUsage.totalTokens += usage.total_tokens;
  }

  /**
   * 预算用尽就停手：不再发请求，也不执行「没有下一次请求去验证」的工具。
   *
   * 只看**本次 Run** 的合计：REPL 里的第二轮不该被第一轮的花费挤掉工具额度。
   * 只在已知合计达到上限时触发；usage 缺失时这条闸门拦不住那部分消耗，
   * 所以错误文案和 stats 都只说「已统计到多少」，不说「实际花了多少」。
   */
  private stopIfBudgetExhausted(pending: readonly ToolCall[] = []): void {
    const budget = this.maxTotalTokens;
    if (budget === undefined || this.runUsage.totalTokens < budget) return;

    this.skipCalls(pending, `token budget ${budget} reached`);
    const lowerBound = this.runUsage.unknown > 0 ? "at least " : "";
    const unknownNote =
      this.runUsage.unknown > 0
        ? `; ${this.runUsage.unknown} request(s) have no usage (failed or unreported), so the real total is higher`
        : "";
    throw new Error(
      `token budget ${budget} reached: ${lowerBound}${this.runUsage.totalTokens} tokens counted over ` +
        `${this.runUsage.reported} request(s) with usage${unknownNote}`,
    );
  }

  /**
   * 到目前为止的完整对话记录。
   *
   * 返回深拷贝：数组复制挡不住 `snapshot[0].content = "..."`，只有把 Message 也复制了，
   * 「只读」才是真的只读，而不是只挡住了 push/splice。
   */
  get transcript(): readonly Message[] {
    return structuredClone(this.messages);
  }

  /**
   * 跑完一次 Run，返回模型的最终回复（一条不带 tool_calls 的 assistant 消息）。
   *
   * 这就是 **agent loop**：教科书里那个 `while (true)` —— 问模型、执行它要的工具、
   * 把结果塞回去，直到它不再要工具。这里用带计数器的 for 代替 while (true)，
   * 并加了三道闸门：模型请求次数、工具执行次数、取消信号。
   *
   * 一个 Agent 可以连续跑多个 Run（REPL 就是这样一个循环），Transcript 跨 Run 累积；
   * 但同一时刻只允许一个 Run —— 两个循环同时往一条 transcript 里写，顺序无法解释。
   *
   * 失败时抛错而不是返回半成品：让调用方明确知道「任务没跑完」，
   * 错误文案里带「已经执行了多少」，此时 transcript 里保留了全过程。
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
    this.beginRun();
    try {
      return await this.runLoop(task);
    } finally {
      this.running = false;
    }
  }

  /** 每次 Run 开始时归零「本次」的计数；Session 累计不归零。 */
  private beginRun(): void {
    this.runCount++;
    this.runRequests = 0;
    this.runToolCalls = 0;
    this.runUsage = emptyUsage();
  }

  private async runLoop(task: string): Promise<Message> {
    // 取消发生在任务开始之前：用户已经按了 Ctrl-C，就不该再花一次模型请求。
    this.stopIfCancelled();

    // 1) 用户消息先入栈；之后每次请求模型，都带着从 system 到此刻的完整历史。
    this.messages.push({ role: "user", content: task });

    for (let step = 1; step <= this.maxSteps; step++) {
      // 2) 问模型：把历史 + 工具清单交给它，由它决定「直接回答」还是「调工具」。
      this.stopIfCancelled();
      this.stopIfBudgetExhausted();
      // 每次请求前重新求值：/permission 切换后，下一次请求必须看到新规则。
      this.refreshSystemPrompt();
      this.runRequests++;
      this.sessionRequests++;
      let response: ChatResponse;
      try {
        response = await this.llm.chat(this.messages, this.tools.definitions, { onDelta: this.onDelta });
      } catch (error) {
        // 请求已经发出去：响应非法但带回 usage 时精确记账，否则记未知。
        // 不记的话，失败请求的成本会从统计里凭空消失。
        this.recordUsage(error instanceof ChatResponseError ? error.usage : undefined);
        throw error;
      }

      // 3) 模型这一轮的输出要立刻入栈，而且顺序有讲究：
      //    带 tool_calls 的 assistant 消息必须排在对应的 tool 结果之前，
      //    否则下一轮请求会被 API 拒绝（结果找不到「上家」）。
      const message = response.message;
      this.messages.push(message);
      this.recordUsage(response.usage);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        // 4) 没有工具调用 = 模型认为可以交卷了，本轮结束。
        //    但「交卷」得真有东西：空回复不是成功，是模型没说话 ——
        //    内容被过滤、生成被截断、服务端半截响应，都会走到这一条。
        if ((message.content ?? "").trim() === "") {
          throw new Error("model returned an empty final answer");
        }
        return message;
      }

      // 5) 这一轮可能刚好把预算用光：后面的工具没有下一次请求去验证，不能执行。
      this.stopIfBudgetExhausted(calls);

      // 6) 最后一次请求只留给最终答复：要工具也不再执行 —— 没有下一次请求能验证它的结果。
      //    未执行的调用仍补一条 not run 结果，保证 assistant / tool 配对完整。
      if (step === this.maxSteps) {
        this.skipCalls(calls, "no model request left to verify the result");
        throw new Error(
          `step limit ${this.maxSteps} reached after executing ${this.runToolCalls} tool call(s); ` +
            `the final model response asked for ${calls.length} more, which were not run`,
        );
      }

      // 7) 整批先算预算：执行到一半才发现超限，会留下一批「跑了但没回报」的调用。
      if (this.runToolCalls + calls.length > this.maxToolCalls) {
        this.skipCalls(calls, `tool call budget ${this.maxToolCalls} would be exceeded`);
        throw new Error(
          `tool call budget ${this.maxToolCalls} exceeded: ${this.runToolCalls} already executed in this Run, ` +
            `this batch asks for ${calls.length}; none of them were run`,
        );
      }

      // 8) 有工具调用就逐个执行，并把结果写回对话记录。
      //    这里刻意串行：简单，且消息顺序与模型给出的顺序一一对应。
      //    （并发执行能更快，但结果回灌顺序会乱，属于优化，不属于内核。）
      for (let index = 0; index < calls.length; index++) {
        // 取消可能正好发生在两次调用之间：剩下的调用不再启动，但每条都要留下结果。
        this.stopIfCancelled(calls.slice(index));
        const call = calls[index];
        const result = await this.tools.execute(call);
        this.runToolCalls++;
        this.sessionToolCalls++;
        this.messages.push(createToolResult(call, result));
        this.onToolResult?.(call, result);
      }

      // 9) 回到循环顶部：模型现在能看到工具结果了，继续它的下一步。
    }

    // 理论上走不到这里：最后一步要么返回最终回复，要么抛「最后一步不执行工具」。
    // 保留它兜住 maxSteps <= 0 这种配置错误，也让这个函数在类型上一定有出口。
    // 中文对照：已达到步数上限 {n} 步，已执行 {m} 次工具调用。
    throw new Error(
      `step limit ${this.maxSteps} reached after executing ${this.runToolCalls} tool call(s)`,
    );
  }
}

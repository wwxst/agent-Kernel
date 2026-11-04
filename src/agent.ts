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
import type { ChatClient, Message, ToolCall } from "./types.ts";
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
  // 动手改之前先看；每次改动小一点；做完跑一次检查或测试。
  "Inspect before editing, keep changes small, and run a check or test when done.",
  // 不要反问用户；自己做合理假设，把任务做完。
  "Do not ask questions; make reasonable assumptions and finish the task.",
  // 完成后用一小段总结收尾，然后停止调用工具。
  "Reply with a short summary when done, then stop calling tools.",
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

export interface AgentOptions {
  /** 模型客户端。传接口而不是具体类，测试时才能注入假实现。 */
  llm: ChatClient;
  /** 模型能调用的工具集合。 */
  tools: ToolRegistry;
  /** 不传就用 DEFAULT_SYSTEM_PROMPT。 */
  systemPrompt?: string;
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
   * 取消信号。CLI 收到 SIGINT / SIGTERM 时 abort 它：
   * 循环不再发起新的模型请求或工具调用，正在跑的 shell 由 Workspace 收掉进程树。
   */
  signal?: AbortSignal;
  /** 每次工具执行完的回调，用来打印进度；Agent 本身不直接 console.log。 */
  onToolResult?: (call: ToolCall, result: string) => void;
}

export class Agent {
  private readonly llm: ChatClient;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly maxToolCalls: number;
  private readonly signal?: AbortSignal;
  private readonly onToolResult?: (call: ToolCall, result: string) => void;

  /** 已经执行的工具调用数；预算按它算，也用它写「部分执行」的失败报告。 */
  private executedToolCalls = 0;

  /** 生命周期闸门：第一次 run() 之前是 false，之后永远是 true（失败/取消也算消费）。 */
  private started = false;

  /**
   * 完整对话记录。它是 Agent 唯一的状态，也是每一轮要重发给模型的全部上下文。
   * 注意「重发」：模型是无状态的，它记得多少，完全取决于我们发过去多少。
   * 对外只读：调用方可以看，但不能绕过循环往里塞消息。
   */
  private readonly messages: Message[] = [];

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.tools = options.tools;
    this.maxSteps = options.maxSteps ?? 30;
    this.maxToolCalls = options.maxToolCalls ?? 60;
    this.signal = options.signal;
    this.onToolResult = options.onToolResult;

    // 系统提示词只放一次，之后每轮都跟着 messages 一起发出去。
    this.messages.push({
      role: "system",
      content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    });
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
   * 跑完一次任务，返回模型的最终回复（一条不带 tool_calls 的 assistant 消息）。
   *
   * 这就是 **agent loop**：教科书里那个 `while (true)` —— 问模型、执行它要的工具、
   * 把结果塞回去，直到它不再要工具。这里用带计数器的 for 代替 while (true)，
   * 并加了三道闸门：模型请求次数、工具执行次数、取消信号。
   *
   * 失败时抛错而不是返回半成品：让调用方明确知道「任务没跑完」，
   * 错误文案里带「已经执行了多少」，此时 transcript 里保留了全过程。
   *
   * 最后的请求预算留给「收尾」：到第 maxSteps 次请求时，模型只能给最终答复；
   * 它若还想要工具，那些工具不执行 —— 执行了也没有下一次请求去验证结果，
   * 等于制造一批「跑过但没人看过」的副作用。
   */
  async run(task: string): Promise<Message> {
    // 一个实例只跑一次：第二次调用会让两条任务共用一条 transcript，语义无法解释。
    if (this.started) {
      throw new Error("agent instance is single-use: run() has already been called");
    }
    this.started = true;

    // 取消发生在任务开始之前：用户已经按了 Ctrl-C，就不该再花一次模型请求。
    this.stopIfCancelled();

    // 1) 用户消息先入栈；之后每次请求模型，都带着从 system 到此刻的完整历史。
    this.messages.push({ role: "user", content: task });

    for (let step = 1; step <= this.maxSteps; step++) {
      // 2) 问模型：把历史 + 工具清单交给它，由它决定「直接回答」还是「调工具」。
      this.stopIfCancelled();
      const response = await this.llm.chat(this.messages, this.tools.definitions);

      // 3) 模型这一轮的输出要立刻入栈，而且顺序有讲究：
      //    带 tool_calls 的 assistant 消息必须排在对应的 tool 结果之前，
      //    否则下一轮请求会被 API 拒绝（结果找不到「上家」）。
      this.messages.push(response);

      const calls = response.tool_calls ?? [];
      if (calls.length === 0) {
        // 4) 没有工具调用 = 模型认为可以交卷了，本轮结束。
        //    但「交卷」得真有东西：空回复不是成功，是模型没说话 ——
        //    内容被过滤、生成被截断、服务端半截响应，都会走到这一条。
        if ((response.content ?? "").trim() === "") {
          throw new Error("model returned an empty final answer");
        }
        return response;
      }

      // 5) 最后一次请求只留给最终答复：要工具也不再执行 —— 没有下一次请求能验证它的结果。
      //    未执行的调用仍补一条 not run 结果，保证 assistant / tool 配对完整。
      if (step === this.maxSteps) {
        this.skipCalls(calls, "no model request left to verify the result");
        throw new Error(
          `step limit ${this.maxSteps} reached after executing ${this.executedToolCalls} tool call(s); ` +
            `the final model response asked for ${calls.length} more, which were not run`,
        );
      }

      // 6) 整批先算预算：执行到一半才发现超限，会留下一批「跑了但没回报」的调用。
      if (this.executedToolCalls + calls.length > this.maxToolCalls) {
        this.skipCalls(calls, `tool call budget ${this.maxToolCalls} would be exceeded`);
        throw new Error(
          `tool call budget ${this.maxToolCalls} exceeded: ${this.executedToolCalls} already executed, ` +
            `this batch asks for ${calls.length}; none of them were run`,
        );
      }

      // 7) 有工具调用就逐个执行，并把结果写回对话记录。
      //    这里刻意串行：简单，且消息顺序与模型给出的顺序一一对应。
      //    （并发执行能更快，但结果回灌顺序会乱，属于优化，不属于内核。）
      for (let index = 0; index < calls.length; index++) {
        // 取消可能正好发生在两次调用之间：剩下的调用不再启动，但每条都要留下结果。
        this.stopIfCancelled(calls.slice(index));
        const call = calls[index];
        const result = await this.tools.execute(call);
        this.executedToolCalls++;
        this.messages.push(createToolResult(call, result));
        this.onToolResult?.(call, result);
      }

      // 8) 回到循环顶部：模型现在能看到工具结果了，继续它的下一步。
    }

    // 理论上走不到这里：最后一步要么返回最终回复，要么抛「最后一步不执行工具」。
    // 保留它兜住 maxSteps <= 0 这种配置错误，也让这个函数在类型上一定有出口。
    // 中文对照：已达到步数上限 {n} 步，已执行 {m} 次工具调用。
    throw new Error(
      `step limit ${this.maxSteps} reached after executing ${this.executedToolCalls} tool call(s)`,
    );
  }
}

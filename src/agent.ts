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
 * 生命周期：一个实例 = 一次任务。`run()` 每次都往同一条 transcript 里追加，
 * 所以连续调用会继承上一次的上下文（包括上一次的 user 消息）。
 * CLI 每次新建 Agent，因此现在没有实际问题；将来真要多轮复用，
 * 先定清楚「谁负责重置、什么时候重置」，再来改这里，别让它变成隐式行为。
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

export interface AgentOptions {
  /** 模型客户端。传接口而不是具体类，测试时才能注入假实现。 */
  llm: ChatClient;
  /** 模型能调用的工具集合。 */
  tools: ToolRegistry;
  /** 不传就用 DEFAULT_SYSTEM_PROMPT。 */
  systemPrompt?: string;
  /** 循环上限。设计稿里是 while (true)，实战必须有这个刹车。 */
  maxSteps?: number;
  /** 每次工具执行完的回调，用来打印进度；Agent 本身不直接 console.log。 */
  onToolResult?: (call: ToolCall, result: string) => void;
}

export class Agent {
  private readonly llm: ChatClient;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly onToolResult?: (call: ToolCall, result: string) => void;

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
    this.onToolResult = options.onToolResult;

    // 系统提示词只放一次，之后每轮都跟着 messages 一起发出去。
    this.messages.push({
      role: "system",
      content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    });
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
   * 唯一多出来的东西就是步数上限：模型完全可能陷入「调工具 → 结果不满意 → 再调」，
   * 没有闸门的话，烧的是真金白银。
   *
   * 步数用尽时抛错而不是返回半成品：让调用方明确知道「任务没跑完」，
   * 此时 transcript 里保留了全过程，调试时可以直接打印出来看。
   */
  async run(task: string): Promise<Message> {
    // 1) 用户消息先入栈；之后每次请求模型，都带着从 system 到此刻的完整历史。
    this.messages.push({ role: "user", content: task });

    for (let step = 1; step <= this.maxSteps; step++) {
      // 2) 问模型：把历史 + 工具清单交给它，由它决定「直接回答」还是「调工具」。
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

      // 5) 有工具调用就逐个执行，并把结果写回对话记录。
      //    这里刻意串行：简单，且消息顺序与模型给出的顺序一一对应。
      //    （并发执行能更快，但结果回灌顺序会乱，属于优化，不属于内核。）
      for (const call of calls) {
        const result = await this.tools.execute(call);
        this.messages.push(createToolResult(call, result));
        this.onToolResult?.(call, result);
      }

      // 6) 回到循环顶部：模型现在能看到工具结果了，继续它的下一步。
    }

    // 7) 步数用尽。
    // 中文对照：已达到步数上限 {n} 步。
    throw new Error(`step limit ${this.maxSteps} reached`);
  }
}

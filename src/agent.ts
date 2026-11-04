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
 */
import { executeTool } from "./tools.ts";
import type { ChatClient, Message, Tool, ToolCall } from "./types.ts";

/**
 * 系统提示词：告诉模型「你是谁、有哪些工具、什么时候该停」。
 * 它是英文的，因为这是给模型看的；源码注释才是给读代码的人看的中文。
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are a coding agent working inside the current workspace.",
  "Tools: read_file, write_file, list_dir, run_command. Use them instead of guessing.",
  "Inspect before editing, keep changes small, and run a check or test when done.",
  "Do not ask questions; make reasonable assumptions and finish the task.",
  "Reply with a short summary when done, then stop calling tools.",
].join("\n");

/**
 * 把一次工具执行结果包装成一条 tool 消息。
 *
 * 关键点：tool_call_id 必须等于模型发起调用时的 call.id。
 * API 靠这个 id 把「结果」和「请求」配对；写错或漏写，整个请求会被判为非法。
 */
export function createToolResult(call: ToolCall, result: string): Message {
  return { role: "tool", tool_call_id: call.id, content: result };
}

export interface AgentOptions {
  /** 模型客户端。传接口而不是具体类，测试时才能注入假实现。 */
  llm: ChatClient;
  /** 可用工具列表；模型只能调用这里声明过的工具。 */
  tools?: Tool[];
  /** 不传就用 DEFAULT_SYSTEM_PROMPT。 */
  systemPrompt?: string;
  /** 循环上限。设计稿里是 while (true)，实战必须有这个刹车。 */
  maxSteps?: number;
  /** 每次工具执行完的回调，用来打印进度；Agent 本身不直接 console.log。 */
  onToolResult?: (call: ToolCall, result: string) => void;
}

export class Agent {
  /**
   * 完整对话记录。它是 Agent 唯一的状态，也是每一轮要重发给模型的全部上下文。
   * 注意「重发」：模型是无状态的，它记得多少，完全取决于我们发过去多少。
   */
  readonly messages: Message[] = [];

  private readonly llm: ChatClient;
  private readonly tools: Tool[];
  private readonly maxSteps: number;
  private readonly onToolResult?: (call: ToolCall, result: string) => void;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.tools = options.tools ?? [];
    this.maxSteps = options.maxSteps ?? 30;
    this.onToolResult = options.onToolResult;

    // 系统提示词只放一次，之后每轮都跟着 messages 一起发出去。
    this.messages.push({
      role: "system",
      content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    });
  }

  /**
   * 跑完一次任务，返回模型的最终回复（一条不带 tool_calls 的 assistant 消息）。
   *
   * 示意代码里是 while (true)；这里改成带计数器的 for，唯一的差别就是多了步数上限。
   * 别小看这个上限：模型完全可能陷入「调工具 → 结果不满意 → 再调」的循环，
   * 没有闸门的话，烧的是真金白银。
   */
  async run(userMessage: string): Promise<Message> {
    // 1) 用户消息先入栈；之后每次请求模型，都带着从 system 到此刻的完整历史。
    this.messages.push({ role: "user", content: userMessage });

    for (let step = 1; step <= this.maxSteps; step++) {
      // 2) 问模型：把历史 + 工具清单交给它，由它决定「直接回答」还是「调工具」。
      const response = await this.llm.chat(this.messages, this.tools);

      // 3) 模型这一轮的输出要立刻入栈，而且顺序有讲究：
      //    带 tool_calls 的 assistant 消息必须排在对应的 tool 结果之前，
      //    否则下一轮请求会被 API 拒绝（结果找不到「上家」）。
      this.messages.push(response);

      const calls = response.tool_calls ?? [];
      if (calls.length === 0) {
        // 4) 没有工具调用 = 模型认为可以交卷了，本轮结束。
        return response;
      }

      // 5) 有工具调用就逐个执行，并把结果写回对话记录。
      //    这里刻意串行：简单，且消息顺序与模型给出的顺序一一对应。
      //    （并发执行能更快，但结果回灌顺序会乱，属于优化，不属于内核。）
      for (const call of calls) {
        const result = await executeTool(this.tools, call);
        this.messages.push(createToolResult(call, result));
        this.onToolResult?.(call, result);
      }

      // 6) 回到循环顶部：模型现在能看到工具结果了，继续它的下一步。
    }

    // 7) 步数用尽。抛错而不是返回半成品：让调用方明确知道「任务没跑完」。
    //    此时 this.messages 里保留了全过程，调试时可以直接打印出来看。
    throw new Error(`step limit ${this.maxSteps} reached`);
  }
}

/**
 * 协议层：Agent 和 LLM 之间只交换这几种数据形状。
 *
 * 为什么单独放一个文件？
 *   1. Agent 只依赖「能聊天的客户端」这个接口，不关心它是真实 HTTP 还是测试里的假实现，
 *      这样端到端测试不需要 API Key、也不需要联网；
 *   2. 字段名直接沿用 OpenAI /chat/completions 的线上格式（tool_calls、tool_call_id），
 *      请求体可以原样序列化，少一层「驼峰 ↔ 下划线」翻译，就少一类难查的 bug。
 */

/** 对话里的四种角色。 */
export type Role =
  | "system" // 规则与约束，通常只有一条，永远排在最前面
  | "user" // 用户这一轮交代的任务
  | "assistant" // 模型说的话，或者它发起的工具调用
  | "tool"; // 工具的返回结果，必须能对应到某一次 tool_call

/**
 * 模型发起的一次工具调用。
 *
 * 注意 arguments 是「JSON 字符串」而不是对象：
 * 模型是一个 token 一个 token 往外吐文本的，它没法直接产出一个 JS 对象。
 * 把这段文本解析成对象、校验字段类型，是宿主程序（也就是我们）的责任。
 */
export interface ToolCall {
  /** 调用 id。回灌结果时原样带回，API 靠它把「这次请求」和「这条结果」配对。 */
  id: string;
  /** 目前只有 "function" 一种；保留字段是为了和协议结构完全对齐。 */
  type: "function";
  function: {
    /** 工具名，必须能在 tools 数组里找到同名项。 */
    name: string;
    /** 参数，JSON 文本。可能是空串，也可能是模型写错的半截 JSON。 */
    arguments: string;
  };
}

/**
 * 一条消息。这些内容会被原样发给模型，所以 messages 数组就是我们全部的「记忆」。
 */
export interface Message {
  role: Role;
  /** 文本内容。带 tool_calls 的 assistant 消息，content 通常是 null。 */
  content: string | null;
  /** 只有 assistant 消息会带：这一轮它想调用哪些工具（可能多个）。 */
  tool_calls?: ToolCall[];
  /** 只有 tool 消息会带：这条结果在回应哪一次调用。 */
  tool_call_id?: string;
}

/**
 * 一个工具的完整定义。
 *
 * description 和 parameters（JSON Schema）是写给模型看的「说明书」：
 * 模型靠它们决定调不调、传什么参数。run 才是真正干活的代码。
 * 说明书写得含糊，模型就会调错、传错 —— 这一层的文案质量直接决定 agent 的表现。
 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

/**
 * 工具的「说明书」部分：name / description / parameters，不含 run。
 *
 * 发请求时只序列化这些字段；run 是宿主侧的代码，模型看不见也不需要知道。
 */
export type ToolSpec = Omit<Tool, "run">;

/**
 * Agent 唯一依赖的模型接口。
 *
 * 刻意做成接口而不是类，因为跨这条缝真的有两种实现：
 * 生产是 Llm（发 HTTP 请求），测试是按脚本回放的假客户端。
 * 只有一种实现时不必开这个口子 —— 那是为将来预留的空缝。
 */
export interface ChatClient {
  chat(messages: readonly Message[], tools: readonly ToolSpec[]): Promise<Message>;
}

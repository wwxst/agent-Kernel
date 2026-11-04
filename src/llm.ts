/**
 * 模型客户端：一次 chat() 就是一次 HTTP POST {baseUrl}/chat/completions。
 *
 * 只依赖 Node 内置的 fetch，所以这个项目运行时零依赖。
 * 只要端点兼容 OpenAI 的 chat/completions，就能直接换：
 * DeepSeek、Moonshot、OpenAI、Ollama、vLLM……
 */
import type { ChatClient, Message, ToolCall, ToolDefinition } from "./types.ts";

export interface LlmOptions {
  /** 形如 https://api.deepseek.com/v1，末尾斜杠会被自动去掉。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 默认 0：做工程任务时，我们想要的是稳定复现，而不是随机发挥。 */
  temperature?: number;
  /** 单次请求超时，默认 120 秒。网络卡住时不能把整个循环一起卡死。 */
  timeoutMs?: number;
  /**
   * 取消信号。外部取消（CLI 收到 SIGINT）时 abort 它，正在飞的 HTTP 请求会立刻被掐断，
   * 而不是等 120 秒超时。和 timeout 合并成一个 signal 传给 fetch，两者谁先到谁生效。
   */
  signal?: AbortSignal;
}

export class Llm implements ChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(options: LlmOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.signal = options.signal;
  }

  /**
   * 发一轮对话，拿到模型的一条消息。
   *
   * 这里只做三件事：拼请求、检查 HTTP 状态、把响应整理成统一的 Message。
   * 任何「模型说错话」的业务问题（比如参数不合法）都不在这里处理 ——
   * 那是 ToolRegistry 用 ERROR 文本回灌的事，网络层只负责如实搬运。
   *
   * 但「如实搬运」的前提是响应确实是那个形状：网络响应是外部输入，
   * `as` 只是编译期断言，所以这里做一次运行时校验（见 readMessage）。
   */
  async chat(messages: readonly Message[], tools: readonly ToolDefinition[]): Promise<Message> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        // 工具定义要转成协议要求的嵌套结构：{ type: "function", function: {...} }
        tools: tools.map(({ name, description, parameters }) => ({
          type: "function",
          function: { name, description, parameters },
        })),
        // auto：让模型自己决定这一轮是回答还是调工具。
        tool_choice: "auto",
        temperature: this.temperature,
      }),
      // 超时后 fetch 会抛 AbortError，被上层 catch 成一次可见的失败。
      // 外部取消（Ctrl-C）也走 signal：两条路合并，fetch 不用知道是谁按的停止键。
      signal: this.signal ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.signal]) : AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      // 把响应体带上：400 通常就是因为消息顺序/配对错了，错误详情很有价值。
      const detail = (await response.text()).slice(0, 500);
      // 中文对照：模型接口返回 HTTP {状态码}：{响应体}
      throw new Error(`LLM HTTP ${response.status}: ${detail}`);
    }

    return readMessage(await response.json());
  }
}

/** 一条消息读不懂时抛出的错误：前缀统一，便于日志里一眼认出来。 */
function invalid(reason: string): Error {
  // 中文对照：模型响应不合法：{原因}
  return new Error(`LLM response is invalid: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 运行时校验响应形状，并重建一条只含协议字段的 Message。
 *
 * 为什么不能只靠 `as`：服务端返回 `{ choices: [{ message: {} }] }` 时，
 * 断言会让它一路走到底 —— role 是 undefined、content 变成空串、没有 tool_calls，
 * 于是 Agent 认为「模型答完了」，CLI 正常退出。**错误响应被当成了成功响应。**
 *
 * 同时也不原样转发：只挑 role/content/tool_calls/tool_call_id/reasoning_content，
 * 嵌套的 tool_call 也重建一遍，厂商私有字段进不了下一轮请求。
 *
 * finish_reason 也要看：`length` 说明这一轮被截断，`content_filter` 说明内容被拦了。
 * 两种情况都可能带着「看起来正常」的 message，放过去就是拿半截输出当真结果。
 */
function readMessage(payload: unknown): Message {
  const choices = isRecord(payload) ? payload.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) throw invalid("choices must be a non-empty array");

  const first = choices[0];
  if (!isRecord(first)) throw invalid("choices[0] must be an object");
  readFinishReason(first.finish_reason);

  const candidate = first.message;
  if (!isRecord(candidate)) throw invalid("choices[0].message must be an object");

  if (candidate.role !== "assistant") {
    throw invalid(`choices[0].message.role must be "assistant", got ${JSON.stringify(candidate.role)}`);
  }

  // content 是协议的必填字段：缺失和 null 不是一回事 —— null 表示「这一轮只有工具调用」，
  // 而字段整个消失说明服务端吐了个半截响应，得当成错误，不能悄悄补成空串。
  const content = candidate.content;
  if (content !== null && typeof content !== "string") {
    throw invalid("choices[0].message.content must be a string or null");
  }

  const message: Message = { role: "assistant", content: content ?? "" };
  if (candidate.tool_calls !== undefined) message.tool_calls = readToolCalls(candidate.tool_calls);

  const reasoning = candidate.reasoning_content;
  if (reasoning !== undefined) {
    if (typeof reasoning !== "string") throw invalid("choices[0].message.reasoning_content must be a string");
    message.reasoning_content = reasoning;
  }

  return message;
}

/** 只有这两种 finish_reason 算「这一轮正常结束」。 */
function readFinishReason(value: unknown): void {
  if (value === "stop" || value === "tool_calls") return;
  // 中文对照：这一轮被截断了（达到输出上限），内容不完整。
  if (value === "length") throw invalid('finish_reason "length": the response was truncated (max output tokens reached)');
  // 中文对照：这一轮的内容被安全过滤拦下了。
  if (value === "content_filter") throw invalid('finish_reason "content_filter": the response was filtered');
  throw invalid(`unexpected finish_reason ${JSON.stringify(value)}`);
}

/** 逐个校验 tool_call，并重建一份只含 id / type / function.name / function.arguments 的对象。 */
function readToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) throw invalid("choices[0].message.tool_calls must be an array");

  return value.map((raw, index) => {
    if (!isRecord(raw)) throw invalid(`tool_calls[${index}] must be an object`);
    if (typeof raw.id !== "string" || raw.id === "") throw invalid(`tool_calls[${index}].id must be a non-empty string`);
    if (raw.type !== "function") throw invalid(`tool_calls[${index}].type must be "function"`);

    const fn = raw.function;
    if (!isRecord(fn)) throw invalid(`tool_calls[${index}].function must be an object`);
    if (typeof fn.name !== "string" || fn.name === "") {
      throw invalid(`tool_calls[${index}].function.name must be a non-empty string`);
    }
    if (typeof fn.arguments !== "string") throw invalid(`tool_calls[${index}].function.arguments must be a string`);

    return { id: raw.id, type: "function", function: { name: fn.name, arguments: fn.arguments } };
  });
}

/**
 * 模型客户端：一次 chat() 就是一次 HTTP POST {baseUrl}/chat/completions。
 *
 * 只依赖 Node 内置的 fetch，所以这个项目运行时零依赖。
 * 只要端点兼容 OpenAI 的 chat/completions，就能直接换：
 * DeepSeek、Moonshot、OpenAI、Ollama、vLLM……
 */
import type { ChatClient, Message, Tool } from "./types.ts";

export interface LlmOptions {
  /** 形如 https://api.deepseek.com/v1，末尾斜杠会被自动去掉。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 默认 0：做工程任务时，我们想要的是稳定复现，而不是随机发挥。 */
  temperature?: number;
  /** 单次请求超时，默认 120 秒。网络卡住时不能把整个循环一起卡死。 */
  timeoutMs?: number;
}

/** 响应里我们真正用得上的部分；其余字段忽略。 */
interface ChatCompletionResponse {
  choices?: Array<{ message?: Message }>;
}

export class Llm implements ChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(options: LlmOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * 发一轮对话，拿到模型的一条消息。
   *
   * 这里只做三件事：拼请求、检查 HTTP 状态、把响应整理成统一的 Message。
   * 任何「模型说错话」的业务问题（比如参数不合法）都不在这里处理 ——
   * 那是工具层用 ERROR 文本回灌的事，网络层只负责如实搬运。
   */
  async chat(messages: Message[], tools: Tool[]): Promise<Message> {
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
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      // 把响应体带上：400 通常就是因为消息顺序/配对错了，错误详情很有价值。
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`LLM HTTP ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new Error("LLM response is missing choices[0].message");
    }

    // 统一把 content 归一成字符串：协议允许 null（纯工具调用时就是 null），
    // 下游不想每次都判空。
    return { ...message, content: message.content ?? "" };
  }
}

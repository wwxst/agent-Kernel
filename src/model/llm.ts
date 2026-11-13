/**
 * 文件目的：把对话发给模型服务，再把回答拿回来 —— `ChatClient` 唯一的真实实现。
 *
 * 只认一种通用接口格式（chat/completions 那套），所以换别家的模型服务通常只改配置，
 * 不用改代码。测试用假客户端替换它，所以这里所有网络细节都关在这个文件里。
 *
 * 文件职责：负责拼请求、发 HTTP、收完整响应或 SSE 流、把响应校验成 `Message`、读出 usage。
 * 不负责重试与预算（那是 `core/agent.ts`）、不负责展示、不负责拼系统提示。
 *
 * 内容目录：
 *   - `LlmOptions`：地址、Key、模型名、温度、超时、单次输出上限、取消信号、是否流式。
 *   - `Llm`：实现 `ChatClient`；`chat()` 是唯一对外方法，内部按 `stream` 分两条路。
 *   - `StreamAssembly`：流式拼装器，把一串 delta 还原成一条完整消息（按 index 排序，参数分片合并）。
 *   - 响应读取：JSON / SSE 共用 8 MiB 字节上限，完成或失败都主动取消未读响应。
 *   - 内部校验：`readMessage()` / `readToolCalls()` / `readFinishReason()` / `readUsage()`，
 *     形状不对就抛 `ChatResponseError`，绝不返回「空成功」。
 *
 * 模块关系：依赖 `protocol/types.ts`（协议词汇）与 `protocol/errors.ts`（错误类型与文案）。
 * 由 `cli.ts` 创建、`core/agent.ts` 通过 `ChatClient` 接口调用；`eval/run.mjs` 也直接用它。
 */
import { ChatResponseError, ModelConnectionError, ModelHttpError, describeError } from "../protocol/errors.ts";
import type { ChatClient, ChatOptions, ChatResponse, Message, TokenUsage, ToolCall, ToolDefinition } from "../protocol/types.ts";

/** 已知边界：按解压后的响应体累计，包含 SSE 元数据；不依赖服务端遵守 max_tokens。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
   * 单次响应最多生成多少 token，默认 8192。
   *
   * 这是**单次输出**上限，不是任务预算：它防的是一条跑飞的回复把上下文和账单一起撑爆。
   * 请求里的 `max_tokens` 就是它；端点若仍然返回 finish_reason "length"，readMessage 会报错。
   */
  maxOutputTokens?: number;
  /**
   * 取消信号。外部取消（CLI 收到 SIGINT）时 abort 它，正在飞的 HTTP 请求会立刻被掐断，
   * 而不是等 120 秒超时。和 timeout 合并成一个 signal 传给 fetch，两者谁先到谁生效。
   */
  signal?: AbortSignal;
  /**
   * 是否用 SSE 流式接收。默认 false：评测与非交互调用要的是可复现的完整响应。
   * 打开后请求会带 `stream: true` 与 `stream_options.include_usage`，
   * 正文增量通过 `chat(..., { onDelta })` 交出去。
   */
  stream?: boolean;
}

export class Llm implements ChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly signal?: AbortSignal;
  private readonly stream: boolean;

  constructor(options: LlmOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxOutputTokens = options.maxOutputTokens ?? 8192;
    this.signal = options.signal;
    this.stream = options.stream ?? false;
  }

  /**
   * 模型方法 chat（发一轮对话）：把对话发给模型服务，拿回它的一条消息。
   *
   * 这里只做三件事：拼请求、检查 HTTP 状态、把响应整理成统一的 Message。
   * 任何「模型说错话」的业务问题（比如参数不合法）都不在这里处理 ——
   * 那是 ToolRegistry 用 ERROR 文本回灌的事，网络层只负责如实搬运。
   *
   * 但「如实搬运」的前提是响应确实是那个形状：网络响应是外部输入，
   * `as` 只是编译期断言，所以这里做一次运行时校验（见 readMessage）。
   *
   * 流式与非流式的区别只到「怎么收」：两条路最后都走 readMessage，
   * 合法性与归一化只有一份判定。
   */
  async chat(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
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
        // 单次输出去上限：不让一条跑飞的回复把上下文和账单一起撑爆。
        max_tokens: this.maxOutputTokens,
        // 流式才发这两个字段：有的端点对非流式请求收到 stream_options 会直接 400。
        ...(this.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
      // 超时后 fetch 会抛 AbortError，被上层 catch 成一次可见的失败。
      // 外部取消（Ctrl-C）也走 signal：两条路合并，fetch 不用知道是谁按的停止键。
      signal: this.signal ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.signal]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // 真正的用户取消必须保留原有取消语义，不归类成普通连接失败。
      if (this.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new ModelConnectionError(`LLM connection failed: ${describeError(error)}`);
    }

    if (!response.ok) {
      // 把响应体带上：400 通常就是因为消息顺序/配对错了，错误详情很有价值。
      const detail = await readResponseText(response, 500);
      // 中文对照：模型接口返回 HTTP {状态码}：{响应体}
      throw new ModelHttpError(response.status, detail);
    }

    if (this.stream) return this.readStreamed(response, options.onDelta);

    let usage: TokenUsage | undefined;
    try {
      const payload: unknown = JSON.parse(await readResponseText(response));
      // 先读 usage：后面的 message 校验可能失败，但这次请求可能已经产生费用。
      // 顺序反过来，usage 就会随着「响应不合法」一起被丢掉，账上只能记成未知。
      usage = readUsage(payload);
      return { message: readMessage(payload), usage };
    } catch (error) {
      if (this.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new ChatResponseError(describeError(error), usage);
    }
  }

  /**
   * 读 SSE 流：`data: {...}` 一行一个 chunk，`data: [DONE]` 收尾。
   *
   * 三个容易写错的地方：
   *   1. chunk 不保证按行到达 —— 半个 JSON 卡在两个 TCP 包里是常态，所以先攒 buffer 再切行；
   *   2. tool_calls 是分片到达的，按 index 合并 id / name / arguments，不能每片当成一次调用；
   *   3. usage 通常在最后一个 choices 为空的 chunk 里，要单独收，不能跟着 finish_reason 一起丢。
   *
   * 增量回调只用于显示；最终消息仍由拼装结果经过 readMessage 校验后返回 ——
   * 这样流式与非流式走同一套「什么样才算合法响应」的判定。
   */
  private async readStreamed(response: Response, onDelta?: (text: string) => void): Promise<ChatResponse> {
    if (response.body === null) throw new ChatResponseError("LLM response is invalid: stream has no body");

    const decoder = new TextDecoder();
    const assembly = new StreamAssembly();
    let buffer = "";
    let usage: TokenUsage | undefined;
    let finished = false;

    const consume = (line: string): void => {
      if (!line.startsWith("data:")) return;
      const data = line.slice("data:".length).trim();
      if (data === "[DONE]") { finished = true; return; }
      if (data === "") return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        // 已经收到的 usage 要带上：流读到一半失败，这次请求同样可能计费。
        throw new ChatResponseError("LLM response is invalid: stream chunk is not JSON", usage);
      }
      try {
        usage = readUsage(chunk) ?? usage;
        assembly.merge(chunk, onDelta);
      } catch (error) {
        throw new ChatResponseError(describeError(error), usage);
      }
    };

    try {
      for await (const value of readResponseBytes(response)) {
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          consume(line);
          if (finished) break;
          newline = buffer.indexOf("\n");
        }
        if (finished) break;
      }
    } catch (error) {
      if (this.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new ChatResponseError(describeError(error), usage,
        error instanceof ChatResponseError ? error.code : "stream_incomplete");
    }
    // 最后一帧可能没有换行符收尾。
    buffer += decoder.decode();
    if (!finished && buffer.trim() !== "") consume(buffer.trim());

    try {
      return { message: assembly.toMessage(), usage };
    } catch (error) {
      throw new ChatResponseError(
        describeError(error), usage,
        error instanceof ChatResponseError ? error.code : "invalid_response",
      );
    }
  }
}

/** JSON 与 SSE 在同一处限制真实读取量；迭代提前退出或解析抛错时也释放连接。 */
async function* readResponseBytes(response: Response): AsyncGenerator<Uint8Array> {
  if (response.body === null) throw invalid("response has no body");
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        throw new ChatResponseError(`LLM response is invalid: response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      yield value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已失败时 cancel 会重复抛出底层故障；保留读取或解析阶段的原始异常。
    } finally {
      reader.releaseLock();
    }
  }
}

/** 错误详情够用就停，不为取前 500 字符把整份错误页面读完。 */
async function readResponseText(response: Response, maxChars = Infinity): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const bytes of readResponseBytes(response)) {
    text += decoder.decode(bytes, { stream: true });
    if (text.length >= maxChars) break;
  }
  return (text + decoder.decode()).slice(0, maxChars);
}

/**
 * 流式响应的拼装器：把一串 delta 还原成一条完整的 assistant Message。
 *
 * 保留 index 排序：并行调用的参数是交错到达的，按到达顺序拼会得到两条错位的调用。
 * 名字可能一次发全、也可能分片发，所以用 mergeFragment 处理重复与拼接。
 */
class StreamAssembly {
  private content = "";

  private reasoning = "";

  private finishReason: unknown;

  private readonly calls = new Map<number, { id: string; type: string; name: string; arguments: string }>();

  merge(chunk: unknown, onDelta?: (text: string) => void): void {
    if (!isRecord(chunk)) throw invalid("stream chunk must be an object");
    const choices = chunk.choices;
    if (!Array.isArray(choices)) throw invalid("stream chunk choices must be an array");

    // usage-only chunk 的 choices 是空数组：没有 delta 可拼，但 usage 已经在外面读走了。
    const first = choices[0];
    if (first === undefined) return;
    if (!isRecord(first)) throw invalid("stream chunk choices[0] must be an object");

    if (first.finish_reason !== undefined && first.finish_reason !== null) {
      if (typeof first.finish_reason !== "string") throw invalid("stream finish_reason must be a string");
      this.finishReason = first.finish_reason;
    }

    const delta = first.delta;
    if (delta === undefined || delta === null) return;
    if (!isRecord(delta)) throw invalid("stream delta must be an object");

    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== "string") throw invalid("stream delta.content must be a string");
      this.content += delta.content;
      if (delta.content !== "") onDelta?.(delta.content);
    }

    if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
      if (typeof delta.reasoning_content !== "string") {
        throw invalid("stream delta.reasoning_content must be a string");
      }
      this.reasoning += delta.reasoning_content;
    }

    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls)) throw invalid("stream delta.tool_calls must be an array");
      for (const [position, raw] of delta.tool_calls.entries()) {
        this.mergeToolCall(position, raw);
      }
    }
  }

  toMessage(): Message {
    if (this.finishReason === undefined) {
      throw new ChatResponseError("LLM response is invalid: stream ended before the model finished", undefined, "stream_incomplete");
    }

    const message: Record<string, unknown> = { role: "assistant", content: this.content };
    if (this.reasoning !== "") message.reasoning_content = this.reasoning;
    if (this.calls.size > 0) {
      message.tool_calls = [...this.calls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({
          id: call.id,
          type: call.type,
          function: { name: call.name, arguments: call.arguments },
        }));
    }

    // 交给同一个 readMessage：finish_reason 与 tool_calls 的一致性、id 唯一性都在那里判。
    return readMessage({ choices: [{ index: 0, message, finish_reason: this.finishReason }] });
  }

  private mergeToolCall(position: number, raw: unknown): void {
    if (!isRecord(raw)) throw invalid(`stream tool_calls[${position}] must be an object`);

    const index = raw.index;
    if (index !== undefined && (typeof index !== "number" || !Number.isInteger(index) || index < 0)) {
      throw invalid("stream tool_call index must be a non-negative integer");
    }
    // 标准实现会给 index；没给的端点按“本 chunk 里的位置”兜底，至少不会两条调用挤在一起。
    const key = typeof index === "number" ? index : position;
    const call = this.calls.get(key) ?? { id: "", type: "function", name: "", arguments: "" };

    if (raw.id !== undefined) {
      if (typeof raw.id !== "string" || raw.id === "") throw invalid("stream tool_call id must be a non-empty string");
      if (call.id !== "" && call.id !== raw.id) throw invalid(`stream tool_call ${key} changed id mid-stream`);
      call.id = raw.id;
    }
    if (raw.type !== undefined && raw.type !== "function") throw invalid('stream tool_call type must be "function"');

    const fn = raw.function;
    if (fn !== undefined) {
      if (!isRecord(fn)) throw invalid("stream tool_call function must be an object");
      if (fn.name !== undefined) {
        if (typeof fn.name !== "string") throw invalid("stream tool_call function.name must be a string");
        call.name = mergeFragment(call.name, fn.name);
      }
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== "string") throw invalid("stream tool_call function.arguments must be a string");
        call.arguments += fn.arguments;
      }
    }

    this.calls.set(key, call);
  }
}

/**
 * 名字可能一次发全，也可能分片发；有的端点还会把完整名字重复发一遍。
 * 完全相同的重复不拼接，其余一律当成新片段接上。
 */
function mergeFragment(current: string, fragment: string): string {
  if (fragment === "" || fragment === current) return current;
  return current + fragment;
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
 *
 * finish_reason 还决定这一轮**该不该有**工具调用，两者必须一致：
 *   - `stop` + 非空 tool_calls：Agent 会去执行工具，但端点说这一轮已经结束了；
 *   - `tool_calls` + 空 tool_calls：Agent 会当成最终答复，丢掉端点声称发生的调用。
 * 两种都是协议自相矛盾，按错误响应处理，不能「猜一个」继续跑。
 */
function readMessage(payload: unknown): Message {
  const choices = isRecord(payload) ? payload.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) throw invalid("choices must be a non-empty array");

  const first = choices[0];
  if (!isRecord(first)) throw invalid("choices[0] must be an object");
  const finishReason = readFinishReason(first.finish_reason);

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

  const toolCalls = candidate.tool_calls === undefined ? [] : readToolCalls(candidate.tool_calls);
  if (finishReason === "tool_calls" && toolCalls.length === 0) {
    throw invalid('finish_reason "tool_calls" requires a non-empty tool_calls array');
  }
  if (finishReason === "stop" && toolCalls.length > 0) {
    throw invalid('finish_reason "stop" must not include tool_calls');
  }

  const message: Message = { role: "assistant", content: content ?? "" };
  // 空数组不写进 Message：它就是「没有工具调用」，和字段缺失同义。
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const reasoning = candidate.reasoning_content;
  if (reasoning !== undefined) {
    if (typeof reasoning !== "string") throw invalid("choices[0].message.reasoning_content must be a string");
    message.reasoning_content = reasoning;
  }

  return message;
}

/** 只有这两种 finish_reason 算「这一轮正常结束」；返回值用来和 tool_calls 做一致性校验。 */
function readFinishReason(value: unknown): "stop" | "tool_calls" {
  if (value === "stop" || value === "tool_calls") return value;
  // 中文对照：这一轮被截断了（达到输出上限），内容不完整。
  if (value === "length") throw invalid('finish_reason "length": the response was truncated (max output tokens reached)');
  // 中文对照：这一轮的内容被安全过滤拦下了。
  if (value === "content_filter") throw invalid('finish_reason "content_filter": the response was filtered');
  throw invalid(`unexpected finish_reason ${JSON.stringify(value)}`);
}

/** 逐个校验 tool_call，并重建一份只含 id / type / function.name / function.arguments 的对象。 */
function readToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) throw invalid("choices[0].message.tool_calls must be an array");

  // 重复 id 会让 tool 结果无法唯一配对：两条 result 都指向同一个 id，
  // 后续请求要么被 API 拒绝，要么让模型看见一条错位的结果。
  const seenIds = new Set<string>();

  return value.map((raw, index) => {
    if (!isRecord(raw)) throw invalid(`tool_calls[${index}] must be an object`);
    if (typeof raw.id !== "string" || raw.id === "") throw invalid(`tool_calls[${index}].id must be a non-empty string`);
    if (seenIds.has(raw.id)) throw invalid(`tool_calls[${index}].id duplicates "${raw.id}"`);
    seenIds.add(raw.id);
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

/**
 * 读 usage：有就逐字段校验，没有就返回 undefined（未知）。
 *
 * 为什么不「缺字段就补 0」：那会让预算和成本统计显示成「花了 0 token」，
 * 比没有统计更危险 —— 调用方会以为预算还有富余。缺了就是不知道。
 * 但「有 usage 却字段类型不对」是端点在违反协议，必须报错，不能悄悄当成未知。
 */
function readUsage(payload: unknown): TokenUsage | undefined {
  const usage = isRecord(payload) ? payload.usage : undefined;
  if (usage === undefined || usage === null) return undefined;
  if (!isRecord(usage)) throw invalid("usage must be an object");

  return {
    prompt_tokens: readTokenCount(usage, "prompt_tokens"),
    completion_tokens: readTokenCount(usage, "completion_tokens"),
    total_tokens: readTokenCount(usage, "total_tokens"),
  };
}

/** usage 里的 token 数必须是非负整数；小数、负数、字符串都不是「用法」。 */
function readTokenCount(usage: Record<string, unknown>, field: string): number {
  const value = usage[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid(`usage.${field} must be a non-negative integer`);
  }
  return value;
}

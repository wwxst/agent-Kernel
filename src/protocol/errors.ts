/**
 * 文件目的：把「意外」变成一句说清了原因的错误话，并给错误分好类。
 *
 * 为什么单独拿出来：出错时不能只丢一个空消息。空的错误最坑人 ——
 * 模型看到一片空白，只能瞎猜，重试也没有方向。
 *
 * 放在一个地方，是为了让工具箱和命令行用同一套说法。两处各写一套还互相矛盾，
 * 比出错本身更难查。
 *
 * 文件职责：负责错误类型、错误分类、可重试判断、兜底文案。
 * 不负责决定「抛还是折成文本」（那是各层自己的规矩，见规范第 5 节），
 * 也不负责排版展示（只给标题、建议、详情三段素材）。
 *
 * 内容目录：
 *   - `describeError()`：把任何抛出来的东西变成一句非空、能看懂的话。
 *   - `ChatResponseError`：模型响应形状非法，可带上端点已经算过的 usage。
 *   - `ModelConfigError`：环境变量不完整或仍是占位值，必须在发请求前拒绝。
 *   - `ModelHttpError` / `ModelConnectionError`：上游返回了状态码 / 连不上。
 *   - `isRetryableModelError()`：能不能重试。
 *   - `isContextOverflowError()`：是不是「输入超过模型上下文窗口」，这是唯一允许做压缩恢复的错误。
 *   - `modelFailure()`：给展示层用的错误分类（标题 + 建议 + 详情），不改异常本体。
 *   - `ProcessCleanupError`：进程树没停干净，必须结束整轮，不能当普通失败重试。
 *
 * 模块关系：依赖 `protocol/types.ts`（`ChatResponseError` 要带 `TokenUsage`）。
 * 被 `core/agent.ts`、`core/tool-registry.ts`、`model/llm.ts`、`tools/workspace.ts`、
 * `cli.ts`、`ui/tui.ts` 与 `eval/diagnostics.mjs` 使用。
 */
import type { TokenUsage } from "./types.ts";

/**
 * 模型响应形状非法时抛出的错误，可以带上端点已经返回的 usage。
 *
 * 「响应读不懂」不等于「这次请求没花钱」：端点可能正常算了钱，只是 message 不合法。
 * 把 usage 一起带出来，Core 才能把这次请求记成已知成本；否则只能记成未知（或者更糟，记成 0）。
 * 放在 errors.ts 是因为 ChatClient 的任何实现都可能抛它，而 Agent 只依赖 types/errors。
 */
export class ChatResponseError extends Error {
  readonly usage?: TokenUsage;
  readonly code: "invalid_response" | "stream_incomplete";

  constructor(message: string, usage?: TokenUsage, code: "invalid_response" | "stream_incomplete" = "invalid_response") {
    super(message);
    this.name = "ChatResponseError";
    this.usage = usage;
    this.code = code;
  }
}

/** 环境变量不完整或仍是示例占位值：必须在发请求前拒绝。 */
export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

/** HTTP 状态只代表上游的事实；404 可能是模型名或接口路径，不猜测是哪一个。 */
export class ModelHttpError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`LLM HTTP ${status}: ${detail}`);
    this.name = "ModelHttpError";
    this.status = status;
  }
}

/** 网络连接失败；与用户取消和无效的 SSE 响应严格区分。 */
export class ModelConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModelConnectionError";
  }
}

/** 错误工具 isRetryableModelError（能不能重试）：只重试还没开始流式输出的暂时网络或服务故障；鉴权失败、找不到、响应格式异常一律禁止重放。 */
export function isRetryableModelError(error: unknown): boolean {
  return error instanceof ModelConnectionError ||
    (error instanceof ModelHttpError &&
      (error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600)));
}

/**
 * 错误工具 isContextOverflowError（是不是上下文超限）：只认「输入太长，模型装不下」这一种失败。
 *
 * 为什么要单独认：超限可以靠压缩救一次，而普通 400（消息顺序错、参数错）、网络故障、
 * 输出被截断（`finish_reason: "length"`）都不能靠压缩救 —— 把它们混进来只会白花一次请求，
 * 或者把「请求本身写错了」伪装成「上下文太大」。
 *
 * 判定依据只能是上游给的文字：这个协议没有统一的错误码。所以先卡状态码（400/413/422），
 * 再看详情里有没有窗口相关的措辞。文案不匹配就当作普通失败 —— 宁可少恢复一次，
 * 也不要对着无关错误反复压缩。
 */
export function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof ModelHttpError)) return false;
  if (error.status !== 400 && error.status !== 413 && error.status !== 422) return false;
  const detail = error.message;
  return /context[ _-]?(length|window|limit)/i.test(detail) ||
    /maximum context/i.test(detail) ||
    /context[ _-]?overflow/i.test(detail) ||
    /too many tokens/i.test(detail) ||
    /prompt is too long/i.test(detail) ||
    /input is too long/i.test(detail) ||
    /exceed(s|ed)?[^.]{0,40}(token|context)/i.test(detail);
}

/**
 * 错误工具 modelFailure（错误分类）：显示层的错误分类，不改异常本体，也不参与核心决策。
 * 技术详情保留 describeError 的原文；界面只在能确认类别时给出对应的修复建议。
 */
export function modelFailure(error: unknown, language: "zh" | "en"): {
  title: string;
  advice: string;
  detail: string;
} | undefined {
  let kind: "config" | "auth" | "not_found" | "http" | "network" | "stream" | "invalid";
  if (error instanceof ModelConfigError) kind = "config";
  else if (error instanceof ModelHttpError) {
    kind = error.status === 401 || error.status === 403 ? "auth"
      : error.status === 404 ? "not_found" : "http";
  } else if (error instanceof ModelConnectionError) kind = "network";
  else if (error instanceof ChatResponseError) kind = error.code === "stream_incomplete" ? "stream" : "invalid";
  else return undefined;

  const adviceByKind = {
    config: {
      zh: "请填写有效的 API_KEY，并检查 .env 中的 MODEL / BASE_URL。",
      en: "Set a valid API_KEY and check MODEL / BASE_URL in .env.",
    },
    auth: {
      zh: "请检查 API Key、服务商及账号权限。",
      en: "Check your API key, provider, and account permissions.",
    },
    not_found: {
      zh: "请检查 MODEL 名称及 BASE_URL；HTTP 404 无法单独确定是哪一项。",
      en: "Check MODEL and BASE_URL; HTTP 404 alone cannot identify which is wrong.",
    },
    http: {
      zh: "请检查服务商返回的状态码和技术详情。",
      en: "Check the provider status code and technical details.",
    },
    network: {
      zh: "请检查网络、BASE_URL 和模型服务是否可用。",
      en: "Check the network, BASE_URL, and provider availability.",
    },
    stream: {
      zh: "已收到部分响应，但缺少完成标记；此前显示的草稿已作废，不能作为最终回复。请重试或检查流式协议兼容性。",
      en: "The stream ended without a completion marker; any previously shown preview is discarded, not a confirmed reply. Retry or check streaming compatibility.",
    },
    invalid: {
      zh: "服务返回的数据不符合预期；此前显示的增量草稿已作废，不能作为最终回复；请检查接口兼容性。",
      en: "The provider returned unexpected data; any previously shown preview is discarded, not a confirmed reply. Check API compatibility.",
    },
  } as const;
  // UI 只保留三种终态 + 运行中的重连状态；内部细分类型和原始详情仍完整保留。
  const title = kind === "config"
    ? (language === "zh" ? "未配置模型" : "Model not configured")
    : kind === "auth"
      ? (language === "zh" ? "模型认证失败" : "Model authentication failed")
      : (language === "zh" ? "模型服务不可用" : "Model service unavailable");
  return { title, advice: adviceByKind[kind][language], detail: describeError(error) };
}

/** 进程树停止失败：后台进程可能仍有副作用，必须结束当前 Agent Run，而非正常重试。 */
export class ProcessCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessCleanupError";
  }
}

/**
 * 从最常见的情况往下逐层兜底：`Error` 取 message、字符串原样、`null` 与原始值给明确说明、
 * 对象尽量序列化。空对象和空数组序列化出来是 `"{}"` / `"[]"`，等于没说，继续往下落。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) return message;
    // `throw new Error()` 的 message 是空串，但 name 至少是 "Error"。
    return error.name.trim() || "Unknown error";
  }

  if (typeof error === "string") {
    const message = error.trim();
    return message.length > 0 ? message : "Unknown error (empty string thrown)";
  }

  if (error === null) return "Unknown error (null)";

  if (typeof error === "object") {
    try {
      // 空对象/空数组序列化成 "{}"/"[]"，等于没说，继续往下落。
      const json = JSON.stringify(error);
      if (json !== undefined && json !== "{}" && json !== "[]") return json;
    } catch {
      // 循环引用、BigInt 之类：序列化本身失败，落到下面的兜底。
    }
  } else if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }

  return `Unknown error (${typeof error})`;
}

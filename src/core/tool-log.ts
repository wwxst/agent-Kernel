/**
 * 文件目的：把每次工具调用记成一行 JSON，追加进一个文件 —— 事后能查「哪次调用、成没成、为什么失败」。
 *
 * 为什么它长这样：它是 Hooks 机制的第一个真实用户，用来回答「v1 那个挂点到底够不够用」。
 * 结论是够：只登记两个后置事件就能写出一份可读的调用记录，工具实现、`ToolRegistry.executeWithStatus`、
 * Agent 循环都不用为它改一行。已知缺口写在下面「文件职责」里，没有藏着。
 *
 * 文件职责：负责把一次调用写成一行的形状、字段截断、**尽力脱敏**、写不进去时提醒一次。
 * 不负责 Hook 的执行顺序与故障隔离（那是 `core/tool-hooks.ts`）、不负责判断工具成没成
 * （失败事件直接来自 `isError`；成功事件只用 `core/tool-result-status.ts` 兜底原始文本）、
 * 不负责日志轮转与查询（这就是一个只追加的文件，清理归用户）、不负责改工具结果（它只读）。
 *
 * 已知边界：只记**执行完**的调用。被前置 Hook 拦下的调用不会留下记录 —— 它没有执行，
 * 也就没有结果；要审计「谁想跑但被拦了」，得让前置 Hook 自己写，那是另一件事。
 *
 * 已知边界：脱敏是**尽力而为**，不是保证。它靠正则识别常见的凭据字段、token 前缀与
 * `NAME=value` 赋值，猜不到的格式会原样落盘；所以日志仍然要当成敏感文件对待（POSIX 上 0600）。
 *
 * 内容目录：
 *   - `MAX_LOG_FIELD_CHARS`：参数与结果各自最多记多少字符，超出截断并标明截掉多少。
 *   - `createToolLogHooks()`：造两个后置回调（成功、失败），返回**登记项**而不是现成的 `ToolHooks` ——
 *     调用方可以把它和别的事件拼在一起，再交给 `new ToolHooks(...)`。
 *   - 内部：`ToolLogRecord` 一行日志的形状、`redact()` 递归脱敏、`clip()` 截断、
 *     `append()` 落盘（0600 + 「只提醒一次」）。
 *
 * 模块关系：依赖 `node:fs` / `node:path`、`protocol/errors.ts`（`describeError`）、
 * `core/tool-hooks.ts`（只有类型）与 `core/tool-result-status.ts`（成没成的唯一口径）。
 * 由 `cli.ts` 在 `AGENT_TOOL_LOG` 有值时装配；`test/tool-log.test.mjs` 用临时文件测它。
 */
import { closeSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { describeError } from "../protocol/errors.ts";
import type { ToolHooksOptions, ToolUseContext } from "./tool-hooks.ts";
import { isToolResultFailure } from "./tool-result-status.ts";

/** 单个字段（参数 / 结果）最多记这么多字符：日志是线索，不是存档。 */
export const MAX_LOG_FIELD_CHARS = 2_000;

/** 递归脱敏的深度上限与每个容器保留的元素数。超出时留可见标记，不静默丢。 */
const MAX_REDACT_DEPTH = 8;
const MAX_REDACT_ITEMS = 100;

/** 一行日志。字段名短而固定，方便直接用 `jq` 或脚本读。 */
interface ToolLogRecord {
  ts: number;
  /** 工具名。 */
  tool: string;
  /** 调用 id：同一批调用里靠它和 Transcript 的 tool 消息对上。 */
  id: string;
  /** 成功与否。内置工具由宿主侧 `isError` 决定；`isToolResultFailure` 的文本兜底只服务只拿得到文本的调用方。 */
  ok: boolean;
  /** 参数（已尽力脱敏、已截断）。 */
  args: string;
  /** 成功时是结果原文，失败时是错误原因（都已尽力脱敏、已截断）。 */
  detail: string;
}

/**
 * 凭据字段名的口径：字段名（以及 `NAME=value` 里的 NAME）命中它，整个值就替换成 `[REDACTED]`。
 * 用子串匹配而不是整词：`OPENAI_API_KEY`、`AWS_SECRET_ACCESS_KEY`、`client_secret` 都要覆盖。
 * 已知边界：`secret` 会顺带命中 `secretary` 这类普通词，这是尽力而为的代价。
 */
const CREDENTIAL_NAME = "api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|" +
  "authorization|cookie|credential|private[_-]?key|client[_-]?secret";
const CREDENTIAL_KEY = new RegExp(CREDENTIAL_NAME, "i");

/**
 * `NAME=value` / `NAME: value`：NAME 命中凭据口径时保留名字、只换值。
 * 值可能是引号包起来的，也可能以 `Bearer` / `Basic` 开头；把整段都换掉，避免留下半个 token。
 * 值遇到空白、引号、逗号或右括号就停，所以一句话里的其他内容不会被顺带吞掉。
 *
 * NAME 前后的字符数有上限（64）：无上限的通配加中间固定词会让长 base64 串上的回溯变成平方级，
 * 而真实的凭据字段名远远短于 64。
 */
const CREDENTIAL_ASSIGNMENT = new RegExp(
  "([\"']?)(\\b[A-Za-z0-9_.-]{0,64}(?:" + CREDENTIAL_NAME + ")[A-Za-z0-9_.-]{0,64})\\1(\\s*[:=]\\s*)" +
    "(?:(?:Bearer|Basic)\\s+)?(?:\"[^\"\\n]*\"|'[^'\\n]*'|[^\\s\"';,)]+)",
  "gi",
);

/** 裸的 `Bearer` / `Basic` 认证头：没有字段名可依，只换掉后面的 token。 */
const AUTH_SCHEME_TOKEN = /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/** 常见服务的 token 前缀：这些值形态本身就是凭据，和字段名叫什么无关。 */
const TOKEN_PREFIX = /\b(?:github_pat_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9._-]{8,}|AKIA[A-Z0-9]{8,})/g;

/** PEM 私钥块：没有 `END`（日志被截断或输出不完整）时一直脱到字符串末尾，宁可比需要的多盖一点。 */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** 字符串值的脱敏：先盖私钥块，再处理带字段名的赋值与裸 token，避免规则互相留下残片。 */
function redactText(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY, "[REDACTED PRIVATE KEY]")
    .replace(CREDENTIAL_ASSIGNMENT, "$1$2$1$3[REDACTED]")
    .replace(AUTH_SCHEME_TOKEN, "$1 [REDACTED]")
    .replace(TOKEN_PREFIX, "[REDACTED]");
}

/**
 * 对本地诊断日志中的凭据做尽力脱敏，不改动工具实际返回内容。
 *
 * 两条路：字段名命中凭据口径就整段替换；字符串值再按 token 形态做正则替换。
 * 已知边界：正则认不出的格式会原样保留，不能把这里当安全边界。
 */
function redact(value: unknown, key = "", depth = 0): unknown {
  if (CREDENTIAL_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (depth >= MAX_REDACT_DEPTH) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_REDACT_ITEMS).map((item) => redact(item, "", depth + 1));
    if (value.length > MAX_REDACT_ITEMS) kept.push(`[+${value.length - MAX_REDACT_ITEMS} more items]`);
    return kept;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const kept = entries.slice(0, MAX_REDACT_ITEMS).map(([childKey, child]) =>
      [childKey, redact(child, childKey, depth + 1)] as const);
    if (entries.length > MAX_REDACT_ITEMS) {
      kept.push(["[TRUNCATED]", `[+${entries.length - MAX_REDACT_ITEMS} more keys]`] as const);
    }
    // 用 fromEntries 而不是逐键赋值：JSON 里的 `__proto__` 不会改写返回对象的原型。
    return Object.fromEntries(kept);
  }
  return value;
}

/** 超长就截断并写明截掉多少：静默截断会让人以为「日志里就这么多」。 */
function clip(text: string): string {
  if (text.length <= MAX_LOG_FIELD_CHARS) return text;
  return `${text.slice(0, MAX_LOG_FIELD_CHARS)}… (+${text.length - MAX_LOG_FIELD_CHARS} chars)`;
}

/**
 * 造一组写工具调用日志的 Hook 登记项。
 *
 * 只登记两个后置事件：成功写一行、失败也写一行，两者的字段完全一样，读日志时不用分情况。
 * 返回登记项而不是现成的 `ToolHooks`，是为了能拼：`new ToolHooks({ ...createToolLogHooks(file), preToolUse })`。
 * 一个工厂返回一个组装好的执行器，就没法再往里加别的事件了。
 *
 * `ok` 不能只看「有没有抛异常」：内置 `shell` 的前台非零退出、超时、取消现在带着
 * 宿主侧 `isError:true` 进来，直接走失败事件；成功事件里的 `isToolResultFailure`
 * 只给「拿不到宿主状态、只有原始文本」的调用方兜底。两条路口径一致：
 * 一条 `exit 3` 的命令不会被记成成功，事后复盘时结论也不会正好相反。
 *
 * 写盘是同步追加（和输入历史同一套做法）：一行日志的代价远小于一次工具调用，
 * 异步排队反而会引入「进程退出时最后几行还没落盘」的问题。
 * POSIX 上用 0600 打开并收紧已有文件：日志可能含敏感内容，和后台任务日志、输入历史口径一致。
 *
 * 写不进去时**不抛**：日志失败不该让工具结果变形，也不该算成 Hook 的 bug。
 * 但也不能一声不响 —— 第一次失败往 stderr 说一句，之后闭嘴，免得刷屏。
 */
export function createToolLogHooks(file: string): ToolHooksOptions {
  let warned = false;

  const append = (context: ToolUseContext, ok: boolean, detail: string): void => {
    const redactedDetail = redact(detail);
    const record: ToolLogRecord = {
      ts: Date.now(),
      tool: context.call.function.name,
      id: context.call.id,
      ok,
      args: clip(JSON.stringify(redact(context.args))),
      detail: clip(typeof redactedDetail === "string" ? redactedDetail : JSON.stringify(redactedDetail)),
    };
    const line = `${JSON.stringify(record)}\n`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // mode 只在新建文件时生效；已有文件要靠 fchmod 收紧，不能假设它本来是 0600。
      // 已知边界：Windows 忽略 POSIX mode，权限由 NTFS ACL 决定。
      const fd = openSync(file, "a", 0o600);
      try {
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (warned) return;
      warned = true;
      process.stderr.write(`[tool-log] cannot write ${file}: ${describeError(error)}\n`);
    }
  };

  return {
    postToolUse: [(context) => {
      append(context, !isToolResultFailure(context.call, context.result), context.result);
    }],
    postToolUseFailure: [(context) => {
      append(context, false, describeError(context.error));
    }],
  };
}

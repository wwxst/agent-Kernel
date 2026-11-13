/**
 * 文件目的：把每次工具调用记成一行 JSON，追加进一个文件 —— 事后能查「哪次调用、成没成、为什么失败」。
 *
 * 为什么它长这样：它是 Hooks 机制的第一个真实用户，用来回答「v1 那个挂点到底够不够用」。
 * 结论是够：只登记两个后置事件就能写出一份可读的调用记录，工具实现、`ToolRegistry.execute`、
 * Agent 循环都不用为它改一行。已知缺口写在下面「文件职责」里，没有藏着。
 *
 * 文件职责：负责把一次调用写成一行的形状、字段截断、写不进去时提醒一次。
 * 不负责 Hook 的执行顺序与故障隔离（那是 `core/tool-hooks.ts`）、不负责判断工具成没成
 * （复用 `core/tool-result-status.ts`，和 CLI / TUI 同一套口径）、不负责日志轮转与查询
 * （这就是一个只追加的文件，清理归用户）、不负责改工具结果（它只读）。
 *
 * 已知边界：只记**执行完**的调用。被前置 Hook 拦下的调用不会留下记录 —— 它没有执行，
 * 也就没有结果；要审计「谁想跑但被拦了」，得让前置 Hook 自己写，那是另一件事。
 *
 * 内容目录：
 *   - `MAX_LOG_FIELD_CHARS`：参数与结果各自最多记多少字符，超出截断并标明截掉多少。
 *   - `createToolLogHooks()`：造两个后置回调（成功、失败），返回**登记项**而不是现成的 `ToolHooks` ——
 *     调用方可以把它和别的事件拼在一起，再交给 `new ToolHooks(...)`。
 *   - 内部：`ToolLogRecord` 一行日志的形状、`clip()` 截断、`append()` 落盘与「只提醒一次」。
 *
 * 模块关系：依赖 `node:fs` / `node:path`、`protocol/errors.ts`（`describeError`）、
 * `core/tool-hooks.ts`（只有类型）与 `core/tool-result-status.ts`（成没成的唯一口径）。
 * 由 `cli.ts` 在 `AGENT_TOOL_LOG` 有值时装配；`test/tool-log.test.mjs` 用临时文件测它。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { describeError } from "../protocol/errors.ts";
import type { ToolHooksOptions, ToolUseContext } from "./tool-hooks.ts";
import { isToolResultFailure } from "./tool-result-status.ts";

/** 单个字段（参数 / 结果）最多记这么多字符：日志是线索，不是存档。 */
export const MAX_LOG_FIELD_CHARS = 2_000;

/** 一行日志。字段名短而固定，方便直接用 `jq` 或脚本读。 */
interface ToolLogRecord {
  ts: number;
  /** 工具名。 */
  tool: string;
  /** 调用 id：同一批调用里靠它和 Transcript 的 tool 消息对上。 */
  id: string;
  /** 成功与否。口径与 CLI / TUI 一致（`isToolResultFailure`）：`shell` 非零退出、超时、取消也算失败。 */
  ok: boolean;
  /** 参数原文（已截断）。 */
  args: string;
  /** 成功时是结果原文，失败时是错误原因（都已截断）。 */
  detail: string;
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
 * `ok` 不能只看「有没有抛异常」：`shell` 不抛异常，它用退出码报告失败。
 * 所以这里复用 `isToolResultFailure` —— 和 CLI / TUI 标 ✗ 用的是同一套判断，
 * 否则日志会把一条 `exit 3` 的命令记成成功，事后复盘时结论正好相反。
 *
 * 写盘是同步追加（和输入历史同一套做法）：一行日志的代价远小于一次工具调用，
 * 异步排队反而会引入「进程退出时最后几行还没落盘」的问题。
 *
 * 写不进去时**不抛**：日志失败不该让工具结果变形，也不该算成 Hook 的 bug。
 * 但也不能一声不响 —— 第一次失败往 stderr 说一句，之后闭嘴，免得刷屏。
 */
export function createToolLogHooks(file: string): ToolHooksOptions {
  let warned = false;

  const append = (context: ToolUseContext, ok: boolean, detail: string): void => {
    const record: ToolLogRecord = {
      ts: Date.now(),
      tool: context.call.function.name,
      id: context.call.id,
      ok,
      args: clip(JSON.stringify(context.args)),
      detail: clip(detail),
    };
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
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

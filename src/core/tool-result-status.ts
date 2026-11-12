/**
 * 文件目的：回答一个纯展示问题 —— 这次工具调用到底成没成功。
 *
 * 界面要靠这个事实决定一段结果是标红还是标绿；但工具结果文本本身不能因此被改动，
 * 模型读到的必须还是原文。所以判断单独放在这里，只产出「是 / 否」，不产出文本。
 *
 * 文件职责：负责从工具结果里读出成功或失败这一个事实。
 * 不负责改文本、不负责上色、不负责决定怎么展示 —— 那是 CLI 与 TUI 各自的事。
 *
 * 内容目录：
 *   - `isToolResultFailure()`：唯一导出，只看第一行非空内容。
 *   - 判定口径：普通工具看 `ERROR:` 前缀；`shell` 另看退出码（非 0 或 `null`）、超时、被取消。
 *     只有 `shell` 走特殊判断：命令有自己的退出状态；而普通文件内容里恰好写着「退出码 7」，
 *     不能当成失败。
 *
 * 模块关系：依赖 `protocol/types.ts` 的 `ToolCall`（需要工具名）。
 * 被 `ui/cli-presenter.ts` 与 `ui/tui.ts` 调用；`core/agent.ts` 不参与判断。
 */
import type { ToolCall } from "../protocol/types.ts";

/** 返回工具调用是否失败；普通工具的 ERROR: 与 Shell 的退出状态遵循同一事实口径。 */
export function isToolResultFailure(call: ToolCall, result: string): boolean {
  const first = result.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  if (first.startsWith("ERROR:")) return true;
  if (call.function.name !== "shell") return false;

  // exit 0 才是成功；null / 非零退出码，以及超时和取消，都必须给出失败标记。
  return (
    (/^exit (?:-?\d+|null)$/.test(first) && first !== "exit 0") ||
    /^timeout after \d+ms$/.test(first) ||
    first === "cancelled by signal"
  );
}

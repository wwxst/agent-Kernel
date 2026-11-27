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
 *   - `isToolResultFailure()`：唯一导出。ToolRegistry 传来的 `isError` 是**权威**失败信号，
 *     为真直接返回；其余情况只对 `shell` 保留一条原始文本兜底。
 *   - 文本兜底：调用方只拿得到结果文本（没有宿主状态）时，`shell` 的第一行是
 *     非 0 / `null` 退出码、超时或被取消就算失败。这是**兼容路径**，新代码不要依赖它，
 *     应当直接传 `executeWithStatus().isError`。
 *
 * 模块关系：依赖 `protocol/types.ts` 的 `ToolCall`（需要工具名）。
 * 被 `ui/cli-presenter.ts`、`ui/tui.ts` 与 `core/tool-log.ts` 调用；`core/agent.ts` 不参与判断。
 */
import type { ToolCall } from "../protocol/types.ts";

/**
 * 失败状态以 ToolRegistry 的 `isError` 为准；为假时才看 `shell` 的原始文本。
 *
 * 保留文本兜底的原因：有些调用方（既有 UI 与直接读结果的测试）手里只有文本，
 * 没有宿主侧状态可传；删掉它会让 `exit 3` 被当成成功。它只是兼容路径，
 * 不是第二套判定标准 —— 新代码传 `isError`，不要让文本重新变成事实来源。
 */
export function isToolResultFailure(call: ToolCall, result: string, isError = false): boolean {
  if (isError) return true;
  if (call.function.name !== "shell") return false;
  const first = result.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  return (
    (/^exit (?:-?\d+|null)$/.test(first) && first !== "exit 0") ||
    /^timeout after \d+ms$/.test(first) ||
    first === "cancelled by signal"
  );
}

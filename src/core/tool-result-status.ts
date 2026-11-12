/**
 * 工具结果在协议里仍是纯文本；这里仅供展示层判断失败，不修改回灌给模型的内容。
 *
 * Shell 的第一行是 Workspace.run() 产生的状态（exit N / timeout / cancelled）。
 * 只针对 Shell 解释状态，避免 read 到以 "exit 7" 开头的文件时误报失败。
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

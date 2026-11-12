/**
 * 文件目的：记住用户以前输入过什么，下次按上下键能翻出来。
 *
 * 输入历史跨进程要还在，所以落盘；但它是便利功能，不是数据 —— 文件坏了也不能让程序起不来。
 *
 * 文件职责：负责读历史、追加一条历史、决定文件放在哪。
 * 不负责输入框里的按键处理与去重（那是 `ui/tui.ts` 的事），也不负责清理旧文件。
 *
 * 内容目录：
 *   - `MAX_HISTORY_ENTRIES`：只留最近 500 条，历史是给上下键用的，不是存档。
 *   - `historyPath()`：默认 `~/.agent-kernel/history.jsonl`，`AGENT_HISTORY_FILE` 可覆盖（测试用）。
 *   - `loadHistory()`：读历史，最新的排在后面（输入框要的是反过来的顺序，调用方自己反转）。
 *   - `appendHistory()`：追加一条历史。
 *   - 内部：`MAX_ENTRY_CHARS` 单条 4000 字符上限、`HistoryRecord` 记录形状（时间、目录、文本）。
 *
 * 模块关系：只依赖 `node:fs`、`node:os`、`node:path`。
 * 被 `ui/tui.ts` 调用；`test/prompt-history.test.mjs` 用环境变量指向临时文件来测。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 只保留最近这么多条：历史是给上下键用的，不是存档。 */
export const MAX_HISTORY_ENTRIES = 500;

/** 单条上限：粘贴进来的长任务不该把历史文件撑爆。 */
const MAX_ENTRY_CHARS = 4_000;

interface HistoryRecord {
  ts: number;
  cwd: string;
  text: string;
}

/** 默认路径：`~/.agent-kernel/history.jsonl`；`AGENT_HISTORY_FILE` 可覆盖（测试用）。 */
export function historyPath(): string {
  const override = process.env.AGENT_HISTORY_FILE;
  if (override !== undefined && override !== "") return override;
  return path.join(homedir(), ".agent-kernel", "history.jsonl");
}

/**
 * 界面函数 loadHistory（读历史）：读取历史，返回最新的在后的数组（和输入框的顺序相反，调用方自己反转）。
 *
 * 坏行、非字符串、空文本全部跳过；文件不存在或读不了就返回空数组。
 */
export function loadHistory(file = historyPath(), limit = MAX_HISTORY_ENTRIES): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // 半行写入、手工编辑、磁盘满——都只影响这一条，不能让整份历史作废。
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const text = (record as Partial<HistoryRecord>).text;
    if (typeof text !== "string" || text.trim() === "") continue;
    texts.push(text);
  }
  return texts.slice(-limit);
}

/** 界面函数 appendHistory（存一条历史）：追加一条。目录不存在就建；写失败不影响当前会话。 */
export function appendHistory(text: string, cwd: string, file = historyPath()): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const record: HistoryRecord = {
    ts: Date.now(),
    cwd,
    text: trimmed.length > MAX_ENTRY_CHARS ? trimmed.slice(0, MAX_ENTRY_CHARS) : trimmed,
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

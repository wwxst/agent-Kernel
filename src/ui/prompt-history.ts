/**
 * 跨进程的输入历史。
 *
 * 两家同类产品都这么存：一条 prompt 一行 JSONL，启动时读回喂给 readline 的历史栈。
 * Codex 的 `~/.codex/history.jsonl` 有过「文件损坏导致启动失败」的 issue，
 * 所以这里的解析必须逐行容错：坏行跳过，整份文件读不出来也只是「没有历史」。
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
 * 读取历史，返回**最新的在后**的数组（和 readline 的顺序相反，调用方自己反转）。
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

/** 追加一条。目录不存在就建；写失败不影响当前会话。 */
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

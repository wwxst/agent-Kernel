/**
 * 文件目的：记住用户以前输入过什么，下次按上下键能翻出来。
 *
 * 输入历史跨进程要还在，所以落盘；但它是便利功能，不是数据 —— 文件坏了也不能让程序起不来。
 *
 * 文件职责：负责读历史、追加一条历史、跨进程串行化追加，以及安全轮转磁盘文件。
 * 不负责输入框里的按键处理与去重（那是 `ui/tui.ts` 的事）。
 *
 * 内容目录：
 *   - `MAX_HISTORY_ENTRIES`：只留最近 500 条。
 *   - `historyPath()`：默认 `~/.agent-kernel/history.jsonl`，`AGENT_HISTORY_FILE` 可覆盖。
 *   - `loadHistory()`：有界读取文件尾部，从后向前选取有效记录。
 *   - `appendHistory()`：带跨进程锁追加；超过磁盘上限时原子轮转到最近 500 条。
 *   - 内部：锁文件带 PID/token，死进程遗留锁可回收；临时文件 fsync 后 rename。
 *
 * 模块关系：只依赖 Node 内置 fs、crypto、os、path。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 只保留最近这么多条：历史是给上下键用的，不是存档。 */
export const MAX_HISTORY_ENTRIES = 500;

/** 单条上限：粘贴进来的长任务不该把历史文件撑爆。 */
const MAX_ENTRY_CHARS = 4_000;
const MAX_CWD_CHARS = 512;

/** 文件本身也有硬上限；轮转后最多 500 条，每条最多 16 KB。 */
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 16_000;

/** 并发追加最多等 250ms；历史是便利功能，不能让 TUI 长时间卡住。 */
const LOCK_ATTEMPTS = 50;
const LOCK_WAIT_MS = 5;
/** 只有锁文件足够旧且持有进程已退出时才回收，避免抢走仍在轮转的活锁。 */
const STALE_LOCK_MS = 30_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

interface HistoryRecord {
  ts: number;
  cwd: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 默认路径：`~/.agent-kernel/history.jsonl`；`AGENT_HISTORY_FILE` 可覆盖（测试用）。 */
export function historyPath(): string {
  const override = process.env.AGENT_HISTORY_FILE;
  if (override !== undefined && override !== "") return override;
  return path.join(homedir(), ".agent-kernel", "history.jsonl");
}

/** 只接收结构完整的记录；坏行不会被轮转复制到新文件。 */
function parseRecords(raw: string): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!isRecord(value) || typeof value.text !== "string" || value.text.trim() === "") continue;
    records.push({
      ts: typeof value.ts === "number" && Number.isFinite(value.ts) ? value.ts : 0,
      cwd: typeof value.cwd === "string" ? value.cwd.slice(0, MAX_CWD_CHARS) : "",
      text: value.text.slice(0, MAX_ENTRY_CHARS),
    });
  }
  return records;
}

/** 生成有界 JSONL 记录；控制字符转义过长时继续缩短正文，保证单条也有硬上限。 */
function serializeRecord(record: HistoryRecord): Buffer {
  let text = record.text.slice(0, MAX_ENTRY_CHARS);
  const cwd = record.cwd.slice(0, MAX_CWD_CHARS);
  for (;;) {
    const line = Buffer.from(JSON.stringify({ ts: record.ts, cwd, text }) + "\n", "utf8");
    if (line.byteLength <= MAX_RECORD_BYTES) return line;
    if (text.length === 0) throw new Error("history record metadata exceeds the size limit");
    text = text.slice(0, Math.max(0, Math.floor(text.length * 0.75)));
  }
}

/** writeSync 允许短写；循环写满，不能把半条 JSONL 留在文件尾部。 */
function writeFully(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("history write made no progress");
    offset += written;
  }
}

/** 从文件句柄读取有界尾部；切口落在半行时丢掉第一行残片。 */
function readTail(fd: number, size: number): string {
  const length = Math.min(size, MAX_HISTORY_BYTES);
  const start = Math.max(0, size - length);
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < buffer.length) {
    const bytes = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
    if (bytes === 0) break;
    offset += bytes;
  }
  let raw = buffer.subarray(0, offset).toString("utf8");
  if (start > 0) {
    const newline = raw.indexOf("\n");
    raw = newline === -1 ? "" : raw.slice(newline + 1);
  }
  return raw;
}

function lockIsStale(lockPath: string): boolean {
  try {
    const info = lstatSync(lockPath);
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
    let owner: unknown;
    try { owner = JSON.parse(readFileSync(lockPath, "utf8")); } catch { return true; }
    if (!isRecord(owner) || typeof owner.pid !== "number" || !Number.isInteger(owner.pid)) return true;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

/** 只在确认锁持有进程已经退出后回收，并复核 inode，避免误删刚被替换的新锁。 */
function removeStaleLock(lockPath: string): void {
  try {
    const before = lstatSync(lockPath);
    if (!lockIsStale(lockPath)) return;
    const current = lstatSync(lockPath);
    if (before.dev !== current.dev || before.ino !== current.ino) return;
    unlinkSync(lockPath);
  } catch {
    // 另一个进程可能已经回收；下一轮重新尝试获取锁。
  }
}

function acquireLock(file: string): string | undefined {
  const lockPath = file + ".lock";
  const token = randomUUID();
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      writeFully(fd, Buffer.from(JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), "utf8"));
      fsyncSync(fd);
      closeSync(fd);
      return token;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* preserve acquisition error */ }
        try { unlinkSync(lockPath); } catch { /* another process may have cleaned it */ }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      removeStaleLock(lockPath);
      Atomics.wait(waitCell, 0, 0, LOCK_WAIT_MS);
    }
  }
  return undefined;
}

function releaseLock(file: string, token: string): void {
  const lockPath = file + ".lock";
  try {
    const owner: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (isRecord(owner) && owner.token === token) unlinkSync(lockPath);
  } catch {
    // 锁文件可能已被清理；不能让可选的历史记录影响当前会话。
  }
}

/** 有界读取，坏行、非字符串、空文本全部跳过；文件不存在或读不了就返回空数组。 */
export function loadHistory(file = historyPath(), limit = MAX_HISTORY_ENTRIES): string[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  let raw: string;
  try {
    const fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) return [];
      raw = readTail(fd, stats.size);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  return parseRecords(raw).slice(-Math.floor(limit)).map((record) => record.text);
}

/**
 * 追加一条历史。锁保护「检查大小 → 追加/轮转」整个事务，避免两个进程同时压缩时互相覆盖。
 * 写失败只返回 false，不影响当前会话；锁最多等待 250ms。
 */
export function appendHistory(text: string, cwd: string, file = historyPath()): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const record: HistoryRecord = {
    ts: Date.now(),
    cwd: cwd.slice(0, MAX_CWD_CHARS),
    text: trimmed.slice(0, MAX_ENTRY_CHARS),
  };
  let directory: string;
  try {
    directory = path.dirname(file);
    mkdirSync(directory, { recursive: true });
  } catch {
    return false;
  }

  const token = acquireLock(file);
  if (token === undefined) return false;
  try {
    const line = serializeRecord(record);
    const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW, 0o600);
    let closed = false;
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) return false;
      if (stats.size + line.byteLength <= MAX_HISTORY_BYTES) {
        writeFully(fd, line);
        return true;
      }

      const records = parseRecords(readTail(fd, stats.size));
      records.push(record);
      let kept = records.slice(-MAX_HISTORY_ENTRIES);
      let encoded = kept.map(serializeRecord);
      let total = encoded.reduce((sum, item) => sum + item.byteLength, 0);
      while (total > MAX_HISTORY_BYTES && kept.length > 1) {
        kept = kept.slice(1);
        encoded = kept.map(serializeRecord);
        total = encoded.reduce((sum, item) => sum + item.byteLength, 0);
      }
      if (total > MAX_HISTORY_BYTES) throw new Error("one history record exceeds the rotation limit");

      const temporary = path.join(directory, ".history-" + randomUUID() + ".tmp");
      const tempFd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      try {
        for (const item of encoded) writeFully(tempFd, item);
        fsyncSync(tempFd);
      } finally {
        closeSync(tempFd);
      }
      closeSync(fd);
      closed = true;
      try {
        renameSync(temporary, file);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* preserve rename error */ }
        throw error;
      }
      return true;
    } finally {
      if (!closed) closeSync(fd);
    }
  } catch {
    return false;
  } finally {
    releaseLock(file, token);
  }
}

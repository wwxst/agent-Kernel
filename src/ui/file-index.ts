/**
 * 文件目的：把工作区里的文件列成一张清单，给输入框的 `@` 补全用。
 *
 * 补全是为了让人少打字。它只认文件名，不读文件内容 —— 真要搜内容，那是搜索工具的事，
 * 在这里做只会又慢又不准。
 *
 * 文件职责：负责递归列路径、按片段过滤排序、短暂缓存结果。
 * 不负责搜文件内容，不负责读文件，也不负责把结果画到屏幕上（那是 `ui/tui.ts`）。
 *
 * 内容目录：
 *   - `MAX_INDEXED_FILES`：最多索引 2000 个，再多也不适合在一个下拉里选。
 *   - `listWorkspaceFiles()`：递归列出相对路径，跳过 `.git` / `node_modules` 这类目录，5 秒缓存。
 *   - `matchFiles()`：按搜索片段筛选候选文件。
 *   - `resetFileIndexCache()`：清缓存，只给测试用。
 *   - 内部：`SKIP_DIRS`、`CACHE_TTL_MS`、`cache`。
 *
 * 模块关系：只依赖 `node:fs` 与 `node:path`。
 * 被 `ui/tui.ts` 的 `@` 补全调用；`test/file-index.test.mjs` 覆盖过滤与缓存行为。
 */
import { opendirSync } from "node:fs";
import path from "node:path";

/** 遍历时直接跳过的目录：它们只会把候选列表淹掉。 */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  ".agent",
]);

/** 最多索引这么多文件：再多也不适合在一个下拉里选。 */
export const MAX_INDEXED_FILES = 2_000;

/** 缓存有效期：用户可能在会话中途新建文件，但不必每次按键都重扫磁盘。 */
const CACHE_TTL_MS = 5_000;
const MAX_SCANNED_ENTRIES = 20_000;
const MAX_DIRECTORY_DEPTH = 32;
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  at: number;
  files: string[];
}

const cache = new Map<string, CacheEntry>();

/** 界面函数 listWorkspaceFiles（列文件清单）：递归列出工作区里的文件（相对路径），有数量上限，跳过常见的大目录。 */
export function listWorkspaceFiles(root: string, limit = MAX_INDEXED_FILES): string[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const boundedLimit = Math.min(MAX_INDEXED_FILES, Math.floor(limit));
  const key = JSON.stringify([path.resolve(root), boundedLimit]);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.files.slice();
  }

  const files: string[] = [];
  let scanned = 0;
  const walk = (relative: string, depth: number): void => {
    if (files.length >= boundedLimit || scanned >= MAX_SCANNED_ENTRIES || depth > MAX_DIRECTORY_DEPTH) return;
    let directory;
    try {
      directory = opendirSync(path.join(root, relative));
    } catch {
      return;
    }
    try {
      for (;;) {
        if (files.length >= boundedLimit || scanned >= MAX_SCANNED_ENTRIES) return;
        let entry;
        try {
          entry = directory.readSync();
        } catch {
          return;
        }
        if (entry === null) return;
        scanned++;
        const child = relative === "" ? entry.name : path.posix.join(relative, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(child, depth + 1);
        } else if (entry.isFile()) {
          files.push(child);
        }
      }
    } finally {
      try { directory.closeSync(); } catch { /* preserve the original scan result */ }
    }
  };
  walk("", 0);

  files.sort();
  cache.set(key, { at: now, files });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return files.slice();
}

/** 界面函数 matchFiles（按名字过滤）：按片段过滤并排序——文件名完全一样 > 文件名开头一样 > 文件名里包含 > 路径里包含，同档短的优先。 */
export function matchFiles(files: readonly string[], fragment: string, limit = 20): string[] {
  const needle = fragment.toLowerCase();
  if (needle === "") return files.slice(0, limit);
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (base === needle) score = 0;
    else if (base.startsWith(needle)) score = 1;
    else if (base.includes(needle)) score = 2;
    else if (lower.includes(needle)) score = 3;
    else continue;
    scored.push({ file, score });
  }
  // 同分时短的优先：根目录的 package.json 要排在 eval/fixtures/.../package.json 前面。
  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((item) => item.file);
}

/** 测试用：清掉缓存，避免用例之间互相影响。 */
export function resetFileIndexCache(): void {
  cache.clear();
}

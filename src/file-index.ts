/**
 * 工作区文件索引：给 `@` 补全用。
 *
 * 只做「列出来 + 前缀过滤」，不做模糊打分：路径补全的价值是**避免猜文件名**，
 * 不是替用户搜代码内容。真要搜内容，模型有 grep 工具。
 */
import { readdirSync } from "node:fs";
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

interface CacheEntry {
  at: number;
  files: string[];
}

const cache = new Map<string, CacheEntry>();

/** 递归列出工作区文件（相对路径，正斜杠），有界且跳过常见重目录。 */
export function listWorkspaceFiles(root: string, limit = MAX_INDEXED_FILES): string[] {
  const cached = cache.get(root);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.files;

  const files: string[] = [];
  const walk = (relative: string): void => {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      // 读不到（权限、刚被删）就当这层没有文件：补全不能因为一个目录失败而整体失效。
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(child);
        continue;
      }
      if (entry.isFile()) files.push(child);
    }
  };
  walk("");

  files.sort();
  cache.set(root, { at: now, files });
  return files;
}

/** 按片段过滤并排序：文件名精确 > 文件名前缀 > 文件名包含 > 路径包含，同档短的优先。 */
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

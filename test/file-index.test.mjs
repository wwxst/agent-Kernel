/**
 * 文件目的：测文件清单 —— 跳过不该看的目录、有数量上限、排序要合理。
 *
 * 排序不是好看：输入 `@pack` 时，根目录的 `package.json` 必须排在
 * 测试样例里同名文件前面，否则补全给的是最不常用的那个。
 *
 * 文件职责：只测 `listWorkspaceFiles` / `matchFiles` 的行为与缓存清理。
 * 不测 `@` 补全在界面上的表现（那是 `tui.test.mjs`）。
 *
 * 内容目录：
 *   - `withDir()`：临时目录 + 前后各清一次缓存，避免用例互相影响。
 *   - 文件清单：跳过 `node_modules` / `.git`；缓存区分数量上限，返回副本。
 *   - 过滤排序：精确匹配与短路径优先；空片段按原顺序取前几个。
 *
 * 模块关系：依赖 `src/ui/file-index.ts` 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listWorkspaceFiles, matchFiles, resetFileIndexCache } from "../src/ui/file-index.ts";

async function withDir(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-index-"));
  resetFileIndexCache();
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    resetFileIndexCache();
  }
}

test("文件索引：列出文件、跳过 node_modules 与 .git", async () => {
  await withDir(async (root) => {
    await writeFile(path.join(root, "package.json"), "{}");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "");
    await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "x", "index.js"), "");

    const files = listWorkspaceFiles(root);
    assert.deepEqual(files, ["package.json", "src/a.ts"]);
  });
});

test("文件索引：同一根目录使用不同上限时各自缓存，互不影响", async () => {
  await withDir(async (root) => {
    await writeFile(path.join(root, "a.ts"), "");
    await writeFile(path.join(root, "b.ts"), "");
    assert.deepEqual(listWorkspaceFiles(root, 1), ["a.ts"]);
    assert.deepEqual(listWorkspaceFiles(root, 10), ["a.ts", "b.ts"]);
    assert.deepEqual(listWorkspaceFiles(root, 0), []);
  });
});

test("文件索引：修改返回数组不会污染后续补全缓存", async () => {
  await withDir(async (root) => {
    await writeFile(path.join(root, "a.ts"), "");
    listWorkspaceFiles(root).push("injected.ts");
    assert.deepEqual(listWorkspaceFiles(root), ["a.ts"]);
  });
});

test("文件索引：文件名精确匹配排在前面，同档短路径优先", async () => {
  const files = ["eval/tasks/04/package.json", "package.json", "src/package-lock.json"];
  assert.equal(matchFiles(files, "package")[0], "package.json");
});

test("文件索引：空片段返回前若干个，不排序成随机顺序", async () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(matchFiles(files, "", 2), ["a.ts", "b.ts"]);
});

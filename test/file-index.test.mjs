/**
 * 文件索引：跳过重目录、有界、排序合理。
 *
 * 排序不是装饰：`@pack` 必须优先给根目录的 package.json，而不是 fixtures 里同名的那份。
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

test("文件索引：文件名精确匹配排在前面，同档短路径优先", async () => {
  const files = ["eval/tasks/04/package.json", "package.json", "src/package-lock.json"];
  assert.equal(matchFiles(files, "package")[0], "package.json");
});

test("文件索引：空片段返回前若干个，不排序成随机顺序", async () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(matchFiles(files, "", 2), ["a.ts", "b.ts"]);
});

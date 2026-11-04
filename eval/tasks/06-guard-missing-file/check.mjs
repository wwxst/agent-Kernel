import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { load } = await import(pathToFileURL(path.join(root, "load.mjs")).href);

  let missing;
  try {
    missing = load(path.join(root, "does-not-exist.txt"));
  } catch (error) {
    // 初始实现会直接把 ENOENT 抛出来；这是任务要修的 bug，用断言说清楚。
    assert.fail(`文件不存在时 load 抛错了：${error.message}`);
  }
  assert.equal(missing, null, "文件不存在时应该返回 null");

  const existing = path.join(root, "config.json");
  await writeFile(existing, '{"ok":true}', "utf8");
  assert.equal(load(existing), await readFile(existing, "utf8"), "存在的文件应该照常返回内容");
}

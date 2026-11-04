import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { load } = await import(pathToFileURL(path.join(root, "load.mjs")).href);

  assert.equal(load(path.join(root, "does-not-exist.txt")), null, "文件不存在时应该返回 null");

  const existing = path.join(root, "config.json");
  await writeFile(existing, '{"ok":true}', "utf8");
  assert.equal(load(existing), await readFile(existing, "utf8"), "存在的文件应该照常返回内容");
}

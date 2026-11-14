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
    if (error?.code === "ENOENT") assert.fail(`文件不存在时 load 抛出了 ENOENT：${error.message}`);
    throw error;
  }
  assert.equal(missing, null, "文件不存在时应该返回 null");

  const existing = path.join(root, "config.json");
  await writeFile(existing, '{"ok":true}', "utf8");
  assert.equal(load(existing), await readFile(existing, "utf8"), "存在的文件应该照常返回内容");

  // 只有 ENOENT 可以被转换成 null；目录、权限、设备等真实 I/O 错误不能被吞掉。
  const directory = path.join(root, "directory");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
  assert.throws(
    () => load(directory),
    (error) => error?.code === "EISDIR" || error?.code === "EPERM" || error?.code === "EACCES",
    "目录或不可读目标不能被误当成文件不存在",
  );
}

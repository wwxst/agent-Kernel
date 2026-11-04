import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { validateName, validateTitle } = await import(pathToFileURL(path.join(root, "validate.mjs")).href);

  assert.equal(validateName("ok"), null);
  assert.match(validateName(""), /name/);
  assert.match(validateName(1), /name/);
  assert.match(validateName("x".repeat(41)), /name/);

  assert.equal(validateTitle("ok"), null);
  assert.match(validateTitle(""), /title/);
  assert.match(validateTitle(null), /title/);
  assert.match(validateTitle("x".repeat(41)), /title/);

  // 重复的三段校验应该只剩一份。
  const source = await readFile(path.join(root, "validate.mjs"), "utf8");
  assert.equal((source.match(/must be a string/g) ?? []).length <= 1, true, "校验逻辑没有抽成共享函数");
}

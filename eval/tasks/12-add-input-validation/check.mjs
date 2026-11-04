import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { setAge } = await import(pathToFileURL(path.join(root, "user.mjs")).href);

  const rejected = {};
  assert.equal(setAge(rejected, -1), false, "负数应该被拒绝");
  assert.equal(setAge(rejected, 1.5), false, "小数应该被拒绝");
  assert.equal(setAge(rejected, "30"), false, "字符串应该被拒绝");
  assert.equal("age" in rejected, false, "被拒绝时不该写入 user");

  const accepted = {};
  assert.equal(setAge(accepted, 0), true, "0 是合法的");
  assert.equal(accepted.age, 0);
  assert.equal(setAge(accepted, 30), true, "30 是合法的");
  assert.equal(accepted.age, 30);
}

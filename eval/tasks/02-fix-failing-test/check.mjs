import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { sum } = await import(pathToFileURL(path.join(root, "sum.mjs")).href);

  assert.equal(sum([]), 0, "空数组应该是 0");
  assert.equal(sum([1, 2, 3]), 6, "1+2+3 应该是 6");
  assert.equal(sum([5]), 5, "单个元素应该原样返回");

  // 防作弊：测试文件不能被动过。
  const tests = await readFile(path.join(root, "sum.test.mjs"), "utf8");
  assert.match(tests, /sum\(\[1, 2, 3\]\), 6/, "测试文件被改动了");
}

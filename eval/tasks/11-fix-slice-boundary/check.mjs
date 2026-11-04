import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { firstN } = await import(pathToFileURL(path.join(root, "list.mjs")).href);

  assert.deepEqual(firstN([1, 2, 3], 2), [1, 2], "取前 2 个");
  assert.deepEqual(firstN([1, 2, 3], 0), [], "n 为 0 时应该是空数组");
  assert.deepEqual(firstN([1], 5), [1], "n 超过长度时返回全部");
  assert.deepEqual(firstN([], 3), [], "空数组");
}

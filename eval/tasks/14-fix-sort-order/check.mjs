import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { byScore } = await import(pathToFileURL(path.join(root, "rank.mjs")).href);

  assert.deepEqual(byScore([1, 10, 5]), [10, 5, 1], "应该从高到低");

  const input = [3, 1, 2];
  byScore(input);
  assert.deepEqual(input, [3, 1, 2], "不应该修改传入的数组");
}

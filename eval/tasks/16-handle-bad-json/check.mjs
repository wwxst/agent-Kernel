import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { handle } = await import(pathToFileURL(path.join(root, "handler.mjs")).href);

  assert.deepEqual(handle('{"a":1}'), { status: 200, body: { a: 1 } }, "合法 JSON 行为不变");
  assert.deepEqual(handle("{oops"), { status: 400, body: { error: "invalid json" } }, "坏 JSON 应该返回 400");
  assert.deepEqual(handle(""), { status: 400, body: { error: "invalid json" } }, "空 body 也应该返回 400");
}

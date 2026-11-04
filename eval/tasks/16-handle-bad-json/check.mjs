import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 调用 handle，并把「抛错」翻译成断言失败：抛错本身就是这个任务要修的行为。 */
function handleOrFail(handle, body) {
  try {
    return handle(body);
  } catch (error) {
    assert.fail(`handle(${JSON.stringify(body)}) 抛错了：${error.message}`);
  }
}

export default async function check(root) {
  const { handle } = await import(pathToFileURL(path.join(root, "handler.mjs")).href);

  assert.deepEqual(handleOrFail(handle, '{"a":1}'), { status: 200, body: { a: 1 } }, "合法 JSON 行为不变");
  assert.deepEqual(handleOrFail(handle, "{oops"), { status: 400, body: { error: "invalid json" } }, "坏 JSON 应该返回 400");
  assert.deepEqual(handleOrFail(handle, ""), { status: 400, body: { error: "invalid json" } }, "空 body 也应该返回 400");
}

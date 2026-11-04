import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { handle } = await import(pathToFileURL(path.join(root, "server.mjs")).href);

  assert.deepEqual(handle("/health"), { status: 200, body: { status: "ok" } }, "/health 的响应不对");
  assert.deepEqual(handle("/"), { status: 200, body: { name: "demo" } }, "根路由被改坏了");
  assert.deepEqual(handle("/users"), { status: 200, body: [{ id: 1 }] }, "/users 被改坏了");
  assert.equal(handle("/nope").status, 404, "未知路径必须还是 404");
}

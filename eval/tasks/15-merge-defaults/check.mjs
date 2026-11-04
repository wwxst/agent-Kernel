import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { createConfig } = await import(pathToFileURL(path.join(root, "config.mjs")).href);

  const first = createConfig({ retries: 5 });
  assert.equal(first.retries, 5, "传入值应该覆盖默认值");
  assert.equal(first.timeoutMs, 1000, "没传的字段应该用默认值");

  const second = createConfig({});
  assert.equal(second.retries, 3, "默认值被上一次调用改掉了");

  const input = { verbose: true };
  const third = createConfig(input);
  assert.equal(third.verbose, true);
  assert.deepEqual(input, { verbose: true }, "不应该修改 input");
  assert.notEqual(first, second, "每次都应该返回新对象");
}

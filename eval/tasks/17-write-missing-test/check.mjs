import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function check(root) {
  const testFile = path.join(root, "slug.test.mjs");
  const source = await readFile(testFile, "utf8");

  assert.match(source, /node:test/, "测试要用 node:test");
  assert.equal((source.match(/test\(/g) ?? []).length >= 3, true, "至少三个用例");

  const result = await run(process.execPath, ["--test", "slug.test.mjs"], { cwd: root });
  assert.match(result.stdout, /pass \d+/, "测试应该跑起来");
}

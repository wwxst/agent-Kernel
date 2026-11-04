import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function check(root) {
  const testFile = path.join(root, "slug.test.mjs");
  let source;
  try {
    source = await readFile(testFile, "utf8");
  } catch {
    // 任务要求新建测试文件：文件不存在是「还没做」，用断言表达。
    assert.fail("slug.test.mjs 不存在");
  }

  assert.match(source, /node:test/, "测试要用 node:test");
  assert.equal((source.match(/test\(/g) ?? []).length >= 3, true, "至少三个用例");

  const result = await run(process.execPath, ["--test", "slug.test.mjs"], { cwd: root });
  assert.match(result.stdout, /pass \d+/, "测试应该跑起来");
}

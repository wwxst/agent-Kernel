import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function runTests(directory) {
  try {
    return await run(process.execPath, ["--test", "slug.test.mjs"], { cwd: directory });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    assert.fail(`生成的测试没有全部通过：\n${output}`);
  }
}

export default async function check(root) {
  const testFile = path.join(root, "slug.test.mjs");
  let source;
  try {
    source = await readFile(testFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") assert.fail("slug.test.mjs 不存在");
    throw error;
  }

  assert.match(source, /node:test/, "测试要用 node:test");
  assert.match(source, /assert\.(?:equal|strictEqual|deepEqual|match|throws|doesNotThrow)/, "测试必须包含行为断言");
  assert.ok((source.match(/\btest\s*\(/g) ?? []).length >= 3, "至少三个用例");

  const result = await runTests(root);
  assert.match(result.stdout, /# pass 3\b/, "必须恰好跑完三个测试用例");
  assert.match(result.stdout, /# fail 0\b/, "测试必须全部通过");

  // Mutation testing：将正确实现分别替换为三个单点错误实现，测试必须能抓住每一种回归。
  const original = await readFile(path.join(root, "slug.mjs"), "utf8");
  const temp = await mkdtemp(path.join(os.tmpdir(), "slug-mutation-"));
  try {
    await writeFile(path.join(temp, "slug.test.mjs"), source, "utf8");
    const mutants = [
      `export function slugify(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, "-"); }\n`,
      `export function slugify(text) { return text.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, ""); }\n`,
      `export function slugify(text) { return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "empty"; }\n`,
    ];
    for (let index = 0; index < mutants.length; index++) {
      await writeFile(path.join(temp, "slug.mjs"), mutants[index], "utf8");
      let rejected = false;
      try {
        await run(process.execPath, ["--test", "slug.test.mjs"], { cwd: temp });
      } catch {
        rejected = true;
      }
      assert.ok(rejected, `测试未能发现第 ${index + 1} 种错误实现`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
    // 原任务目录从未被改写；保留读取以确保原实现存在且可用。
    assert.ok(original.length > 0, "slug.mjs 必须存在");
  }
}

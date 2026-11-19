import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// 直接从 `node --test` 进程启动另一个 `node --test` 会被 Node 24 标记为递归并跳过。
// 先启动普通 `node -e` 中转，再由中转进程启动测试，既保留 stdout/stderr，也绕开运行器上下文注入。
const TEST_LAUNCHER = [
  "const { spawnSync } = require('node:child_process');",
  "const child = spawnSync(process.execPath, ['--test', 'slug.test.mjs'], { encoding: 'utf8' });",
  "process.stdout.write(child.stdout ?? '');",
  "process.stderr.write(child.stderr ?? '');",
  "process.exit(child.status ?? 1);",
].join(" ");

async function runTests(directory) {
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    return await run(process.execPath, ["-e", TEST_LAUNCHER], { cwd: directory, env });
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
  const passed = /(?:#|ℹ) pass (\d+)\b/.exec(result.stdout);
  assert.ok(passed !== null && Number(passed[1]) >= 3, "至少三个测试用例必须全部通过");
  assert.match(result.stdout, /(?:#|ℹ) fail 0\b/, "测试必须全部通过");

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
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        await run(process.execPath, ["-e", TEST_LAUNCHER], { cwd: temp, env });
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

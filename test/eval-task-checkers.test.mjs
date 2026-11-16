/**
 * 文件目的：验证评测任务检查器不会把符合题意的正确答案误判为失败。
 *
 * 文件职责：覆盖 Markdown 表格解析，以及「至少三个测试」而非「恰好三个测试」的判定。
 * 不负责运行完整评测或联系模型（那是 `eval/run.mjs` 和 `eval.test.mjs`）。
 *
 * 内容目录：
 *   - Task 04：正常 Markdown 表格能列出全部 npm scripts。
 *   - Task 17：四个有效测试用例仍通过检查，并且三个变异实现都被拒绝。
 *
 * 模块关系：依赖 `eval/tasks/04-create-doc/check.mjs`、`eval/tasks/17-write-missing-test/check.mjs` 与 Node 内置模块；由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import checkCreateDoc from "../eval/tasks/04-create-doc/check.mjs";

test("评测题 04：正常 Markdown 表格能识别全部 npm scripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-task-04-check-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "node --test", lint: "eslint ." },
    }));
    await writeFile(path.join(root, "docs", "usage.md"), [
      "# 用法",
      "",
      "| 命令 | 说明 |",
      "| --- | --- |",
      "| `npm test` | 运行测试 |",
      "| `npm run lint` | 检查代码 |",
      "",
    ].join("\n"));
    await writeFile(path.join(root, "README.md"), "# 项目\n\n[使用说明](docs/usage.md)\n");

    await assert.doesNotReject(() => checkCreateDoc(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("评测题 17：满足三种要求的同时允许额外测试用例", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-task-17-check-"));
  try {
    await writeFile(path.join(root, "slug.mjs"), [
      "export function slugify(text) {",
      "  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
      "}",
      "",
    ].join("\n"));
    await writeFile(path.join(root, "slug.test.mjs"), [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { slugify } from './slug.mjs';",
      "test('普通句子', () => assert.equal(slugify('Hello World'), 'hello-world'));",
      "test('首尾空格', () => assert.equal(slugify('  Hello World  '), 'hello-world'));",
      "test('空字符串', () => assert.equal(slugify(''), ''));",
      "test('连续标点', () => assert.equal(slugify('Hello,  World!'), 'hello-world'));",
      "",
    ].join("\n"));

    const checkerUrl = new URL("../eval/tasks/17-write-missing-test/check.mjs", import.meta.url).href;
    const script = `import check from ${JSON.stringify(checkerUrl)}; await check(${JSON.stringify(root)});`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * 文件目的：测「评测自检」自己 —— 它最容易犯的错，是把「检查器崩了」当成「这个任务本来就该失败」。
 *
 * 这里造出各种情况，钉死三种结论：正常、任务无效、工具出问题。
 *
 * 文件职责：只测 `runSelfcheck()` 的分类判断。
 * 不测真实评测任务是否出得对（那是 `eval:check` 干的事）。
 *
 * 内容目录：
 *   - `withTasks()` / `addTask()`：临时任务目录，`files/` 必须是现成的目录（真实任务都有）。
 *   - 六个用例：断言失败 → 正常；初始就通过 → 任务无效；抛非断言错误 → 工具问题；
 *     依赖缺失 → 工具问题；`check.mjs` 加载失败 → 工具问题；没有默认导出 → 任务无效。
 *
 * 模块关系：依赖 `eval/selfcheck.mjs` 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSelfcheck, SELFCHECK_BROKEN, SELFCHECK_INFRA, SELFCHECK_OK } from "../eval/selfcheck.mjs";

/** 每个用例一个临时评测目录；任务目录的 files/ 必须是现成的空目录（真实任务都有）。 */
async function withTasks(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-selfcheck-test-"));
  const tasksDir = path.join(root, "tasks");
  await mkdir(tasksDir);
  try {
    return await fn(tasksDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addTask(tasksDir, name, checkSource) {
  const taskDir = path.join(tasksDir, name);
  await mkdir(path.join(taskDir, "files"), { recursive: true });
  await writeFile(path.join(taskDir, "check.mjs"), checkSource, "utf8");
}

test("selfcheck：断言失败 = 预期内的初始失败", async () => {
  await withTasks(async (tasksDir) => {
    await addTask(
      tasksDir,
      "a-assert",
      'import assert from "node:assert/strict";\nexport default async function check() { assert.fail("还没做"); }\n',
    );

    const [result] = await runSelfcheck(tasksDir);

    assert.equal(result.status, SELFCHECK_OK);
  });
});

test("selfcheck：初始状态直接通过 = 任务无效（BROKEN）", async () => {
  await withTasks(async (tasksDir) => {
    await addTask(tasksDir, "b-passes", "export default async function check() {}\n");

    const [result] = await runSelfcheck(tasksDir);

    assert.equal(result.status, SELFCHECK_BROKEN);
    assert.match(result.detail, /初始状态就已经通过/);
  });
});

test("selfcheck：检查器抛非断言错误 = 基础设施错误（INFRA）", async () => {
  await withTasks(async (tasksDir) => {
    await addTask(
      tasksDir,
      "c-type-error",
      'export default async function check() { throw new TypeError("checker bug"); }\n',
    );

    const [result] = await runSelfcheck(tasksDir);

    assert.equal(result.status, SELFCHECK_INFRA);
    assert.match(result.detail, /检查器抛出了非断言错误/);
  });
});

test("selfcheck：检查器依赖缺失 = 基础设施错误（INFRA）", async () => {
  await withTasks(async (tasksDir) => {
    await addTask(
      tasksDir,
      "d-missing-dep",
      'export default async function check() { await import("./missing-helper.mjs"); }\n',
    );

    const [result] = await runSelfcheck(tasksDir);

    assert.equal(result.status, SELFCHECK_INFRA);
    assert.match(result.detail, /非断言错误/);
  });
});

test("selfcheck：check.mjs 加载失败 = 基础设施错误（INFRA）", async () => {
  await withTasks(async (tasksDir) => {
    await addTask(tasksDir, "e-import-error", 'import "./missing-helper.mjs";\nexport default async function check() {}\n');

    const [result] = await runSelfcheck(tasksDir);

    assert.equal(result.status, SELFCHECK_INFRA);
    assert.match(result.detail, /check\.mjs 加载失败/);
  });
});

test("selfcheck：没有默认导出函数 = 任务无效（BROKEN）", async () => {
  await withTasks(async (tasksDir) => {
    await addTask(tasksDir, "f-no-export", "export const something = 1;\n");

    const [result] = await runSelfcheck(tasksDir);

    assert.equal(result.status, SELFCHECK_BROKEN);
    assert.match(result.detail, /没有默认导出函数/);
  });
});

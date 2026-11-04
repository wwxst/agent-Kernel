/**
 * 评测自检自身的单元测试：它最容易犯的错，是把「检查器崩了」当成「初始状态确实失败」。
 * 这里用临时任务目录造出五种情况，钉死 ok / broken / infra 三类结果。
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

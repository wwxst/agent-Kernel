/**
 * 文件目的：测「评测工具」自己 —— 检查器里如果有个异步任务没等就跑了，
 * 必须把整轮判成「工具坏了」，而不是在成绩单上留一个假的「通过」。
 *
 * 文件职责：验证一轮评测的错误分类与收尾；异步错误隔离通过子进程跑真实夹具验证。
 * 不测具体任务的判分、不测模型表现。
 *
 * 内容目录：
 *   - `runFixture()`：用子进程跑 `test/support/eval-floating-check.mjs`，读它最后一行 JSON。
 *   - `withRoundFixture()`：临时任务与假 HTTP 端点，验证并发首错收尾、网络分类、夹具复制失败清理。
 *   - 异步错误：没有泄漏时整轮通过；有泄漏时任务虽过、整轮仍判失败。
 *
 * 模块关系：依赖 `eval/run.mjs`、`test/support/eval-floating-check.mjs`（夹具）与 Node 内置模块，
 * 由 `npm test` 启动，不调用真实模型。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runRound } from "../eval/run.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = path.join(projectRoot, "test", "support", "eval-floating-check.mjs");

/** 真 HTTP + 临时任务，验证并发池的收尾和网络错误归属，始终离线运行。 */
async function withRoundFixture(run) {
  const tasksDir = await mkdtemp(path.join(tmpdir(), "agent-round-test-"));
  let requests = 0;
  let finished = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      setTimeout(() => {
        finished++;
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }));
      }, 80);
    });
  });
  try {
    for (const name of ["first", "queued"]) {
      await mkdir(path.join(tasksDir, name, "files"), { recursive: true });
      await writeFile(path.join(tasksDir, name, "task.md"), "noop");
      await writeFile(path.join(tasksDir, name, "check.mjs"), "export default async function check() {}\n");
    }
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await run({ tasksDir, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test", model: "mock" }, {
      server, requests: () => requests, finished: () => finished,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(tasksDir, { recursive: true, force: true });
  }
}

test("评测：并发任务报错后停止领取，等待已经启动的任务收尾再拒绝", async () => {
  await withRoundFixture(async (options, endpoint) => {
    await assert.rejects(() => runRound({ ...options, names: ["first", "missing", "queued"], jobs: 2 }), /ENOENT/);
    assert.equal(endpoint.finished(), 1, "返回失败之前必须等正在执行的任务完成");
    assert.equal(endpoint.requests(), 1, "出错后不能启动队列中的下一项");
    const count = endpoint.requests();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(endpoint.requests(), count, "轮次退出后不能再产生模型请求");
  });
});

test("评测：模型连接失败记录为 environment，不污染任务能力成绩", async () => {
  await withRoundFixture(async (options, endpoint) => {
    const baseUrl = options.baseUrl;
    await new Promise((resolve) => endpoint.server.close(resolve));
    const round = await runRound({ ...options, baseUrl, names: ["first"], jobs: 1 });
    assert.equal(round.results[0].failure, "environment");
    assert.equal(round.results[0].ok, false);
  });
});

test("评测：夹具复制失败时清理已经创建的临时工作区", async () => {
  await withRoundFixture(async (options) => {
    const name = `broken-${path.basename(options.tasksDir)}`;
    await mkdir(path.join(options.tasksDir, name));
    await writeFile(path.join(options.tasksDir, name, "task.md"), "noop");
    const leftovers = async () => (await readdir(tmpdir())).filter((entry) => entry.startsWith(`agent-eval-${name}-`));
    try {
      await assert.rejects(() => runRound({ ...options, names: [name], jobs: 1 }), /ENOENT/);
      assert.deepEqual(await leftovers(), []);
    } finally {
      for (const entry of await leftovers()) {
        const target = path.resolve(tmpdir(), entry);
        assert.equal(path.dirname(target), path.resolve(tmpdir()));
        await rm(target, { recursive: true, force: true });
      }
    }
  });
});

/** 跑夹具，返回它最后一行 JSON 结论。 */
function runFixture(env = {}) {
  const child = spawn(process.execPath, [fixture], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  return new Promise((resolve) => {
    child.on("close", (code) => {
      const lastLine = stdout.trim().split("\n").at(-1) ?? "";
      resolve({ code, stderr, result: JSON.parse(lastLine) });
    });
  });
}

test("评测：没有未处理 rejection 时，一轮任务全过就算通过", async () => {
  const { code, stderr, result } = await runFixture({ FLOATING: "0" });

  assert.equal(code, 0, stderr);
  assert.equal(result.taskOk, true);
  assert.deepEqual(result.infraErrors, []);
  assert.equal(result.ok, true);
});

test("评测：检查器留下未处理 rejection 时，整轮判为基础设施失败", async () => {
  const { code, stderr, result } = await runFixture({ FLOATING: "1" });

  assert.equal(code, 0, stderr);
  assert.equal(result.taskOk, true, "任务本身确实通过了");
  assert.equal(result.infraErrors.length, 1);
  assert.match(result.infraErrors[0], /floating checker failure/);
  assert.equal(result.ok, false, "有基础设施错误时不能只看任务表就判通过");
});

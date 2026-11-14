/**
 * 文件目的：测「评测工具」自己 —— 检查器里如果有个异步任务没等就跑了，
 * 必须把整轮判成「工具坏了」，而不是在成绩单上留一个假的「通过」。
 *
 * 文件职责：验证一轮评测的错误分类与收尾；异步错误隔离通过子进程跑真实夹具验证。
 * 不测具体任务的判分、不测模型表现。
 *
 * 内容目录：
 *   - `runFixture()`：用子进程跑 `test/support/eval-floating-check.mjs`，读它最后一行 JSON。
 *   - `withRoundFixture()`：临时任务与假 HTTP 端点，验证并发校验、首错收尾、网络分类和夹具清理。
 *   - `withSummaryFixture()`：隔离的汇总输入，验证轮数及完整任务集合校验。
 *   - 异步错误：没有泄漏时整轮通过；有泄漏时任务虽过、整轮仍判失败。
 *
 * 模块关系：依赖 `eval/run.mjs`、`test/support/eval-floating-check.mjs`（夹具）与 Node 内置模块，
 * 由 `npm test` 启动，不调用真实模型。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

test("评测：非法并发数在启动任务前拒绝，不能留下未执行的稀疏结果", async () => {
  await withRoundFixture(async (options, endpoint) => {
    for (const jobs of [0, -1, 0.5, NaN, Infinity]) {
      await assert.rejects(() => runRound({ ...options, names: ["first"], jobs }), /jobs must be a positive safe integer/);
    }
    assert.equal(endpoint.requests(), 0);
  });
});

test("评测：成绩文件保存失败必须非零退出", async () => {
  await withRoundFixture(async (options) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-report-test-"));
    try {
      await cp(path.join(projectRoot, "src"), path.join(root, "src"), { recursive: true });
      await mkdir(path.join(root, "eval"));
      for (const file of ["run.mjs", "selfcheck.mjs", "diagnostics.mjs"]) {
        await copyFile(path.join(projectRoot, "eval", file), path.join(root, "eval", file));
      }
      await cp(options.tasksDir, path.join(root, "eval", "tasks"), { recursive: true });
      // 只在临时副本制造 ENOTDIR，不触碰仓库原有成绩。
      await writeFile(path.join(root, "eval", "results"), "blocking file");
      const child = spawn(process.execPath, [path.join(root, "eval", "run.mjs"), "--jobs", "1"], {
        env: { ...process.env, BASE_URL: options.baseUrl, API_KEY: "test", MODEL: "mock" },
        stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
      });
      child.stdout.resume();
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.match(stderr, /could not write results/);
      assert.equal(code, 1, "任务全过也不能把成绩保存失败伪装成成功退出");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** 汇总脚本在独立目录里读虚构记录，不碰用户原有的 eval/results。 */
async function withSummaryFixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-summary-test-"));
  try {
    const script = path.join(root, "summary.mjs");
    await copyFile(path.join(projectRoot, "eval", "summary.mjs"), script);
    await mkdir(path.join(root, "tasks", "first"), { recursive: true });
    await mkdir(path.join(root, "tasks", "second"));
    await mkdir(path.join(root, "results"));
    await writeFile(path.join(root, "results", "1.json"), JSON.stringify({
      total: 2, passed: 2, infraErrors: [],
      results: [{ name: "first", requests: 1, seconds: 1, ok: true }],
    }));
    await run(script, path.join(root, "results", "1.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("评测汇总：非法轮数明确拒绝", async () => {
  await withSummaryFixture(async (script) => {
    for (const count of ["0", "-1", "0.5", "NaN", "Infinity"]) {
      const result = spawnSync(process.execPath, [script, count], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 1, `非法轮数 ${count} 必须非零退出`);
      assert.match(result.stderr, /round count must be a positive safe integer/);
    }
  });
});

test("评测汇总：缺少任务结果的记录不能算完整轮次", async () => {
  await withSummaryFixture(async (script) => {
    const result = spawnSync(process.execPath, [script, "3"], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /还没有完整跑过全部 2 个任务的记录/);
    assert.doesNotMatch(result.stdout, /100%|2\/2/);
  });
});

test("评测汇总：任务集合和通过数必须自洽，合法完整轮次仍计入", async () => {
  await withSummaryFixture(async (script, recordFile) => {
    const first = { name: "first", requests: 1, seconds: 1, ok: true };
    const second = { name: "second", requests: 1, seconds: 1, ok: false };
    for (const record of [
      { total: 2, passed: 2, results: [first, first] },
      { total: 2, passed: 2, results: [first, second] },
      { total: 2, passed: 1, results: [first, null] },
    ]) {
      await writeFile(recordFile, JSON.stringify(record));
      const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /还没有完整跑过全部 2 个任务的记录/);
    }
    await writeFile(recordFile, JSON.stringify({ total: 2, passed: 1, results: [first, second] }));
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /合计：1\/2 个任务（50.0%）/);
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

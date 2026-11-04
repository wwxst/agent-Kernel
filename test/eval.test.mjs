/**
 * 评测器自身的测试：检查器里没 await 的 promise 必须把整轮判成基础设施失败，
 * 而不是在任务表上留下一个 PASS、后台却已经炸了。
 *
 * 用子进程跑完整一轮，避免 node:test 自己对 unhandledRejection 的监视抢先失败。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = path.join(projectRoot, "test", "support", "eval-floating-check.mjs");

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

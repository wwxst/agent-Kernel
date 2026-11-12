/**
 * 文件目的：一个测试用的小程序 —— 在单独的进程里完整跑一轮评测，专门验证
 * 「检查器里漏了异步错误（floating rejection）时，整轮成绩必须作废」。
 *
 * 为什么要单独开进程：测试框架自己也会盯着「没被处理的异步错误」，
 * 会抢先一步把用例判失败，反而测不到评测器自己的处理逻辑。
 *
 * 文件职责：负责搭一个假任务目录与假模型服务、跑一轮 `runRound()`、把结果打成一行 JSON。
 * 不负责断言 —— 断言在 `test/eval.test.mjs` 里，读这一行输出。
 *
 * 内容目录：
 *   - 临时任务目录：一个 `check.mjs`，`FLOATING` 决定它是「泄漏异步错误」还是「正常通过」。
 *   - 假 HTTP 端点：永远回一条合法响应，让整轮能跑完。
 *   - 主体：`runRound()` → `summarize()` → 打印 `{ taskOk, infraErrors, ok }`。
 *   - `finally`：关服务、删临时目录。
 *
 * 模块关系：依赖 `eval/run.mjs`（`runRound`、`summarize`）与 Node 内置模块。
 * 被 `test/eval.test.mjs` 以子进程方式启动，自身不被 import。
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRound, summarize } from "../../eval/run.mjs";

const floating = process.env.FLOATING !== "0";
const root = await mkdtemp(path.join(tmpdir(), "agent-eval-round-"));
const tasksDir = path.join(root, "tasks");
const taskDir = path.join(tasksDir, "99-floating-check");

await mkdir(path.join(taskDir, "files"), { recursive: true });
await writeFile(path.join(taskDir, "task.md"), "noop");
await writeFile(
  path.join(taskDir, "check.mjs"),
  floating
    ? 'export default async function check() { void Promise.reject(new Error("floating checker failure")); }\n'
    : "export default async function check() {}\n",
);

const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

try {
  const round = await runRound({
    tasksDir,
    names: ["99-floating-check"],
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test",
    model: "mock",
    jobs: 1,
  });
  const record = summarize({ ...round, model: "mock", commit: "test" });
  console.log(
    JSON.stringify({
      taskOk: record.results[0]?.ok,
      infraErrors: record.infraErrors,
      ok: record.ok,
    }),
  );
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

/**
 * 评测器「未处理 rejection」检测的夹具：在子进程里完整跑一轮评测。
 *
 * 为什么放子进程：node:test 自己也监视 unhandledRejection，会先一步把用例判失败，
 * 测不到评测器的处理逻辑。这里把整套东西隔离到独立进程，只看它输出的结论文档。
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

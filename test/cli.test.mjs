/**
 * 端到端测试：真的拉起一个 agent 进程，用一个本地 mock 服务冒充模型。
 *
 * 这一层只验证「组装得对不对」：环境变量、退出码、stdout 的进度输出、
 * 以及请求体确实是 OpenAI 兼容的形状。循环内部的细节在 agent/tool-registry/workspace
 * 的单元测试里覆盖，这里不再重复。
 *
 * 运行：npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callTool, finalReply, withWorkspace } from "./support/harness.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(projectRoot, "src", "cli.ts");

/** 启动 mock 服务，按脚本回放模型的响应；请求次数超出脚本时重复最后一条。 */
async function startMock(script) {
  const requests = [];
  let turn = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const message = script[Math.min(turn++, script.length - 1)];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 拉起一个 agent 进程，返回退出码与两路输出。 */
function runCli(env) {
  const child = spawn(process.execPath, [cliPath, "do the task"], {
    cwd: projectRoot,
    // API_KEY 给个假值：测试里没有真实网络请求（缺 Key 的用例会显式覆盖它）。
    env: { ...process.env, API_KEY: "test-key", OPENAI_API_KEY: "", ...env },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("完整跑通：写文件 → 读回 → 收尾，请求体是 OpenAI 兼容形状", async () => {
  await withWorkspace(async (workdir) => {
    // 思考模式下模型会带回 reasoning_content：请求里带了 tools 时，它必须原样回传，否则 API 会 400。
    const firstTurn = callTool("call_write", "write", { path: "hello.txt", content: "hello from agent\n" });
    firstTurn.reasoning_content = "先写文件，再读回来确认。";
    // 厂商私有字段不认识，不该被原样转发回 API。
    firstTurn.annotations = [{ type: "url_citation", url: "https://example.com" }];

    const mock = await startMock([
      firstTurn,
      callTool("call_read", "read", { path: "hello.txt" }),
      finalReply("done: created hello.txt"),
    ]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.equal(run.code, 0, `agent exited with ${run.code}\n${run.stderr}`);

      // 文件真的落盘了，最终回复也打印出来了
      assert.equal(await readFile(path.join(workdir, "hello.txt"), "utf8"), "hello from agent\n");
      assert.match(run.stdout, /done: created hello\.txt/);
      assert.match(run.stdout, /wrote 17 chars to hello\.txt/);

      // 第一次请求：system 在最前，四个工具按协议格式发过去
      const first = mock.requests[0];
      assert.equal(first.messages[0].role, "system");
      assert.equal(first.messages[1].role, "user");
      assert.equal(first.max_tokens, 8192, "单次输出上限要随请求发出去");
      assert.deepEqual(
        first.tools.map((tool) => tool.function.name),
        ["read", "write", "edit", "glob", "grep", "ls", "shell"],
      );

      // mock 不回 usage：成本摘要必须写 at least，不能把「已统计到 0」说成「只花了 0」。
      assert.match(run.stdout, /\[usage\] requests=3 tool_calls=2 tokens=at least 0/);
      assert.match(run.stdout, /3 response\(s\) without usage/);

      // 第三次请求：assistant 与 tool 严格交替，结果靠 tool_call_id 配对
      const third = mock.requests[2].messages;
      assert.deepEqual(
        third.map((message) => message.role),
        ["system", "user", "assistant", "tool", "assistant", "tool"],
      );
      // 思维链跟着 assistant 消息一起回传了（漏了它，真实 API 会 400）
      assert.equal(third[2].reasoning_content, "先写文件，再读回来确认。");
      // 但不认识的厂商字段被丢掉，不会原样转发（严格端点会因此 400）
      assert.equal(third[2].annotations, undefined);
      const readResult = third.filter((message) => message.role === "tool").at(-1);
      assert.equal(readResult.tool_call_id, "call_read");
      assert.match(readResult.content, /hello from agent/);
    } finally {
      await mock.close();
    }
  });
});

test("越界路径：变成 ERROR 回灌，进程正常退出", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_1", "read", { path: "../../outside.txt" }),
      finalReply("recovered after bad path"),
    ]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.equal(run.code, 0, "agent should survive a tool error");
      assert.match(run.stdout, /ERROR: path escapes workspace/);
      assert.match(run.stdout, /recovered after bad path/);

      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /ERROR: path escapes workspace/);
    } finally {
      await mock.close();
    }
  });
});

test("步数上限：退出码 1，stderr 说明原因", async () => {
  await withWorkspace(async (workdir) => {
    // 只有一条脚本，且永远是工具调用：不设上限就会无限循环。
    const mock = await startMock([callTool("call_loop", "ls", { path: "." })]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir, MAX_STEPS: "2" });
      assert.equal(run.code, 1);
      assert.match(run.stderr, /step limit 2 reached/);
      assert.equal(mock.requests.length, 2, "should stop after exactly MAX_STEPS model calls");
    } finally {
      await mock.close();
    }
  });
});

test("缺少 API Key：不联网，直接以退出码 1 结束", async () => {
  const run = await runCli({ API_KEY: "" });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /missing API_KEY/);
});

test(
  "SIGINT：取消正在等待的模型请求，退出码 130",
  { skip: process.platform === "win32" && "Windows 上 node 不能向另一个进程投递 SIGINT" },
  async () => {
    // 这个端点永远不回响应：进程会停在等模型上，正好用来验证取消链。
    let started;
    const requested = new Promise((resolve) => {
      started = resolve;
    });
    const server = createServer(() => started());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const child = spawn(process.execPath, [cliPath, "do the task"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        API_KEY: "test-key",
        OPENAI_API_KEY: "",
        BASE_URL: `http://127.0.0.1:${port}/v1`,
        MODEL: "mock-model",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    try {
      await requested;
      child.kill("SIGINT");
      const code = await new Promise((resolve) => child.on("close", resolve));

      assert.equal(code, 130);
      assert.match(stderr, /\[agent\] cancelled: received SIGINT/);
    } finally {
      child.kill();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

/**
 * 端到端测试：用一个本地 mock 服务冒充模型，把 CLI 完整跑一遍。
 *
 * 三个好处：
 *   - 不需要 API Key、不联网，CI 里也能跑；
 *   - 可以精确控制「模型下一句说什么」，包括故意说错（坏 JSON、越界路径、不存在的工具）；
 *   - 断言的都是循环的外部行为：文件有没有写出来、消息顺序对不对、错误有没有回灌。
 *
 * 运行：npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(projectRoot, "src", "cli.ts");

/** 构造一条「模型要调工具」的 assistant 消息。 */
function callTool(id, name, args) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** 同上，但 arguments 原样给出 —— 用来模拟模型写坏 JSON。 */
function callToolRaw(id, name, rawArguments) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: rawArguments } }],
  };
}

/** 构造一条「模型收尾」的 assistant 消息：没有工具调用，循环到此结束。 */
function finalReply(content) {
  return { role: "assistant", content, tool_calls: [] };
}

/**
 * 启动 mock 服务，按脚本回放模型的响应。
 * 请求次数超出脚本长度时重复最后一条，保证 agent 总能正常收尾。
 */
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

/** 真正拉起一个 agent 进程，返回退出码与两路输出。 */
function runCli(env) {
  const child = spawn(process.execPath, [cliPath, "do the task"], {
    cwd: projectRoot,
    // API_KEY 给个假值：测试里没有真实网络请求。
    env: { ...process.env, API_KEY: "test-key", ...env },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 每个用例一个临时工作区，跑完就删。 */
async function withWorkspace(fn) {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-kernel-"));
  try {
    return await fn(workdir);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

test("完整循环：写文件 → 读回 → 收尾，工具结果按顺序回灌", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_write", "write_file", { path: "hello.txt", content: "hello from agent\n" }),
      callTool("call_read", "read_file", { path: "hello.txt" }),
      finalReply("done: created hello.txt"),
    ]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.equal(run.code, 0, `agent exited with ${run.code}\n${run.stderr}`);

      // 文件真的落盘了，最终回复也打印出来了
      assert.equal(await readFile(path.join(workdir, "hello.txt"), "utf8"), "hello from agent\n");
      assert.match(run.stdout, /done: created hello\.txt/);

      // 第一次请求：system 在最前，四个工具都按协议格式发过去了
      const first = mock.requests[0];
      assert.equal(first.messages[0].role, "system");
      assert.equal(first.messages[1].role, "user");
      assert.deepEqual(
        first.tools.map((tool) => tool.function.name),
        ["read_file", "write_file", "list_dir", "run_command"],
      );

      // 第二次请求：模型能看见 write_file 的结果（注意此时文件内容还没被读出来）
      const second = mock.requests[1].messages;
      const writeResult = second.find((message) => message.role === "tool");
      assert.ok(writeResult, "write result should be fed back to the model");
      assert.equal(writeResult.tool_call_id, "call_write");
      assert.match(writeResult.content, /wrote 17 chars/);

      // 第三次请求：read_file 的结果也回灌了，并且「assistant → tool」严格交替
      const third = mock.requests[2].messages;
      assert.deepEqual(
        third.map((message) => message.role),
        ["system", "user", "assistant", "tool", "assistant", "tool"],
        "assistant tool_calls and tool results must alternate in order",
      );
      const readResult = third.filter((message) => message.role === "tool").at(-1);
      assert.equal(readResult.tool_call_id, "call_read");
      assert.match(readResult.content, /hello from agent/);
    } finally {
      await mock.close();
    }
  });
});

test("越界路径：变成 ERROR 文本回灌，循环继续", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_1", "read_file", { path: "../../outside.txt" }),
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

test("坏 JSON 参数：变成 ERROR 文本，而不是抛异常", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callToolRaw("call_1", "read_file", "{not valid json"),
      finalReply("recovered after bad json"),
    ]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.equal(run.code, 0);
      assert.match(run.stdout, /recovered after bad json/);

      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /ERROR: invalid JSON arguments/);
    } finally {
      await mock.close();
    }
  });
});

test("不存在的工具：ERROR 里带上可用工具名", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([callTool("call_1", "rm_rf", { path: "/" }), finalReply("ok")]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.equal(run.code, 0);

      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /ERROR: unknown tool "rm_rf"/);
      assert.match(toolMessage.content, /available: read_file, write_file, list_dir, run_command/);
    } finally {
      await mock.close();
    }
  });
});

test("步数上限：模型一直要调工具时被截断", async () => {
  await withWorkspace(async (workdir) => {
    // 只有一条脚本，且永远是工具调用：不设上限就会无限循环。
    const mock = await startMock([callTool("call_loop", "list_dir", { path: "." })]);

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

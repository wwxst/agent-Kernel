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
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callTool, finalReply, withWorkspace } from "./support/harness.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(projectRoot, "src", "cli.ts");

/** 启动 mock 服务，按脚本回放模型的响应；请求次数超出脚本时重复最后一条。 */
async function startMock(script, { usage } = {}) {
  const requests = [];
  let turn = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const message = script[Math.min(turn++, script.length - 1)];

      // CLI 走流式：把同一条 message 包装成 SSE，让端到端测试也经过真实的解析路径。
      if (JSON.parse(body).stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta, finish_reason = null, extra = {}) =>
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
        // 一条完整的 delta 就够 CLI 用；分片拼装由 llm.test.mjs 单独覆盖。
        response.write(frame({ ...message }));
        response.write(frame({}, message.tool_calls?.length ? "tool_calls" : "stop"));
        if (usage !== undefined) response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      const payload = {
        choices: [
          // finish_reason 必须和 tool_calls 一致：带调用就是 tool_calls，否则是 stop。
          { index: 0, message, finish_reason: message.tool_calls?.length ? "tool_calls" : "stop" },
        ],
      };
      if (usage !== undefined) payload.usage = usage;
      response.end(JSON.stringify(payload));
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
function runCli(env, { args = ["do the task"], input } = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    // API_KEY 给个假值：测试里没有真实网络请求（缺 Key 的用例会显式覆盖它）。
    env: { ...process.env, API_KEY: "test-key", OPENAI_API_KEY: "", ...env },
  });

  if (input !== undefined) child.stdin.end(input);

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
      // 不传 --permission 时默认是 workspace-write：文件工具放行。
      assert.match(run.stdout, /permission: workspace-write/);

      // 第一次请求：system 在最前，四个工具按协议格式发过去
      const first = mock.requests[0];
      assert.equal(first.messages[0].role, "system");
      assert.match(first.messages[0].content, /Permission mode: workspace-write/);
      assert.equal(first.messages[1].role, "user");
      assert.equal(first.max_tokens, 8192, "单次输出上限要随请求发出去");
      assert.deepEqual(
        first.tools.map((tool) => tool.function.name),
        ["read", "write", "edit", "glob", "grep", "ls", "shell"],
      );

      // mock 不回 usage：成本摘要必须写 at least，不能把「已统计到 0」说成「只花了 0」。
      assert.match(run.stdout, /\[usage\] requests=3 tool_calls=2 tokens=at least 0/);
      assert.match(run.stdout, /3 request\(s\) without usage/);

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

test("步数上限：退出码 1，stderr 说明原因，失败路径仍输出 usage", async () => {
  await withWorkspace(async (workdir) => {
    // 只有一条脚本，且永远是工具调用：不设上限就会无限循环。
    const mock = await startMock([callTool("call_loop", "ls", { path: "." })], {
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    });

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir, MAX_STEPS: "2" });
      assert.equal(run.code, 1);
      assert.match(run.stderr, /step limit 2 reached/);
      assert.equal(mock.requests.length, 2, "should stop after exactly MAX_STEPS model calls");
      // 第 1 次的工具执行了，第 2 次是收尾请求、工具没跑；两次请求的花费都要算。
      assert.match(run.stdout, /\[usage\] requests=2 tool_calls=1 tokens=220 \(prompt=200 completion=20\)/);
      assert.match(run.stdout, /task failed/);
    } finally {
      await mock.close();
    }
  });
});

test("失败路径：token 预算超限时也输出 usage 与超预算状态", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([callTool("call_1", "ls", { path: "." })], {
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    });

    try {
      const run = await runCli({
        BASE_URL: mock.url,
        MODEL: "mock-model",
        WORKDIR: workdir,
        MAX_TOTAL_TOKENS: "100",
      });

      assert.equal(run.code, 1);
      assert.match(run.stderr, /token budget 100 reached/);
      assert.match(run.stdout, /\[usage\] requests=1 tool_calls=0 tokens=110/);
      assert.match(run.stdout, /budget exceeded \(limit=100\) · task failed/);
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

test("API Key：空白值算没填，回退到 OPENAI_API_KEY", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("fallback ok")]);
    try {
      const run = await runCli({
        API_KEY: "   ",
        OPENAI_API_KEY: "fallback-key",
        BASE_URL: mock.url,
        MODEL: "mock-model",
        WORKDIR: workdir,
      });

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /fallback ok/);
    } finally {
      await mock.close();
    }
  });
});

test("API Key：只有空白值时按缺失处理", async () => {
  const run = await runCli({ API_KEY: "   ", OPENAI_API_KEY: "" });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /missing API_KEY/);
});

test("REPL：两轮共享 transcript，每轮打自己的 usage，退出时打会话总账", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("first answer"), finalReply("second answer")]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--repl"], input: "first task\nsecond task\n/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /first answer/);
      assert.match(run.stdout, /second answer/);
      assert.equal(mock.requests.length, 2);
      // 第二轮请求带着第一轮的全部历史。
      assert.deepEqual(
        mock.requests[1].messages.map((message) => message.role),
        ["system", "user", "assistant", "user"],
      );
      // 每轮一行 [usage]，退出时再加一行跨 Run 的 [session]。
      assert.equal((run.stdout.match(/\[usage\]/g) ?? []).length, 2);
      assert.match(run.stdout, /\[session\] runs=2 requests=2/);
    } finally {
      await mock.close();
    }
  });
});

test("REPL：/reset 清空上下文，重新开一个 Agent", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("first answer"), finalReply("second answer")]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--repl"], input: "first task\n/reset\nsecond task\n/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /session reset/);
      assert.equal(mock.requests.length, 2);
      assert.deepEqual(
        mock.requests[1].messages.map((message) => message.role),
        ["system", "user"],
      );
      // reset 之后是新会话：总账只算 reset 后那一轮。
      assert.match(run.stdout, /\[session\] runs=1 requests=1/);
    } finally {
      await mock.close();
    }
  });
});

test("REPL：一轮失败不结束会话，下一轮还能继续", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_1", "ls", { path: "." }),
      finalReply("recovered on the second turn"),
    ]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir, MAX_STEPS: "1" },
        { args: ["--repl"], input: "first task\nsecond task\n/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stderr, /turn failed: step limit 1 reached/);
      // 失败那一轮同样打了 usage（task failed），第二轮照常成功。
      assert.match(run.stdout, /task failed/);
      assert.match(run.stdout, /recovered on the second turn/);
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });
});

test("--permission read-only：写工具被拒绝，ERROR 回灌后模型继续收尾", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_write", "write", { path: "blocked.txt", content: "nope" }),
      finalReply("permission denied as expected"),
    ]);

    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--permission", "read-only", "do the task"] },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /permission: read-only/);
      assert.match(run.stdout, /ERROR: permission denied: tool "write" is not allowed in read-only mode/);

      const first = mock.requests[0];
      assert.match(first.messages[0].content, /Permission mode: read-only/);
      assert.doesNotMatch(first.messages[0].content, /workspace-write|full-access/);

      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /^ERROR: permission denied: /);
    } finally {
      await mock.close();
    }
  });
});

test("workspace-write：无 TTY 时 shell 默认拒绝", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_shell", "shell", { command: "echo should-not-run" }),
      finalReply("shell was denied"),
    ]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /permission: workspace-write/);
      assert.match(run.stdout, /ERROR: permission denied: .*no approval prompt is available/);

      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /^ERROR: permission denied: .*no approval prompt is available/);
    } finally {
      await mock.close();
    }
  });
});

test("REPL：无 TTY 时 shell 被拒绝，也不会吞掉下一行输入", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_shell", "shell", { command: "echo should-not-run" }),
      finalReply("first turn done"),
      finalReply("second turn done"),
    ]);

    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--repl"], input: "first task\nsecond task\n/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /first turn done/);
      assert.match(run.stdout, /second turn done/);
      assert.equal((run.stdout.match(/ERROR: permission denied/g) ?? []).length, 1);
      // 两轮都跑完了：审批没有把 "second task" 当成答案。
    } finally {
      await mock.close();
    }
  });
});

test("TUI：状态栏、运行记录、统计与会话命令", async () => {
  await withWorkspace(async (workdir) => {
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    const mock = await startMock(
      [
        callTool("call_write", "write", { path: "hello.txt", content: "hello" }),
        finalReply("tui first done"),
        finalReply("tui second done"),
      ],
      { usage },
    );

    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        {
          args: ["--tui"],
          input:
            "first task\n/permission wide-open\n/permission read-only\n/help\n/reset\nsecond task\n/exit\n",
        },
      );

      assert.equal(run.code, 0, run.stderr);
      // 顶部状态栏（非 TTY 退化成三行）
      assert.match(run.stdout, /model: mock-model/);
      assert.ok(run.stdout.includes(`workspace: ${workdir}`));
      assert.match(run.stdout, /permission: workspace-write/);

      // 中间运行记录：用户任务、工具调用、成功结果、模型回复
      assert.match(run.stdout, /you: first task/);
      assert.match(run.stdout, /→ write path=hello\.txt/);
      assert.match(run.stdout, /✓ write \[ok\] wrote 5 chars to hello\.txt/);
      assert.match(run.stdout, /model: tui first done/);
      // 第一轮两次请求，各 110 tokens
      assert.match(run.stdout, /\[stats\] requests=2 tool_calls=1 tokens=220/);

      // 会话命令：非法模式报错、切换权限、帮助、reset
      assert.match(run.stdout, /unknown permission mode "wide-open"/);
      assert.match(run.stdout, /permission: read-only/);
      assert.match(run.stdout, /commands: \/exit/);
      assert.match(run.stdout, /\(session reset\)/);
      assert.match(run.stdout, /model: tui second done/);
      assert.match(run.stdout, /\[session\] runs=1 requests=1 tool_calls=0 tokens=110/);

      // reset 换 Agent 但不换权限：第二次请求回到 system + user，且提示为 read-only。
      const secondRequest = mock.requests[2];
      assert.deepEqual(
        secondRequest.messages.map((message) => message.role),
        ["system", "user"],
      );
      assert.match(secondRequest.messages[0].content, /Permission mode: read-only/);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：--tui 带初始任务时先跑完再等输入", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("initial task done")]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--tui", "do", "the", "initial", "task"], input: "/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /you: do the initial task/);
      assert.match(run.stdout, /model: initial task done/);
      assert.match(run.stdout, /\[stats\] requests=1 tool_calls=0 tokens=at least 0/);
      assert.match(run.stdout, /\[session\] runs=1 requests=1/);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：无 TTY 时 shell 审批不可用，拒绝原因进入运行记录", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_shell", "shell", { command: "echo should-not-run" }),
      finalReply("shell denied in tui"),
    ]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--tui", "--permission", "workspace-write", "do it"], input: "/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /→ shell echo should-not-run/);
      assert.match(
        run.stdout,
        /✗ shell \[denied\] permission denied: tool "shell" requires approval, but no approval prompt is available; denied/,
      );
      // 没有审批通道就不该展示审批界面。
      assert.doesNotMatch(run.stdout, /\[permission\]/);
      assert.match(run.stdout, /model: shell denied in tui/);
    } finally {
      await mock.close();
    }
  });
});

test("--tui 与 --repl 不能同时使用", async () => {
  const run = await runCli({}, { args: ["--tui", "--repl"] });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /cannot combine --repl and --tui/);
});

test("--permission=full-access：shell 不用审批就执行", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_shell", "shell", { command: "echo full-access-ran" }),
      finalReply("shell ran"),
    ]);

    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--permission=full-access", "do the task"] },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /permission: full-access/);
      assert.match(run.stdout, /shell ran/);

      const first = mock.requests[0];
      assert.match(first.messages[0].content, /Permission mode: full-access/);

      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /full-access-ran/);
    } finally {
      await mock.close();
    }
  });
});

test("--permission 非法值：退出码 1，不调用模型", async () => {
  const run = await runCli({}, { args: ["--permission", "wide-open", "do the task"] });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /invalid --permission value "wide-open"/);
});

test("--permission 缺少值：退出码 1，提示可用模式", async () => {
  const run = await runCli({}, { args: ["--permission"] });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /missing value for --permission/);
});

test("REPL：/permission 查看与切换，/reset 保留当前模式", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_write_1", "write", { path: "blocked-1.txt", content: "no" }),
      finalReply("first turn done"),
      callTool("call_write_2", "write", { path: "blocked-2.txt", content: "no" }),
      finalReply("second turn done"),
    ]);

    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        {
          args: ["--repl"],
          input: "/permission\n/permission read-only\nfirst task\n/reset\nsecond task\n/exit\n",
        },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /permission: workspace-write/);
      assert.match(run.stdout, /permission: read-only/);
      assert.equal((run.stdout.match(/permission: read-only/g) ?? []).length, 2, "reset 后重开 Agent 仍打印 read-only");
      assert.equal((run.stdout.match(/ERROR: permission denied/g) ?? []).length, 2);

      // 两次写调用都被拒绝：/reset 换了 Agent，但没有换权限。
      const toolResults = mock.requests.flatMap((request) =>
        request.messages.filter((message) => message.role === "tool").map((message) => message.content),
      );
      assert.equal(toolResults.length, 2);
      for (const result of toolResults) assert.match(result, /^ERROR: permission denied: /);
    } finally {
      await mock.close();
    }
  });
});

test("REPL：/permission 切换后下一次请求使用新提示", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      finalReply("workspace done"),
      finalReply("read-only done"),
    ]);

    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--repl"], input: "first\n/permission read-only\nsecond\n/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.equal(mock.requests.length, 2);

      const [workspaceRequest, readOnlyRequest] = mock.requests;
      assert.match(workspaceRequest.messages[0].content, /Permission mode: workspace-write/);
      assert.match(readOnlyRequest.messages[0].content, /Permission mode: read-only/);
      assert.doesNotMatch(readOnlyRequest.messages[0].content, /workspace-write|full-access/);
      assert.equal(readOnlyRequest.messages.filter((message) => message.role === "system").length, 1);
      // 切换发生在同一会话里：第二次请求仍带着第一轮的历史。
      assert.deepEqual(
        readOnlyRequest.messages.map((message) => message.role),
        ["system", "user", "assistant", "user"],
      );
    } finally {
      await mock.close();
    }
  });
});

test("REPL：/reset 保留当前权限提示，不残留旧规则", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      finalReply("first done"),
      finalReply("after reset done"),
    ]);

    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--repl"], input: "/permission read-only\nfirst\n/reset\nsecond\n/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.equal(mock.requests.length, 2);
      for (const request of mock.requests) {
        assert.match(request.messages[0].content, /Permission mode: read-only/);
        assert.doesNotMatch(request.messages[0].content, /workspace-write|full-access/);
        assert.equal(request.messages.filter((message) => message.role === "system").length, 1);
      }
      // /reset 换 Agent：第二次请求回到 system + user。
      assert.deepEqual(
        mock.requests[1].messages.map((message) => message.role),
        ["system", "user"],
      );
    } finally {
      await mock.close();
    }
  });
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


test("CLI 阶段：思考、工具开始与结果、回答和完成都有真实状态", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_1", "ls", { path: "." }),
      finalReply("all done"),
    ]);
    try {
      const run = await runCli({ BASE_URL: mock.url, WORKDIR: workdir, AGENT_VOICE: "balanced" });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /◇ Preparing/);
      assert.match(run.stdout, /✻ Thinking\.\.\. · step 1/);
      assert.match(run.stdout, /⚙ Tool #1 · ls/);
      assert.match(run.stdout, /↳ ls ✓/);
      assert.match(run.stdout, /✻ Thinking\.\.\. · step 2/);
      assert.match(run.stdout, /✎ Answering\.\.\./);
      assert.match(run.stdout, /all done/);
      assert.match(run.stdout, /✓ Completed · 用时 \d+秒 · 1 次工具调用/);
      assert.ok(run.stdout.indexOf("⚙ Tool #1") < run.stdout.indexOf("↳ ls ✓"));
      assert.ok(run.stdout.indexOf("↳ ls ✓") < run.stdout.indexOf("✓ Completed"));
      // 模型的请求和工具调用数不因展示变化。
      assert.match(run.stdout, /\[usage\] requests=2 tool_calls=1/);
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });
});

test("CLI 台词：指定傲娇语气只修改展示，不进入模型请求", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("plain answer")]);
    try {
      const run = await runCli({ BASE_URL: mock.url, WORKDIR: workdir, AGENT_VOICE: "tsundere" });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /哼，这点准备工作难不倒我/);
      assert.match(run.stdout, /才、才不是在发呆/);
      assert.match(run.stdout, /plain answer/);
      assert.equal(mock.requests.length, 1);
      assert.equal(JSON.stringify(mock.requests[0]).includes("才、才不是在发呆"), false);
    } finally {
      await mock.close();
    }
  });
});

test("CLI 精简与详细模式：工具摘要一直可见，详细模式独立展开多行结果", async () => {
  await withWorkspace(async (workdir) => {
    await writeFile(path.join(workdir, "lines.txt"), "first line\nsecond line\nthird line\n");
    const mock = await startMock([
      callTool("call_1", "read", { path: "lines.txt" }),
      finalReply("compact done"),
      callTool("call_2", "read", { path: "lines.txt" }),
      finalReply("detailed done"),
    ]);
    try {
      const compact = await runCli({ BASE_URL: mock.url, WORKDIR: workdir, AGENT_VIEW: "compact" });
      const detailed = await runCli({ BASE_URL: mock.url, WORKDIR: workdir }, { args: ["--details", "do the task"] });
      assert.equal(compact.code, 0, compact.stderr);
      assert.equal(detailed.code, 0, detailed.stderr);
      assert.match(compact.stdout, /↳ read ✓ first line/);
      assert.doesNotMatch(compact.stdout, /┌ result/);
      assert.match(detailed.stdout, /↳ read ✓ first line/);
      assert.match(detailed.stdout, /┌ result/);
      assert.match(detailed.stdout, /│ second line/);
      assert.match(detailed.stdout, /└ end/);
      assert.match(detailed.stdout, /detailed done/);
    } finally {
      await mock.close();
    }
  });
});

test("CLI 配置：未知语气和显示模式明确报错", async () => {
  const voice = await runCli({ AGENT_VOICE: "unknown" });
  assert.equal(voice.code, 1);
  assert.match(voice.stderr, /invalid AGENT_VOICE/);
  const view = await runCli({ AGENT_VIEW: "unknown" });
  assert.equal(view.code, 1);
  assert.match(view.stderr, /invalid AGENT_VIEW/);
});

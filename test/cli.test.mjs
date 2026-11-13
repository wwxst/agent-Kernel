/**
 * 文件目的：整体测试 —— 真的启动一个程序，用一个本地假服务冒充模型。
 *
 * 这一层只验证「零件装得对不对」：配置读到了没有、程序正常退出没有、
 * 屏幕上有没有进度、发给模型的请求格式对不对。内部的细节留给各自的单元测试。
 *
 * 文件职责：`src/cli.ts` 这一处缝 —— 环境变量、参数、退出码、stdout、请求体形状、TUI 组装。
 * 不测循环、工具、客户端本身的行为（各有单元测试）。
 *
 * 内容目录：
 *   - 假服务：`startMock()` 按脚本回放，可模拟 usage、中断、SSE 未完成、HTTP 状态码。
 *   - 配置与参数：占位 Key 不发请求、空白 Key 回退、缺 Key 直接失败、`--cwd` 生效与报错、
 *     `--help` 不提已移除的开关、`--permission` / `--repl` / `AGENT_PERMISSION` 传入即报错。
 *   - 端到端：写文件 → 读回 → 收尾，请求体是 OpenAI 兼容形状；工作区外绝对路径可读。
 *   - 失败路径：步数上限、token 预算、Shell 非零退出、流式中断撤销草稿，都带 usage 与非零退出码。
 *   - TUI 组装：状态栏、运行记录、统计、会话命令、初始任务、语言切换、重试状态、无 TTY 行为。
 *   - 展示细节：阶段提示、台词不影响请求、精简/详细模式、控制字符只显示转义文本。
 *   - 项目指令：工作区有 `AGENTS.md` 时注入系统提示，没有就不注入。
 *
 * 模块关系：以子进程启动 `src/cli.ts`，依赖 `test/support/harness.mjs` 造消息与临时工作区，
 * 由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callTool, finalReply, withWorkspace } from "./support/harness.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(projectRoot, "src", "cli.ts");

/** 启动 mock 服务，按脚本回放模型的响应；请求次数超出脚本时重复最后一条。 */
async function startMock(script, { usage, interruptAtTurn, incompleteAtTurns = [], httpStatus = 200 } = {}) {
  const requests = [];
  let turn = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const currentTurn = turn++;
      const message = script[Math.min(currentTurn, script.length - 1)];

      const status = Array.isArray(httpStatus) ? httpStatus[Math.min(currentTurn, httpStatus.length - 1)] : httpStatus;
      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "mock provider rejected request" } }));
        return;
      }

      // CLI 走流式：把同一条 message 包装成 SSE，让端到端测试也经过真实的解析路径。
      if (JSON.parse(body).stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta, finish_reason = null, extra = {}) =>
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
        // 先吐合法增量再给损坏的帧：验证请求失败时正文尚未被 Agent 确认。
        if (currentTurn === interruptAtTurn) {
          response.write(frame({ content: "UNCONFIRMED_SECOND_REQUEST" }));
          response.end("data: {broken-json}\n\n");
          return;
        }
        if (incompleteAtTurns.includes(currentTurn)) {
          response.write(frame({ content: "UNCONFIRMED_CHUNK" }));
          response.end("data: [DONE]\n\n");
          return;
        }
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
    // AGENT_PERMISSION 显式清空：本机 shell 或 .env 里若残留它，启动会直接报错；
    // 要测「已移除」的用例自己传值。
    env: { ...process.env, API_KEY: "test-key", OPENAI_API_KEY: "", AGENT_PERMISSION: "", ...env },
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

test("TUI：.env.example 占位 Key 不能冒充已配置模型，也不能发出请求", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("not reached")]);
    try {
      const run = await runCli(
        { API_KEY: "sk-your-key-here", OPENAI_API_KEY: "", BASE_URL: mock.url, MODEL: "mock-demo", WORKDIR: workdir },
        { args: ["--tui", "hello"], input: "/exit\n" },
      );
      assert.equal(run.code, 1);
      assert.match(run.stderr, /Model not configured/);
      assert.match(run.stderr, /missing API_KEY/);
      assert.equal(mock.requests.length, 0, "占位配置不能发起模型调用");
      assert.doesNotMatch(run.stdout, /Thinking|Failed|请求|tokens/);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：显式外部 Mock 演示有标识，不能仅凭 mock-demo 模型名宣称连接成功", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("demo answer")]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-demo", AGENT_DEMO: "1", WORKDIR: workdir },
        { args: ["--tui", "hello"], input: "/exit\n" },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /mock-demo \[demo: external mock\]/);
      assert.match(run.stdout, /demo answer/);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：SSE 无完成标记分类为模型回复中断，英文/中文各只展示一条错误摘要", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("never confirmed")], { incompleteAtTurns: [0, 1] });
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-demo", WORKDIR: workdir },
        { args: ["--tui"], input: "hello\n你好\n/exit\n" },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(mock.requests.length, 2);
      assert.equal((run.stdout.match(/Model service unavailable/g) ?? []).length, 1);
      assert.equal((run.stdout.match(/模型服务不可用/g) ?? []).length, 1);
      assert.match(run.stdout, /previously shown preview is discarded|previously shown preview is discarded/i);
      assert.match(run.stdout, /此前显示的草稿已作废/);
      assert.doesNotMatch(run.stdout, /技术详情：|Technical details：/);
      assert.doesNotMatch(run.stdout, /\[stream interrupted: unconfirmed text discarded\]/);
      assert.doesNotMatch(run.stdout, /【流式响应中断：未确认正文已丢弃】/);
      assert.doesNotMatch(run.stdout, /model: never confirmed/);
      assert.match(run.stdout, /请求=2/);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：401 明确提示鉴权失败，不误报为 SSE 中断", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("ignored")], { httpStatus: 401 });
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--tui", "hello"], input: "/exit\n" },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /Model authentication failed/);
      assert.match(run.stdout, /HTTP 401/);
      assert.doesNotMatch(run.stdout, /Model response interrupted|stream interrupted/);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });
});

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
      // 只有一种权限：完全访问。
      assert.match(run.stdout, /access: +full-access/);

      // 第一次请求：system 在最前，四个工具按协议格式发过去
      const first = mock.requests[0];
      assert.equal(first.messages[0].role, "system");
      assert.match(first.messages[0].content, /full access/);
      assert.equal(first.messages[1].role, "user");
      assert.equal(first.max_tokens, 8192, "单次输出上限要随请求发出去");
      assert.deepEqual(
        first.tools.map((tool) => tool.function.name),
        ["read", "write", "edit", "glob", "grep", "ls", "shell", "shell-output", "shell-kill"],
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

test("CLI：模型流式请求中断时声明草稿失效，不冒充已确认回复", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("ignored")], { interruptAtTurn: 0 });
    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.notEqual(run.code, 0);
      assert.match(run.stdout, /UNCONFIRMED_SECOND_REQUEST/);
      assert.doesNotMatch(run.stdout, /\[stream interrupted: unconfirmed text discarded\]/);
      assert.match(run.stderr, /Model service unavailable/);
      assert.match(run.stderr, /preview is discarded/);
      assert.doesNotMatch(run.stdout, /model \(confirmed\): UNCONFIRMED_SECOND_REQUEST/);
    } finally {
      await mock.close();
    }
  });
});

test("工作区外路径：绝对路径可以直接读取，不再当作越界", async () => {
  await withWorkspace(async (workdir) => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "agent-kernel-outside-"));
    const outsideFile = path.join(outsideDir, "outside.txt");
    await writeFile(outsideFile, "outside content\n");
    const mock = await startMock([
      callTool("call_1", "read", { path: outsideFile }),
      finalReply("read outside file"),
    ]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.equal(run.code, 0, `agent exited with ${run.code}\n${run.stderr}`);
      assert.match(run.stdout, /read outside file/);

      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /outside content/);
      assert.doesNotMatch(toolMessage.content, /ERROR/);
    } finally {
      await mock.close();
      await rm(outsideDir, { recursive: true, force: true });
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

test("--permission 已移除：明确报错，不调用模型", async () => {
  const mock = await startMock([finalReply("should not be reached")]);
  try {
    const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model" }, { args: ["--permission", "read-only", "do the task"] });

    assert.equal(run.code, 1);
    assert.match(run.stderr, /--permission was removed/);
    assert.match(run.stdout, /usage:/);
    assert.equal(mock.requests.length, 0, "被移除的开关不能产生模型调用");
  } finally {
    await mock.close();
  }
});

test("shell：无 TTY 也能直接执行，不需要审批", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_shell", "shell", { command: "echo shell-ran" }),
      finalReply("shell done"),
    ]);

    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });

      assert.equal(run.code, 0, run.stderr);
      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /shell-ran/);
      assert.doesNotMatch(toolMessage.content, /approval|permission denied/);
      assert.doesNotMatch(run.stdout, /\[permission\]|allow once/);
    } finally {
      await mock.close();
    }
  });
});

test("--cwd：工作区指向另一个目录，项目本身不用搬过去", async () => {
  await withWorkspace(async (target) => {
    const mock = await startMock([
      callTool("call_write", "write", { path: "opened.txt", content: "hello" }),
      finalReply("done"),
    ]);

    try {
      // 进程仍然从项目目录启动（runCli 的 cwd 就是 projectRoot），工作区却落在 target：
      // 这就是「像 Claude Code 那样打开一个目录」——工具看到的是 target，不是仓库。
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: "" },
        { args: ["--cwd", target, "写个文件"] },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.ok(run.stdout.includes(`workspace: ${target}`));
      assert.equal(await readFile(path.join(target, "opened.txt"), "utf8"), "hello");
      // 文件只能落在被打开的目录里：仓库根目录不该多出任何东西。
      await assert.rejects(readFile(path.join(projectRoot, "opened.txt"), "utf8"));
    } finally {
      await mock.close();
    }
  });
});

test("--cwd：目录不存在时立刻报错并给用法", async () => {
  const run = await runCli({}, { args: ["--cwd", path.join(projectRoot, "no-such-dir-for-cwd"), "task"] });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /--cwd is not a directory/);
  assert.match(run.stdout, /usage:/);
});

test("--help：不再介绍已移除的权限开关，并说明固定完全访问", async () => {
  const run = await runCli({}, { args: ["--help"] });

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /usage:/);
  assert.match(run.stdout, /full-access/);
  assert.doesNotMatch(run.stdout, /--permission|AGENT_PERMISSION|read-only|workspace-write|modes:/);
});

test("--repl 已移除：明确报错并给用法，不能变成一次模型请求", async () => {
  const mock = await startMock([finalReply("should not be reached")]);
  try {
    const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model" }, { args: ["--repl"] });

    assert.equal(run.code, 1);
    assert.match(run.stderr, /--repl was removed/);
    assert.match(run.stdout, /usage:/);
    // 关键：不能被当成普通位置参数吞下去，那会拿 "--repl" 当任务发给模型。
    assert.equal(mock.requests.length, 0, "被移除的开关不能产生模型调用");
  } finally {
    await mock.close();
  }
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
          input: "first task\n/help\n/reset\nsecond task\n/exit\n",
        },
      );

      assert.equal(run.code, 0, run.stderr);
      // 顶部状态栏（非 TTY 退化成三行）
      assert.match(run.stdout, /model: mock-model/);
      assert.ok(run.stdout.includes(`workspace: ${workdir}`));
      assert.match(run.stdout, /access: full-access/);

      // 中间运行记录：用户任务、工具调用、成功结果、模型回复
      assert.match(run.stdout, /you: first task/);
      assert.match(run.stdout, /→ write path=hello\.txt/);
      assert.match(run.stdout, /✓ write \[ok\] wrote 5 chars to hello\.txt/);
      assert.match(run.stdout, /model: tui first done/);
      // 第一轮两次请求，各 110 tokens
      assert.match(run.stdout, /\[stats\] requests=2 tool_calls=1 tokens=220/);

      // 会话命令：帮助、reset；权限固定，没有可切换的模式
      assert.doesNotMatch(run.stdout, /\/permission|unknown permission mode/);
      assert.match(run.stdout, /commands: \/exit/);
      assert.match(run.stdout, /\(session reset\)/);
      assert.match(run.stdout, /model: tui second done/);
      assert.match(run.stdout, /\[session\] runs=1 requests=1 tool_calls=0 tokens=110/);

      // reset 换 Agent 但不换配置：第二次请求回到 system + user。
      const secondRequest = mock.requests[2];
      assert.deepEqual(
        secondRequest.messages.map((message) => message.role),
        ["system", "user"],
      );
      assert.match(secondRequest.messages[0].content, /full access/);
    } finally {
      await mock.close();
    }
  });
});

test("TUI 过程概述：仅交互式 TUI 给模型可见进度指导，不新增请求或污染普通 CLI", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("finished")]);
    try {
      const env = { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir };
      const tui = await runCli(env, { args: ["--tui", "inspect"], input: "/exit\n" });
      assert.equal(tui.code, 0, tui.stderr);
      assert.equal(mock.requests.length, 1);
      assert.match(mock.requests[0].messages[0].content, /briefly tell the user what you are doing/);
      assert.match(mock.requests[0].messages[0].content, /never invent results/);
      assert.match(tui.stdout, /model: finished/);

      const ordinary = await runCli(env, { args: ["inspect"] });
      assert.equal(ordinary.code, 0, ordinary.stderr);
      assert.equal(mock.requests.length, 2, "进度说明不引入额外的模型请求");
      assert.doesNotMatch(mock.requests[1].messages[0].content, /interactive TUI|progress update/);
      assert.match(ordinary.stdout, /finished/);
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

test("TUI：中文任务后 /help 反馈显示中文，权限固定为完全访问", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("检查完成")]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--tui", "请检查项目文件"], input: "/help\n/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /access: full-access/);
      assert.match(run.stdout, /命令：\/exit/);
      assert.doesNotMatch(run.stdout, /\/permission/);
      assert.equal(mock.requests.length, 1);
      assert.match(mock.requests[0].messages[0].content, /full access/,
        "界面翻译不能修改模型收到的真实运行模式");
    } finally {
      await mock.close();
    }
  });
});

test("TUI：最后一步模型已确认说明但工具未执行，保留正文并标注 Run 失败", async () => {
  await withWorkspace(async (workdir) => {
    const response = callTool("pending_read", "read", { path: "unread.txt" });
    response.content = "CONFIRMED_STEP_EXPLANATION";
    const mock = await startMock([response]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, WORKDIR: workdir, MAX_STEPS: "1" },
        { args: ["--tui", "inspect"], input: "/exit\n" },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /model: CONFIRMED_STEP_EXPLANATION/);
      assert.doesNotMatch(run.stdout, /unconfirmed text discarded/);
      assert.match(run.stdout, /turn failed: step limit 1 reached/);
      assert.match(run.stdout, /were not run/);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：有效响应随后触发 Token 预算，也保留已确认说明", async () => {
  await withWorkspace(async (workdir) => {
    const response = callTool("pending_read", "read", { path: "unread.txt" });
    response.content = "CONFIRMED_TOKEN_EXPLANATION";
    const mock = await startMock([response], {
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    try {
      const run = await runCli(
        { BASE_URL: mock.url, WORKDIR: workdir, MAX_STEPS: "3", MAX_TOTAL_TOKENS: "2" },
        { args: ["--tui", "inspect"], input: "/exit\n" },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /model: CONFIRMED_TOKEN_EXPLANATION/);
      assert.doesNotMatch(run.stdout, /unconfirmed text discarded/);
      assert.match(run.stdout, /turn failed: token budget 2 reached/);
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：前一次说明已确认但下一次流式失败，只撤销新请求的草稿", async () => {
  await withWorkspace(async (workdir) => {
    const response = callTool("read_1", "read", { path: "missing.txt" });
    response.content = "CONFIRMED_FIRST_STEP";
    const mock = await startMock([response, finalReply("not reached")], { interruptAtTurn: 1 });
    try {
      const run = await runCli(
        { BASE_URL: mock.url, WORKDIR: workdir },
        { args: ["--tui", "inspect"], input: "/exit\n" },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /model: CONFIRMED_FIRST_STEP/);
      assert.equal((run.stdout.match(/model: CONFIRMED_FIRST_STEP/g) ?? []).length, 1);
      assert.match(run.stdout, /UNCONFIRMED_SECOND_REQUEST/);
      assert.doesNotMatch(run.stdout, /unconfirmed text discarded/);
      assert.match(run.stdout, /Model service unavailable/);
      assert.match(run.stdout, /preview is discarded/);
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：无 TTY 时 shell 直接执行，不出现审批提示", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_shell", "shell", { command: "echo shell-ran-in-tui" }),
      finalReply("shell ran in tui"),
    ]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--tui", "do it"], input: "/exit\n" },
      );

      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /→ shell echo shell-ran-in-tui/);
      assert.match(run.stdout, /shell-ran-in-tui/);
      assert.doesNotMatch(run.stdout, /\[permission\]|allow once|permission denied/);
      assert.match(run.stdout, /model: shell ran in tui/);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：旧 AGENT_TUI_SCREEN 不再影响模式，非 TTY 仍能正常退出", async () => {
  const run = await runCli(
    { AGENT_TUI_SCREEN: "never" },
    { args: ["--tui"], input: "/exit\n" },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stdout + run.stderr, /Terminal compatibility mode|终端兼容模式/);
});

test("AGENT_PERMISSION 已移除：退出码 1，不静默忽略残留配置", async () => {
  const run = await runCli({ AGENT_PERMISSION: "read-only" });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /AGENT_PERMISSION was removed/);
  assert.match(run.stdout, /usage:/);
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


test("CLI Shell 非零退出显示失败，但模型处理错误后整个 Run 仍可完成", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_shell", "shell", { command: 'node -e "process.exit(7)"' }),
      finalReply("handled shell failure"),
    ]);
    try {
      const run = await runCli(
        { BASE_URL: mock.url, WORKDIR: workdir },
        { args: ["do the task"] },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /↳ shell ✗ exit 7/);
      assert.doesNotMatch(run.stdout, /↳ shell ✓/);
      assert.match(run.stdout, /✓ Completed/);
      assert.match(run.stdout, /handled shell failure/);
      assert.equal(mock.requests.length, 2);
      const result = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.equal(result.tool_call_id, "call_shell");
      assert.match(result.content, /^exit 7\n/);
    } finally {
      await mock.close();
    }
  });
});

test("CLI 读取以 exit 7 开头的文件仍显示成功，不把正文当成 Shell 状态", async () => {
  await withWorkspace(async (workdir) => {
    await writeFile(path.join(workdir, "status.txt"), "exit 7\nordinary file content\n");
    const mock = await startMock([
      callTool("call_read", "read", { path: "status.txt" }),
      finalReply("file read done"),
    ]);
    try {
      const run = await runCli({ BASE_URL: mock.url, WORKDIR: workdir });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /↳ read ✓ exit 7/);
      assert.match(run.stdout, /✓ Completed/);
    } finally {
      await mock.close();
    }
  });
});

test("CLI TodoWrite：模型拿到结构化计划工具，更新结果进入下一轮", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("plan-1", "todo_write", { todos: [
        { content: "检查代码", status: "done" }, { content: "运行测试", status: "in_progress" },
      ] }),
      finalReply("plan recorded"),
    ]);
    try {
      const run = await runCli({ BASE_URL: mock.url, WORKDIR: workdir });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /todo_write/);
      assert.equal(mock.requests.length, 2);
      const declared = mock.requests[0].tools.find((tool) => tool.function?.name === "todo_write");
      assert.equal(declared?.function.parameters.properties.todos.type, "array");
      const result = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.equal(result.tool_call_id, "plan-1");
      assert.ok(result.content.startsWith("Todo list (1/2 done):"));
      assert.match(mock.requests[0].messages[0].content, /For multi-step tasks, call todo_write/);
    } finally {
      await mock.close();
    }
  });
});

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

test("CLI 模型正文与工具结果里的 ESC、bidi 字符只显示转义文本", async () => {
  await withWorkspace(async (workdir) => {
    const dangerous = "before" + String.fromCharCode(27) + "[31m" + String.fromCharCode(0x202e) + "spoofed";
    await writeFile(path.join(workdir, "unsafe.txt"), dangerous + "\n");
    const mock = await startMock([
      callTool("call_read", "read", { path: "unsafe.txt" }),
      finalReply(dangerous),
    ]);
    try {
      const run = await runCli({ BASE_URL: mock.url, WORKDIR: workdir });
      assert.equal(run.code, 0, run.stderr);
      assert.doesNotMatch(run.stdout, /[\x1b\u202e]/);
      assert.match(run.stdout, /\\u001b/);
      assert.match(run.stdout, /\\u202e/);
      assert.match(run.stdout, /✓ Completed/);
      assert.equal(mock.requests.length, 2);
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

test("TUI：HTTP 429 真的重试一次并统一显示重连状态，累计真实请求次数", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("after reconnect")], { httpStatus: [429, 200] });
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--tui", "hello"], input: "/exit\n" },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(mock.requests.length, 2, "第 2 次请求才真正成功");
      assert.match(run.stdout, /Reconnecting\.\.\. 1\/5/);
      assert.match(run.stdout, /after reconnect/);
      assert.match(run.stdout, /requests=2/);
      assert.doesNotMatch(run.stdout, /Model authentication failed/);
    } finally {
      await mock.close();
    }
  });
});

test("TUI：HTTP 404 不触发自动重连，展示统一类别并保留实际 HTTP 码", async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("no")], { httpStatus: 404 });
    try {
      const run = await runCli(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        { args: ["--tui", "hello"], input: "/exit\n" },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(mock.requests.length, 1);
      assert.match(run.stdout, /HTTP 404 · Model service unavailable/);
      assert.doesNotMatch(run.stdout, /Reconnecting\.\.\./);
    } finally {
      await mock.close();
    }
  });
});

test("项目指令：工作区的 AGENTS.md 注入系统提示，没有该文件时不注入", async () => {
  await withWorkspace(async (workdir) => {
    await writeFile(path.join(workdir, "AGENTS.md"), "# 项目规范\n\n- 提交前必须跑 npm run check\n");
    const mock = await startMock([finalReply("ok")]);
    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.equal(run.code, 0, run.stderr);
      const system = mock.requests[0].messages[0];
      assert.equal(system.role, "system");
      assert.match(system.content, /Project instructions \(AGENTS\.md\)/, "注入时必须标明来源");
      assert.match(system.content, /提交前必须跑 npm run check/, "项目规范正文要原样进入提示");
    } finally {
      await mock.close();
    }
  });

  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("ok")]);
    try {
      const run = await runCli({ BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir });
      assert.equal(run.code, 0, run.stderr);
      assert.doesNotMatch(mock.requests[0].messages[0].content, /Project instructions/);
    } finally {
      await mock.close();
    }
  });
});

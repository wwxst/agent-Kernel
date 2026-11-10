/**
 * 真实 PTY 回归测试：覆盖一次性任务里的「允许一次 / 拒绝 / Ctrl-C / EOF」。
 *
 * 为什么需要 PTY：审批走 readline 的终端 raw mode，管道输入模拟不了 Ctrl-C 和 EOF。
 * 这里用 Linux 自带的 script(1) 分配伪终端；Windows 没有等价的零依赖工具，
 * 对应逻辑由 approval.test.mjs 的假 reader 单测覆盖。
 *
 * 这些用例的价值是「不挂住」：修复前，question() 不接 signal，Ctrl-C / EOF
 * 可能让进程停在审批上；超时会直接判失败，而不是让 CI 一起卡死。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callTool, finalReply, withWorkspace } from "./support/harness.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(projectRoot, "src", "cli.ts");
const hasScript =
  process.platform === "linux" && spawnSync("sh", ["-c", "command -v script"], { stdio: "ignore" }).status === 0;
const skip = hasScript ? false : "PTY tests use Linux script(1)";

/** 启动一个按脚本回放的流式 mock 端点；PTY 测试只关心审批交互。 */
async function startMock(script) {
  const requests = [];
  let turn = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const message = script[Math.min(turn++, script.length - 1)];
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta, finishReason = null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      response.write(frame({ ...message }));
      response.write(frame({}, message.tool_calls?.length ? "tool_calls" : "stop"));
      response.end("data: [DONE]\n\n");
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

/** 在 sh -c 的命令串里安全地放一个参数。 */
function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 杀掉 script 及其子进程组，避免超时用例留下孤儿。 */
function killTree(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程可能已经退出；这里不再制造第二个错误。
    }
  }
}

/**
 * 用 script(1) 给 CLI 分配 PTY，等审批提示出现后再写入回答/控制字节。
 * 15 秒还没结束就判超时 —— 这正是「审批卡住」的回归信号。
 */
function runPty(env, args, answer, { initialInput } = {}) {
  const command = [process.execPath, cliPath, ...args].map(shellQuote).join(" ");
  const child = spawn("script", ["-q", "-e", "-f", "-c", command, "/dev/null"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      API_KEY: "test-key",
      OPENAI_API_KEY: "",
      TERM: "xterm",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  // REPL 用例需要先喂一条任务；PTY 的输入会缓冲到 readline 建好之后。
  if (initialInput !== undefined) child.stdin.write(initialInput);

  let stdout = "";
  let stderr = "";
  let sent = false;
  let timedOut = false;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      resolve({ code: null, stdout, stderr, timedOut });
    }, 15_000);

    const maybeAnswer = () => {
      if (sent || !stdout.includes("[permission] shell in")) return;
      sent = true;
      answer(child);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      maybeAnswer();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      maybeAnswer();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

test("PTY：允许一次后 shell 真正执行", { skip }, async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_allow", "shell", { command: "echo pty-allow\necho pty-allow-2" }),
      finalReply("allow path done"),
    ]);

    try {
      const run = await runPty(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        ["--permission", "workspace-write", "do the task"],
        (child) => child.stdin.write("y\n"),
      );

      assert.equal(run.timedOut, false, `approval hung:\n${run.stdout}\n${run.stderr}`);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /allow path done/);
      // 多行命令要在审批界面逐行展示，而不是折叠成一行。
      assert.match(run.stdout, /\| echo pty-allow/);
      assert.match(run.stdout, /\| echo pty-allow-2/);
      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /pty-allow/);
      assert.match(toolMessage.content, /pty-allow-2/);
    } finally {
      await mock.close();
    }
  });
});

test("PTY：拒绝后 shell 不执行，模型继续收尾", { skip }, async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_deny", "shell", { command: "echo pty-deny" }),
      finalReply("deny path done"),
    ]);

    try {
      const run = await runPty(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        ["--permission", "workspace-write", "do the task"],
        (child) => child.stdin.write("n\n"),
      );

      assert.equal(run.timedOut, false, `approval hung:\n${run.stdout}\n${run.stderr}`);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /deny path done/);
      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /^ERROR: permission denied: user denied/);
    } finally {
      await mock.close();
    }
  });
});

test("PTY：审批中 Ctrl-C 及时取消，退出码 130", { skip }, async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_interrupt", "shell", { command: "echo pty-interrupt" }),
    ]);

    try {
      const run = await runPty(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        ["--permission", "workspace-write", "do the task"],
        (child) => child.stdin.write("\u0003"),
      );

      assert.equal(run.timedOut, false, `approval hung after Ctrl-C:\n${run.stdout}\n${run.stderr}`);
      assert.equal(run.code, 130, run.stderr);
      // script(1) 把子进程的 stderr 也接到同一个 PTY，所以取消文案可能出现在 stdout。
      assert.match(run.stdout + run.stderr, /cancelled/);
    } finally {
      await mock.close();
    }
  });
});

test("PTY：审批中 EOF 明确结束等待并默认拒绝", { skip }, async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_eof", "shell", { command: "echo pty-eof" }),
      finalReply("eof path done"),
    ]);

    try {
      const run = await runPty(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        ["--permission", "workspace-write", "do the task"],
        (child) => {
          child.stdin.write("\u0004");
          child.stdin.end();
        },
      );

      assert.equal(run.timedOut, false, `approval hung after EOF:\n${run.stdout}\n${run.stderr}`);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /eof path done/);
      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /^ERROR: permission denied: .*closed before an answer/);
    } finally {
      await mock.close();
    }
  });
});

test("PTY REPL：审批中 EOF 报审批通道关闭，而不是用户拒绝", { skip }, async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([
      callTool("call_repl_eof", "shell", { command: "echo pty-repl-eof" }),
      finalReply("repl eof done"),
    ]);

    try {
      const run = await runPty(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        ["--repl", "--permission", "workspace-write"],
        (child) => {
          child.stdin.write("\u0004");
          child.stdin.end();
        },
        { initialInput: "do the task\n" },
      );

      assert.equal(run.timedOut, false, `approval hung after REPL EOF:\n${run.stdout}\n${run.stderr}`);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /repl eof done/);
      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /^ERROR: permission denied: .*approval prompt closed/);
      assert.doesNotMatch(toolMessage.content, /user denied/);
    } finally {
      await mock.close();
    }
  });
});

test("PTY：TERM=dumb 时完整 TUI 明确拒绝，不输出半截备用屏幕", { skip }, async () => {
  const run = await runPty({ TERM: "dumb" }, ["--tui", "inspect"], () => {});
  assert.equal(run.timedOut, false);
  assert.equal(run.code, 1);
  assert.match(run.stdout + run.stderr, /full-screen TUI requires an interactive terminal/);
  assert.doesNotMatch(run.stdout, /\x1b\[\?1049h|Terminal compatibility mode|line-by-line output/,
    "不具备能力时应立即报错，而不是打印一半固定界面或切逐行模式");
});

test("PTY：未配置模型能进入真实 TUI，右上角显示状态且不产生虚假请求", { skip }, async () => {
  const command = [process.execPath, cliPath, "--tui"].map(shellQuote).join(" ");
  const child = spawn("script", ["-q", "-e", "-f", "-c", command, "/dev/null"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      API_KEY: "sk-your-key-here",
      OPENAI_API_KEY: "",
      MODEL: "mock-demo",
      TERM: "xterm",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  let sentExit = false;
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      killTree(child);
      resolve({ code: null, timedOut: true });
    }, 15_000);
    child.stdout.on("data", (data) => {
      stdout += String(data);
      if (!sentExit && stdout.includes("未配置模型")) {
        sentExit = true;
        child.stdin.write("/exit\n");
      }
    });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ code: null, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, timedOut: false });
    });
  });
  assert.equal(result.timedOut, false, "TUI hung: " + stdout + stderr);
  assert.equal(result.code, 0, stdout + stderr);
  assert.match(stdout, /未配置模型/);
  assert.doesNotMatch(stdout, /mock-demo|Thinking\.\.\.|请求=1|requests=1/);
});


test("PTY：真实 TUI 接收鼠标字节不污染命令，进入和退出时恢复终端模式", { skip }, async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("PTY_TUI_COMPLETE")]);
    const command = [process.execPath, cliPath, "--tui", "inspect"].map(shellQuote).join(" ");
    const child = spawn("script", ["-q", "-e", "-f", "-c", command, "/dev/null"], {
      cwd: projectRoot,
      env: { ...process.env, API_KEY: "test-key", OPENAI_API_KEY: "", TERM: "wyse60",
        AGENT_TUI_SCREEN: "never", BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
      stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    let output = "";
    let error = "";
    let sent = false;
    let timedOut = false;
    const completion = new Promise((resolve) => {
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, 15_000);
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (!sent && output.includes("PTY_TUI_COMPLETE")) {
          sent = true;
          // 实际 SGR 鼠标报告不应该被 readline 当成键盘输入。
          child.stdin.write("\x1b[<0;50;9M");
          child.stdin.write("/exit\r");
        }
      });
      child.stderr.on("data", (chunk) => { error += String(chunk); });
      child.on("close", (code) => { clearTimeout(timer); resolve(code); });
      child.on("error", (reason) => { clearTimeout(timer); error += String(reason); resolve(null); });
    });
    try {
      const code = await completion;
      assert.equal(timedOut, false, "TUI did not exit: " + output + error);
      assert.equal(code, 0, error);
      assert.match(output, /\x1b\[\?1049h/, "即使 TERM 未知也必须打开完整备用屏幕");
      assert.doesNotMatch(output, /Terminal compatibility mode|line-by-line output/,
        "已取消的 AGENT_TUI_SCREEN=never 也不能让 TUI 变回兼容界面");
      assert.match(output, /\x1b\[\?1000h\x1b\[\?1006h/);
      assert.match(output, /\x1b\[\?1006l\x1b\[\?1000l/);
      assert.match(output, /\x1b\[\?1049l/);
      assert.equal(mock.requests.length, 1, "鼠标坐标不能被当成用户的新任务");
      assert.match(mock.requests[0].messages[0].content, /briefly tell the user what you are doing/,
        "完整 TUI 保留专用过程概述提示，而非普通 CLI 的系统提示");
    } finally {
      child.stdin.destroy();
      await mock.close();
    }
  });
});

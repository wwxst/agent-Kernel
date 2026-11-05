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
function runPty(env, task, answer) {
  const command = [process.execPath, cliPath, "--permission", "workspace-write", task]
    .map(shellQuote)
    .join(" ");
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
      if (sent || !stdout.includes("[permission] allow shell once")) return;
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
      callTool("call_allow", "shell", { command: "echo pty-allow" }),
      finalReply("allow path done"),
    ]);

    try {
      const run = await runPty(
        { BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
        "do the task",
        (child) => child.stdin.write("y\n"),
      );

      assert.equal(run.timedOut, false, `approval hung:\n${run.stdout}\n${run.stderr}`);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /allow path done/);
      const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /pty-allow/);
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
        "do the task",
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
        "do the task",
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
        "do the task",
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

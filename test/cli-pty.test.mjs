/**
 * 文件目的：测真实终端里的启动和打字（只在 Linux 上跑）。
 *
 * 为什么要单独测：管道里模拟不了真实终端的行为，比如按 Ctrl-C、按 Ctrl-D 结束输入。
 * 为什么只在 Linux 跑：Windows 上没有现成的工具能造出这种「假终端」，
 * 那部分行为改由 `tui.test.mjs` 用模拟的输入输出覆盖。
 *
 * 这些用例的价值是「不会卡住」—— 一旦卡住，超时直接判失败，不会把整个检查拖死。
 *
 * 文件职责：负责在真 PTY 里启动 `src/cli.ts`、喂按键、断言屏幕输出。
 * 不负责布局细节、颜色、折叠（那些在假终端里测更快更稳）。
 *
 * 内容目录：
 *   - `startMock()`：按脚本回放的流式假端点；`shellQuote()` / `killTree()`：起停辅助。
 *   - 用例一：没配模型也能进 TUI，右上角显示状态，且不发出虚假请求。
 *   - 用例二：不抢鼠标、不进备用屏，杂散的鼠标字节不会污染输入。
 *
 * 模块关系：依赖 `src/cli.ts`（作为子进程启动）、`test/support/harness.mjs` 与 Node 内置模块。
 * 由 `npm test` 启动，非 Linux 平台自动跳过。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { finalReply, withWorkspace } from "./support/harness.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(projectRoot, "src", "cli.ts");
const hasScript =
  process.platform === "linux" && spawnSync("sh", ["-c", "command -v script"], { stdio: "ignore" }).status === 0;
const skip = hasScript ? false : "PTY tests use Linux script(1)";

/** 启动一个按脚本回放的流式 mock 端点；PTY 测试只关心真实终端交互。 */
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
        child.stdin.write("/exit\r");
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


test("PTY：真实 TUI 不抢鼠标、不进备用屏，杂散鼠标字节不污染命令", { skip }, async () => {
  await withWorkspace(async (workdir) => {
    const mock = await startMock([finalReply("PTY_TUI_COMPLETE")]);
    const command = [process.execPath, cliPath, "--tui", "inspect"].map(shellQuote).join(" ");
    const child = spawn("script", ["-q", "-e", "-f", "-c", command, "/dev/null"], {
      cwd: projectRoot,
      env: { ...process.env, API_KEY: "test-key", OPENAI_API_KEY: "", TERM: "vt100",
        BASE_URL: mock.url, MODEL: "mock-model", WORKDIR: workdir },
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
      assert.match(output, /PTY_TUI_COMPLETE/);
      // 主视图在主屏就地追加：既不切备用屏，也不捕获鼠标（滚轮/选中保持原生）。
      assert.doesNotMatch(output, /\x1b\[\?1049h/, "主视图不进备用屏");
      assert.doesNotMatch(output, /\x1b\[\?1000h/, "不捕获鼠标");
      assert.equal(mock.requests.length, 1, "鼠标坐标不能被当成用户的新任务");
    } finally {
      child.stdin.destroy();
      await mock.close();
    }
  });
});

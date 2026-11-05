/**
 * TUI 显示与审批的单元测试：用假输入/输出流驱动，不需要真终端。
 *
 * 断言的是外部行为：状态栏有什么、运行记录怎么分类、审批提示是否完整、
 * y/N 是否真的变成放行/拒绝。固定布局的转义序列只在这里做最低限度的保护性断言，
 * 真实终端行为留给手动验收 —— 没有 TTY 的 CI 不该假装自己验过光标。
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Tui } from "../src/tui.ts";

/** 等一轮微任务/IO：readline 的 line 事件不会在 write() 返回前同步跑完。 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 一套假终端。interactive=true 只打开审批通道；tty=true 才模拟 stdout 是终端，
 * 从而启用固定布局。两者分开，才能在无 TTY 的测试里单独验证审批逻辑。
 */
function makeTui({ interactive = false, tty = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (tty) {
    output.isTTY = true;
    output.columns = 80;
    output.rows = 24;
  }

  const controller = new AbortController();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));

  const tui = new Tui({
    input,
    output,
    model: "mock-model",
    workspace: "C:\\work\\repo",
    permission: "workspace-write",
    controller,
    interactive,
    columns: 80,
    rows: 24,
    layout: tty,
  });

  return {
    tui,
    input,
    output,
    controller,
    text: () => chunks.join(""),
    cleanup: () => {
      tui.close();
      input.end();
    },
  };
}

const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12, reported: 2, unknown: 0 };
const session = { runs: 1, requests: 2, toolCalls: 2, usage };

test("TUI：状态栏、运行记录、成功/拒绝分类和统计", async (t) => {
  const ui = makeTui();
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.beginTurn("do it");
  ui.tui.assistantDelta("working");
  ui.tui.assistantDelta(" on it\nsecond line");
  ui.tui.finishAssistant("");
  ui.tui.toolCall({
    id: "c1",
    type: "function",
    function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) },
  });
  ui.tui.toolResult(
    { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
    "read result",
  );
  const shellCall = {
    id: "c2",
    type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command: "echo hi" }) },
  };
  ui.tui.toolCall(shellCall);
  ui.tui.toolResult(shellCall, 'ERROR: permission denied: user denied tool "shell"');
  ui.tui.setStats(session);
  ui.tui.finishTurn(
    { requests: 2, toolCalls: 2, usage, tokenBudget: { exceeded: false } },
    session,
    { failed: true },
  );
  ui.tui.sessionSummary(session);
  await tick();

  const text = ui.text();
  assert.match(text, /model: mock-model/);
  assert.match(text, /workspace: C:\\work\\repo/);
  assert.match(text, /permission: workspace-write/);
  assert.match(text, /you: do it/);
  assert.match(text, /model: working on it/);
  assert.match(text, /second line/);
  assert.match(text, /→ read path=a\.txt/);
  assert.match(text, /✓ read \[ok\] read result/);
  assert.match(text, /→ shell echo hi/);
  assert.match(text, /✗ shell \[denied\] permission denied: user denied tool "shell"/);
  assert.match(text, /\[stats\] requests=2 tool_calls=2 tokens=12 · task failed/);
  assert.match(text, /\[session\] runs=1 requests=2 tool_calls=2 tokens=12/);
});

test("TUI：审批完整显示多行命令和 cwd，y 只放行这一次", async (t) => {
  const ui = makeTui({ interactive: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  const pending = ui.tui.approve({
    tool: "shell",
    args: { command: "echo hi\necho bye" },
  });
  ui.input.write("y\n");

  assert.equal(await pending, true);
  await tick();
  const text = ui.text();
  assert.match(text, /\[permission\] shell in C:\\work\\repo/);
  assert.match(text, /command:/);
  assert.match(text, /\| echo hi/);
  assert.match(text, /\| echo bye/);
  assert.match(text, /allow once\? \[y\/N\]/);
  assert.match(text, /approval: allowed once/);
});

test("TUI：审批回答 n 是拒绝，并写出 denied", async (t) => {
  const ui = makeTui({ interactive: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo nope" } });
  ui.input.write("n\n");

  assert.equal(await pending, false);
  await tick();
  assert.match(ui.text(), /approval: denied/);
});

test("TUI：没有 TTY 时不展示审批提示，直接按审批通道拒绝", async (t) => {
  const ui = makeTui();
  t.after(() => ui.cleanup());

  await assert.rejects(
    () => ui.tui.approve({ tool: "shell", args: { command: "echo nope" } }),
    /no interactive terminal/,
  );
  await tick();
  assert.doesNotMatch(ui.text(), /\[permission\]/);
});

test("TUI：已有排队输入时不把下一行当成审批答案", async (t) => {
  const ui = makeTui({ interactive: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.input.write("queued task\n");
  await tick();

  await assert.rejects(
    () => ui.tui.approve({ tool: "shell", args: { command: "echo nope" } }),
    /next input is already queued/,
  );
  // 那一行仍然属于下一轮任务，没有被审批吃掉。
  assert.equal(await ui.tui.readLine(), "queued task");
});

test("TUI：审批中 EOF 报审批通道关闭，不冒充用户拒绝", async (t) => {
  const ui = makeTui({ interactive: true });
  t.after(() => ui.cleanup());

  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo eof" } });
  ui.input.end();

  await assert.rejects(pending, /approval prompt closed/);
  await tick();
  assert.doesNotMatch(ui.text(), /user denied/);
});

test("TUI：审批中取消立即结束等待，不会卡在输入上", async (t) => {
  const ui = makeTui({ interactive: true });
  t.after(() => ui.cleanup());

  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo interrupt" } });
  ui.controller.abort(new Error("received SIGINT"));

  await assert.rejects(pending, /task cancelled/);
});

test("TUI：模型请求期间显示 thinking，第一段正文前原地清掉", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.setThinking(true);
  await tick();
  assert.match(ui.text(), /thinking\.\.\./);

  ui.tui.assistantDelta("hello");
  ui.tui.finishAssistant("");
  await tick();
  const text = ui.text();
  // thinking 行被同一行的清行序列覆盖，而不是留在记录里另起一行。
  assert.match(text, /\r\x1b\[2K/);
  assert.match(text, /model: hello/);
});

test("TUI：行式聊天同样在回复前显示 thinking，并在正文前原地清掉", async (t) => {
  const ui = makeTui({ interactive: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.setThinking(true);
  await tick();
  assert.match(ui.text(), /thinking\.\.\./);

  ui.tui.assistantDelta("hello");
  ui.tui.finishAssistant("");
  await tick();
  const text = ui.text();
  assert.match(text, /\r\x1b\[2K/);
  assert.match(text, /model: hello/);
});

test("TUI：TTY 布局固定顶部状态栏和统计行，输入固定在底部，不切 alternate screen", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  await tick();
  const started = ui.text();
  assert.match(started, /\x1b\[3;23r/, "滚动区域应在统计行下方、输入行结束，最后一行留作缓冲");
  assert.match(started, /model mock-model/);
  assert.match(started, /permission workspace-write/);
  assert.match(started, /requests=0 {2}tool_calls=0 {2}tokens=0/);
  assert.doesNotMatch(started, /\x1b\[\?1049h/, "轻量 TUI 不切 alternate screen");

  ui.tui.close();
  await tick();
  assert.match(ui.text(), /\x1b\[r/, "退出时要恢复滚动区域");
});

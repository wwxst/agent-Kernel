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

/** 取最后一次完整写入的行；验收输入框实际内容，不能只检查旧帧里出现过某个词。 */
function lastRow(text, row) {
  return [...text.matchAll(new RegExp(`\\x1b\\[${row};1H\\x1b\\[2K([^\\x1b]*)`, "g"))].at(-1)?.[1] ?? "";
}

/**
 * 一套假终端。interactive=true 只打开审批通道；tty=true 才模拟 stdout 是终端，
 * 从而启用固定布局。两者分开，才能在无 TTY 的测试里单独验证审批逻辑。
 */
function makeTui({ interactive = false, tty = false, columns = 80, rows = 24, color = false, flowInput = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (tty) {
    output.isTTY = true;
    output.columns = columns;
    output.rows = rows;
  }

  const controller = new AbortController();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));

  const previousTerm = process.env.TERM;
  if (interactive) process.env.TERM = "xterm-256color";
  const tui = new Tui({
    input,
    output,
    model: "mock-model",
    workspace: "C:\\work\\repo",
    permission: "workspace-write",
    controller,
    interactive,
    columns,
    rows,
    layout: tty,
    color,
    flowInput,
  });
  if (previousTerm === undefined) delete process.env.TERM;
  else process.env.TERM = previousTerm;

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

test("TUI：标题标明程序和项目，用户正文与输入边界使用中性层次", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, color: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("READ_ME");
  await tick();
  assert.match(ui.text(), /agent-Kernel · repo/);
  assert.match(ui.text(), /\x1b\[1m\x1b\[39m(?:❯|>) READ_ME/);
  const inputTop = ui.text().slice(ui.text().lastIndexOf("\x1b[18;1H\x1b[2K"));
  assert.match(inputTop, /\x1b\[(?:90|38;5;244)m[┌+]/);
});

test("TUI：回答审批后收起已结束的面板，保留决定与工具结果", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const call = { id: "approval", type: "function", function: { name: "shell", arguments: '{"command":"echo safe"}' } };
  ui.tui.toolCall(call);
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  assert.match(ui.text(), /Allow this command\?/);
  ui.input.write("n\r");
  assert.equal(await pending, false);
  ui.tui.toolResult(call, 'ERROR: permission denied: user denied tool "shell"');
  await tick();
  const screen = Array.from({ length: 14 }, (_, index) => lastRow(ui.text(), index + 4)).join("\n");
  assert.doesNotMatch(screen, /Allow this command\?|Shell permission|\[Y\] Allow once/);
  assert.match(screen, /(?:⊘|!) Denied/);
  assert.match(screen, /(?:⊘|!) Shell: echo safe/);
  assert.match(screen, /permission denied/);
});

test("TUI：Shell 非零退出显示失败，文件中的退出码文本仍是成功读取", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const call = { id: "exit", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: 'node -e "process.exitCode=7"' }) } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "exit 7\nfailed check\nnext step");
  await tick();
  assert.match(lastRow(ui.text(), 4), /(?:✗|x) Shell/);
  assert.match(lastRow(ui.text(), 5), /exit 7/);
  assert.match(lastRow(ui.text(), 6), /failed check/);
  assert.match(lastRow(ui.text(), 7), /next step/);

  const read = { id: "read-exit", type: "function", function: { name: "read", arguments: '{"path":"status.txt"}' } };
  ui.tui.toolCall(read);
  ui.tui.toolResult(read, "exit 7\nfailed check");
  await tick();
  assert.match(lastRow(ui.text(), 9), /(?:✓|\+) Read status\.txt/);
  assert.match(lastRow(ui.text(), 10), /Received 2 lines/);
});

test("TUI：Shell 超时、取消和无退出码显示失败，正常退出保留成功", async (t) => {
  for (const status of ["timeout after 25ms", "cancelled by signal", "exit null", "exit -1", "exit 0"]) {
    const ui = makeTui({ interactive: true, tty: true });
    t.after(() => ui.cleanup());
    ui.tui.start();
    const call = { id: "status", type: "function", function: { name: "shell", arguments: '{"command":"node -e 0"}' } };
    ui.tui.toolCall(call);
    ui.tui.toolResult(call, `${status}\n`);
    await tick();
    assert.match(lastRow(ui.text(), 4), status === "exit 0" ? /(?:✓|\+) Shell/ : /(?:✗|x) Shell/, status);
    assert.match(lastRow(ui.text(), 5), new RegExp(status));
  }
});

test("TUI：工具名称使用中性粗体，状态单独着色，结果显示缩进子行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, color: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const call = { id: "hierarchy", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "one\ntwo\n… [truncated 400 chars]");
  await tick();
  assert.match(ui.text(), /\x1b\[1m\x1b\[39mRead README\.md/);
  assert.match(ui.text(), /(?:└|\+) Received 3 lines/);
  assert.match(ui.text(), /… \[truncated 400 chars\]/, "摘要仍须报告读取不完整");
  assert.doesNotMatch(ui.text(), /one\ntwo/);
});

test("TUI：Thinking 显示真实经过秒数和取消提示，正文到达后停止计时", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.setThinking(true);
  assert.match(ui.text(), /Thinking\.\.\. · 0s · Ctrl-C to cancel/);
  t.mock.timers.tick(2000);
  assert.match(ui.text(), /Thinking\.\.\. · 2s · Ctrl-C to cancel/);
  ui.tui.assistantDelta("hello");
  const finished = ui.text().length;
  t.mock.timers.tick(3000);
  assert.equal(ui.text().length, finished, "正文后不再因等待计时重绘");
  assert.doesNotMatch(lastRow(ui.text(), 6), /Thinking/);
});

test("TUI：Shell 审批正文中性显示，输入明确 y/N 且默认拒绝", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, color: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  pending.catch(() => {});
  await tick();
  assert.match(ui.text(), /\[N\] Deny \(default\)/);
  assert.match(ui.text(), /y\/N > /);
  assert.match(ui.text(), /\x1b\[39m[^\x1b]*echo safe/);
  ui.input.write("\r");
  assert.equal(await pending, false);
  const finalInput = ui.text().slice(ui.text().lastIndexOf("\x1b[19;1H\x1b[2K"));
  assert.doesNotMatch(finalInput, /y\/N/, "审批结束后恢复普通聊天输入提示");
});

test("TUI：错误和非流式正文到达同样清除等待计时", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.setThinking(true);
  ui.tui.logError("ERROR: offline");
  assert.doesNotMatch(lastRow(ui.text(), 5), /Thinking/);
  ui.tui.setThinking(true);
  ui.tui.finishAssistant("non-stream reply");
  const length = ui.text().length;
  t.mock.timers.tick(2000);
  assert.equal(ui.text().length, length);
});

test("TUI：长输入留在单行框内，滚动和光标编辑不丢文字", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 34 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  const task = "abcdefghijklmnopqrstuvwxyz0123456789";
  ui.input.write(task);
  await tick();
  assert.match(lastRow(ui.text(), 19), /6789\s*[|│]\s*$/);
  assert.ok(lastRow(ui.text(), 19).length <= 33, "输入行不能超过终端右边界");
  ui.input.write("\x1b[H");
  await tick();
  assert.match(lastRow(ui.text(), 19), /abcde/);
  ui.input.write("X");
  ui.input.write("\x1b[5~");
  await tick();
  ui.input.write("\r");
  assert.equal(await pending, `X${task}`);
});

test("TUI：等待输入时新输出仍刷新，编辑位置和文字保持", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("draft");
  ui.input.write("\x1b[D");
  await tick();
  ui.tui.logLine("new output");
  await tick();
  assert.match(lastRow(ui.text(), 4), /new output/);
  assert.match(lastRow(ui.text(), 19), /draft/);
  ui.input.write("X\r");
  assert.equal(await pending, "drafXt");
});

test("TUI：长正文续行保持正文缩进，工具和回复间留白", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 34 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const call = { id: "r", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "file body");
  ui.tui.finishAssistant("abcdefghijklmnopqrstuvwxyz0123456789");
  await tick();
  assert.match(lastRow(ui.text(), 5), /Received 1 line/);
  assert.equal(lastRow(ui.text(), 6).trim(), "");
  assert.match(lastRow(ui.text(), 7), /(?:✻|\*) abcdef/);
  assert.match(lastRow(ui.text(), 8), /^    23456789/);
});

test("TUI：审批 resize 后按新宽度重排，完整命令仍可翻阅", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo " + "a".repeat(100) + "\necho TAIL" } });
  ui.output.columns = 34;
  ui.output.emit("resize");
  await tick();
  assert.match(ui.text(), /echo TAIL/);
  assert.match(lastRow(ui.text(), 5), /^  [|│] Workspace: C:\\work\\repo\s+[|│]$/);
  for (let row = 4; row < 34; row++) {
    assert.ok(lastRow(ui.text(), row).length <= 34, `第 ${row} 行不应超宽`);
  }
  ui.input.write("n\r");
  assert.equal(await pending, false);
});

test("TUI：超过日志上限的审批保留命令开头，PageUp 可以查看", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const command = "echo BEGIN\n" + "echo line\n".repeat(2100) + "echo TAIL\u001b[31m\u202e";
  const pending = ui.tui.approve({ tool: "shell", args: { command } });
  pending.catch(() => {});
  assert.match(ui.text(), /echo TAIL\\u001b\[31m\\u202e/);
  for (let index = 0; index < 210; index++) ui.input.emit("keypress", "", { name: "pageup" });
  await tick();
  assert.match(Array.from({ length: 14 }, (_, index) => lastRow(ui.text(), index + 4)).join("\n"), /echo BEGIN/);
  ui.input.write("n\r");
  assert.equal(await pending, false);
});

test("TUI：缩至窄窗口后使用逐行输出，恢复宽度后重新显示历史和草稿", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("中文draft");
  await tick();
  ui.output.columns = 20;
  ui.output.rows = 8;
  const start = ui.text().length;
  ui.output.emit("resize");
  ui.tui.logLine("narrow output");
  await tick();
  assert.doesNotMatch(ui.text().slice(start), /\x1b\[\d+;\d+H/);
  ui.output.columns = 80;
  ui.output.rows = 24;
  ui.output.emit("resize");
  await tick();
  assert.match(lastRow(ui.text(), 4), /narrow output/);
  assert.match(lastRow(ui.text(), 19), /中文draft/);
  ui.input.write("\r");
  assert.equal(await pending, "中文draft");
});

test("TUI：窄屏状态行保留完整权限和请求/token 统计", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 34 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.setStats(session);
  await tick();
  assert.match(lastRow(ui.text(), 21), /workspace-write/);
  assert.match(lastRow(ui.text(), 21), /2r 12tok/);
  assert.ok(lastRow(ui.text(), 21).length <= 34);
});

test("TUI：窄窗口期间工具状态只保留最终结果，放大后不重复", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.output.columns = 20;
  ui.output.emit("resize");
  ui.tui.beginTurn("TASK_NARROW");
  const call = { id: "r", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "body");
  ui.output.columns = 80;
  ui.output.emit("resize");
  await tick();
  assert.match(lastRow(ui.text(), 4), /TASK_NARROW/);
  assert.match(lastRow(ui.text(), 6), /(?:✓|\+) Read a.txt/);
  assert.match(lastRow(ui.text(), 7), /Received 1 line/);
  assert.equal(lastRow(ui.text(), 8).trim(), "");
});

test("TUI：窄屏启动后放大，输入中的草稿持续可见", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 20, rows: 8 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.output.columns = 80;
  ui.output.rows = 24;
  ui.output.emit("resize");
  ui.input.write("VISIBLE_DRAFT");
  await tick();
  assert.match(lastRow(ui.text(), 19), /VISIBLE_DRAFT/);
  ui.input.write("\r");
  assert.equal(await pending, "VISIBLE_DRAFT");
});

test("TUI：输入里的 Tab 安全显示，提交的原文保持不变", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 34 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  const task = "x\t".repeat(15);
  ui.input.write(task);
  await tick();
  assert.doesNotMatch(lastRow(ui.text(), 19), /\t/);
  assert.match(lastRow(ui.text(), 19), /\\u0009/);
  assert.ok(lastRow(ui.text(), 19).length <= 34);
  ui.input.write("\r");
  assert.equal(await pending, task);
});

test("TUI：审批从窄窗口开始，放大后仍可查阅超过日志上限的开头", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 20, rows: 8 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo BEGIN\n" + "echo line\n".repeat(2100) + "echo TAIL" } });
  pending.catch(() => {});
  ui.output.columns = 80;
  ui.output.rows = 24;
  ui.output.emit("resize");
  for (let index = 0; index < 210; index++) ui.input.emit("keypress", "", { name: "pageup" });
  await tick();
  assert.match(Array.from({ length: 14 }, (_, index) => lastRow(ui.text(), index + 4)).join("\n"), /echo BEGIN/);
  ui.input.write("n\r");
  assert.equal(await pending, false);
});

test("TUI：审批中的回车等控制字符逐字转义", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo first\r\necho next\recho tail\t\u202e" } });
  pending.catch(() => {});
  assert.match(ui.text(), /echo first\\u000d/);
  assert.match(ui.text(), /echo next\\u000decho tail\\u0009\\u202e/);
  ui.input.write("n\r");
  assert.equal(await pending, false);
});

test("TUI：窄屏工具事件清除 Thinking 并与流式正文分行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 20, rows: 8 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const call = { id: "r", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  ui.tui.setThinking(true);
  ui.tui.toolCall(call);
  assert.match(ui.text(), /Thinking\.\.\.\r\x1b\[2K/);
  ui.tui.assistantDelta("I will inspect");
  ui.tui.toolResult(call, "body");
  assert.match(ui.text(), /model: I will inspect\n  ✓ read/);
});

test("TUI：TERM=dumb 使用逐行输出，不发送固定布局光标命令", async (t) => {
  const previous = process.env.TERM;
  process.env.TERM = "dumb";
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  const chunks = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));
  const tui = new Tui({ input, output, model: "mock", workspace: "repo", permission: "read-only",
    controller: new AbortController(), interactive: true, columns: 80, rows: 24 });
  if (previous === undefined) delete process.env.TERM;
  else process.env.TERM = previous;
  t.after(() => { tui.close(); input.end(); });
  tui.start();
  tui.logLine("hello");
  const pending = tui.readLine();
  input.write("/exit\n");
  assert.equal(await pending, "/exit");
  assert.doesNotMatch(chunks.join(""), /\x1b\[\d+;\d+H/);
});

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

test("TUI：模型请求期间显示 thinking，第一段正文前整帧重绘掉", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.setThinking(true);
  await tick();
  assert.match(ui.text(), /Thinking\.\.\./);

  ui.tui.assistantDelta("hello");
  ui.tui.finishAssistant("");
  await tick();
  const text = ui.text();
  // 差分重绘只写变化的行；用最后出现的位置判断 thinking 已被替换。
  assert.ok(text.lastIndexOf("Thinking") < text.lastIndexOf("hello"), "Thinking 必须在正文前消失");
  assert.match(text, /(?:✻|\*) hello/);
});

test("TUI：行式聊天同样在回复前显示 thinking，并在正文前原地清掉", async (t) => {
  const ui = makeTui({ interactive: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.setThinking(true);
  await tick();
  assert.match(ui.text(), /Thinking\.\.\./);

  ui.tui.assistantDelta("hello");
  ui.tui.finishAssistant("");
  await tick();
  const text = ui.text();
  assert.match(text, /\r\x1b\[2K/);
  assert.match(text, /model: hello/);
});

test("TUI：TTY 布局是聊天式头部、固定输入和页脚，不切 alternate screen", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  await tick();
  const started = ui.text();
  assert.match(started, /\x1b\[2J/);
  assert.match(started, /repo/);
  assert.match(started, /mock-model/);
  assert.match(started, /C:\\work\\repo/);
  assert.match(started, /workspace-write/);
  assert.match(started, /0 requests · 0 tokens/);
  assert.match(started, /\x1b\[18;1H/, "输入框上边框固定在底部");
  assert.match(started, /\x1b\[19;1H/, "输入行在框内");
  assert.match(started, /\x1b\[20;1H/, "输入框下边框");
  assert.match(started, /\x1b\[21;1H/, "权限和统计在输入框下方");
  assert.doesNotMatch(started, /\x1b\[3;23r/, "整帧重绘不依赖滚动区域");
  assert.doesNotMatch(started, /\x1b\[\?1049h/, "轻量 TUI 不切 alternate screen");

  ui.tui.close();
  await tick();
  assert.match(ui.text(), /\x1b\[24;1H/, "退出时从最后一行下方交还 shell");
});

test("TUI：短对话从视口顶部开始，不再贴底", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.beginTurn("hello");
  await tick();
  const text = ui.text();
  assert.match(text, /\x1b\[4;1H(?:\x1b\[2K)?[^\x1b]*(?:❯|>) hello/);
  // 对话下面应该是空白和输入框，而不是把 hello 推到底部。
  assert.match(text, /\x1b\[5;1H\x1b\[2K/);
});

test("TUI：固定布局的 shell 审批完整展示命令和 cwd，y 只放行这一次", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
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
  assert.match(text, /Shell permission/);
  assert.match(text, /Workspace: C:\\work\\repo/);
  assert.match(text, /Command:/);
  assert.match(text, /[|│]\s+echo hi/);
  assert.match(text, /[|│]\s+echo bye/);
  assert.match(text, /\[Y\] Allow once/);
  assert.match(text, /\[N\] Deny/);
  assert.match(text, /(?:✓|\+) Allowed once/);
});

test("TUI：固定布局的工具调用从运行中原地变成成功/失败", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  const call = {
    id: "tool-1",
    type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command: "echo hi" }) },
  };

  ui.tui.start();
  ui.tui.toolCall(call);
  await tick();
  assert.match(ui.text(), /(?:●|o) Shell: echo hi/);

  ui.tui.toolResult(call, "ok");
  await tick();
  const text = ui.text();
  const running = Math.max(
    text.lastIndexOf("o Shell: echo hi"),
    text.lastIndexOf("● Shell: echo hi"),
  );
  const done = Math.max(
    text.lastIndexOf("+ Shell: echo hi"),
    text.lastIndexOf("✓ Shell: echo hi"),
  );
  assert.ok(done > running, "结果必须覆盖同一行的运行中状态");
  assert.match(lastRow(text, 4), /(?:✓|\+) Shell: echo hi/);
  assert.match(lastRow(text, 5), /^      [└+] ok/);
});

test("TUI：失败和未执行工具显示不同符号，原因在下一行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  const failed = {
    id: "tool-failed",
    type: "function",
    function: { name: "read", arguments: JSON.stringify({ path: "src/missing.ts" }) },
  };
  const denied = {
    id: "tool-denied",
    type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command: "rm -rf build" }) },
  };
  const notRun = {
    id: "tool-not-run",
    type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command: "npm run check" }) },
  };

  ui.tui.start();
  ui.tui.toolCall(failed);
  ui.tui.toolResult(failed, "ERROR: File not found: src/missing.ts");
  ui.tui.toolCall(denied);
  ui.tui.toolResult(denied, 'ERROR: permission denied: user denied tool "shell"');
  ui.tui.toolCall(notRun);
  ui.tui.toolResult(notRun, "ERROR: not run: task cancelled");
  await tick();

  const text = ui.text();
  assert.match(text, /(?:✗|x) Read src\/missing\.ts/);
  assert.match(text, /File not found: src\/missing\.ts/);
  assert.match(text, /(?:⊘|!) Shell: rm -rf build/);
  assert.match(text, /permission denied: user denied tool "shell"/);
  assert.match(text, /(?:–|-) Shell: npm run check/);
  assert.match(text, /not run: task cancelled/);
});

test("TUI：固定布局的页脚显示权限和完整统计", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.setStats(session);
  await tick();
  const text = ui.text();
  assert.match(text, /workspace-write/);
  assert.match(text, /2 requests · 2 tool calls · 12 tokens/);
});

test("TUI：固定布局转义工具结果里的控制字符", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, color: false });
  t.after(() => ui.cleanup());

  const call = {
    id: "tool-esc",
    type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command: "echo hi" }) },
  };

  ui.tui.start();
  ui.tui.toolResult(call, "\x1b[31mred");
  await tick();
  const text = ui.text();
  assert.match(text, /\\u001b\[31mred/);
  assert.doesNotMatch(text, /\x1b\[31mred/);
});

test("TUI：PageUp/PageDown 滚动历史，并保留输入行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 80, rows: 12 });
  t.after(() => ui.cleanup());

  ui.tui.start();
  for (let index = 0; index < 12; index++) ui.tui.logLine(`line ${index}`, "info");
  ui.input.emit("keypress", "", { name: "pageup" });
  await tick();

  assert.match(ui.text(), /(?:↑|\^) \d+ lines · workspace-write/);
  // 输入行仍在原位置；滚动只改日志视口。
  assert.match(ui.text(), /\x1b\[7;1H/);
});

test("TUI：滚动时新输出不把视口拉回底部", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 80, rows: 12 });
  t.after(() => ui.cleanup());

  ui.tui.start();
  for (let index = 0; index < 5; index++) ui.tui.logLine(`line ${index}`, "info");
  ui.input.emit("keypress", "", { name: "pageup" });
  await tick();
  const matchesBefore = [...ui.text().matchAll(/(?:↑|\^) (\d+) lines/g)];
  const before = matchesBefore.at(-1);
  assert.ok(before, "PageUp 后应显示滚动偏移");

  ui.tui.logLine("new line", "info");
  await tick();
  const matchesAfter = [...ui.text().matchAll(/(?:↑|\^) (\d+) lines/g)];
  const after = matchesAfter.at(-1);
  assert.ok(after, "新输出后仍应保持滚动状态");
  assert.ok(Number(after[1]) > Number(before[1]), "偏移应增加，视口不回到最新");
});

test("TUI：resize 后重新计算输入框和状态行位置", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.output.columns = 60;
  ui.output.rows = 16;
  ui.output.emit("resize");
  await tick();

  const text = ui.text();
  assert.match(text, /\x1b\[10;1H/, "16 行时输入框上边框");
  assert.match(text, /\x1b\[11;1H/, "16 行时输入行");
  assert.match(text, /\x1b\[12;1H/, "16 行时输入框下边框");
  assert.match(text, /\x1b\[13;1H/, "16 行时状态行在输入框下方");
  assert.match(text, /workspace-write/);
});

test("TUI：中文长行按显示宽度换行，不把固定框撑破", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 34, rows: 12 });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.logLine("中".repeat(40), "info");
  await tick();

  const chunks = ui.text().match(/中+/g) ?? [];
  assert.ok(chunks.length > 1, "长中文行必须被拆行");
  assert.ok(Math.max(...chunks.map((chunk) => chunk.length)) <= 15, "每行不超过 30 显示列");
});

test("TUI：颜色开关生效，无颜色终端输出纯文本", async (t) => {
  const colored = makeTui({ interactive: true, tty: true, color: true });
  const plain = makeTui({ interactive: true, tty: true, color: false });
  t.after(() => colored.cleanup());
  t.after(() => plain.cleanup());

  colored.tui.start();
  plain.tui.start();
  await tick();

  assert.match(colored.text(), /\x1b\[(?:38;5;\d+|3[0-9])m/);
  assert.doesNotMatch(plain.text(), /\x1b\[(?:38;5;\d+|3[0-9])m/);
});

test("TUI：Windows Terminal 字形路径使用 Unicode 图标", async (t) => {
  const previous = process.env.WT_SESSION;
  process.env.WT_SESSION = "test-session";
  const ui = makeTui({ interactive: true, tty: true, color: true });
  t.after(() => {
    ui.cleanup();
    if (previous === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previous;
  });

  ui.tui.start();
  ui.tui.beginTurn("hello");
  ui.tui.setThinking(true);
  await tick();

  assert.match(ui.text(), /❯ hello/);
  assert.match(ui.text(), /✻ Thinking/);
});


test("TUI flowInput：空会话和短回复的输入框跟随正文，不沉在屏幕底部", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  await tick();
  assert.match(lastRow(ui.text(), 6), /[┌+]/, "空会话输入框应位于标题下方");
  assert.match(lastRow(ui.text(), 7), /Ask anything/, "空会话输入可直接看到");
  assert.match(lastRow(ui.text(), 9), /workspace-write/);

  ui.tui.beginTurn("hello");
  await tick();
  assert.match(lastRow(ui.text(), 4), /hello/);
  assert.match(lastRow(ui.text(), 9), /Ask anything/, "用户提问后输入框应在对话下方");
  ui.tui.assistantDelta("reply");
  ui.tui.finishAssistant("");
  await tick();
  assert.match(lastRow(ui.text(), 6), /reply/);
  assert.match(lastRow(ui.text(), 11), /Ask anything/, "模型短回复后输入框跟随内容");
  assert.doesNotMatch(lastRow(ui.text(), 30), /Ask anything/, "短会话不能仍钉在最底部");
});

test("TUI flowInput：Shell 审批面板和 y/N 输入就近，决策后恢复聊天", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("Run test");
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  await tick();

  const screen = Array.from({ length: 35 }, (_, row) => lastRow(ui.text(), row + 1));
  const panelBottom = screen.findIndex((row, index) => index >= 4 && /^\s*[└+][─-]+[┘+]$/.test(row));
  const decision = screen.findIndex((row) => row.includes("y/N >"));
  assert.ok(panelBottom >= 0, "审批完整面板应可见");
  assert.ok(decision >= 0, "y/N 决策输入应可见");
  assert.ok(decision - panelBottom <= 2, "审批决定必须紧挨着命令面板");
  assert.ok(decision < 30, "短命令审批不应沉到屏幕最底部");

  ui.input.write("n\r");
  assert.equal(await pending, false);
  await tick();
  const after = Array.from({ length: 35 }, (_, row) => lastRow(ui.text(), row + 1));
  assert.equal(after.some((row) => row.includes("Allow this command?")), false, "决策后收起面板");
  assert.ok(after.findIndex((row) => row.includes("Ask anything")) < 20, "普通输入回到对话附近");
});

test("TUI flowInput：长会话自动停靠底部，仍可翻历史且保留草稿", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  for (let i = 0; i < 40; i++) ui.tui.logLine("LINE_" + i);
  await tick();
  assert.match(lastRow(ui.text(), 30), /Ask anything/, "长会话回到底部固定输入行");

  const pending = ui.tui.readLine();
  ui.input.write("draft");
  await tick();
  assert.match(lastRow(ui.text(), 30), /draft/);
  ui.input.emit("keypress", "", { name: "pageup" });
  await tick();
  assert.match(lastRow(ui.text(), 30), /draft/, "滚动历史不覆盖输入");
  ui.input.write("\r");
  assert.equal(await pending, "draft");
});

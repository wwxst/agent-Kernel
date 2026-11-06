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
function makeTui({ interactive = false, tty = false, columns = 80, rows = 24, color = false } = {}) {
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
  assert.match(text, /\|\s+echo hi/);
  assert.match(text, /\|\s+echo bye/);
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
  assert.match(text, /(?:✓|\+) Shell: echo hi · ok/);
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

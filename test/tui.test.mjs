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
import { Tui, detectUiLanguage, parseTuiColorMode, parseTuiScreenMode, uiLanguageFromLocale } from "../src/tui.ts";
import { selectMood } from "../src/tui-mood.ts";

/** 等一轮微任务/IO：readline 的 line 事件不会在 write() 返回前同步跑完。 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 取最后一次完整写入的行；验收输入框实际内容，不能只检查旧帧里出现过某个词。 */
function lastRow(text, row) {
  return [...text.matchAll(new RegExp(`\\x1b\\[${row};1H\\x1b\\[2K([^\\x1b]*)`, "g"))].at(-1)?.[1] ?? "";
}

/** 把差分刷新过的屏幕行还原为当前画面，避免误断言历史帧。 */
function screenRows(ui, count = 40) {
  return Array.from({ length: count }, (_, index) => lastRow(ui.text(), index + 1));
}

/**
 * 只理解基本 ANSI 光标、整屏清除与行清除；故意忽略同步更新协议 ?2026。
 * 这不是通用终端模拟器，只还原当前 TUI 真实使用的屏幕更新指令。
 */
function screenWithoutSync(output) {
  const rows = new Map();
  let row = 1;
  for (const token of output.match(/\x1b\[[0-9;? ]*[A-Za-z]|[^\x1b]+/g) ?? []) {
    if (token.startsWith("\x1b[")) {
      const cursor = token.match(/^\x1b\[(\d+);(\d+)H$/);
      if (cursor) row = Number(cursor[1]);
      else if (token === "\x1b[H") row = 1;
      else if (token === "\x1b[2J") rows.clear();
      else if (token === "\x1b[2K") rows.set(row, "");
      continue;
    }
    for (const part of token.split(/(\r\n|\n|\r)/)) {
      if (part === "\r\n" || part === "\n") row++;
      else if (part !== "\r") rows.set(row, (rows.get(row) ?? "") + part);
    }
  }
  return rows;
}

/**
 * 一套假终端。interactive=true 只打开审批通道；tty=true 才模拟 stdout 是终端，
 * 从而启用固定布局。两者分开，才能在无 TTY 的测试里单独验证审批逻辑。
 */
function makeTui({ interactive = false, tty = false, columns = 80, rows = 24, color = false, colorMode = "full", flowInput = false, language, screenMode = "never", term = "xterm-256color", autoLayout = false, onPermissionChange, model = "mock-model" } = {}) {
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
  if (interactive) process.env.TERM = term;
  const tui = new Tui({
    input,
    output,
    model,
    workspace: "C:\\work\\repo",
    permission: "workspace-write",
    controller,
    interactive,
    columns,
    rows,
    ...(autoLayout ? {} : { layout: tty }),
    color,
    colorMode,
    flowInput,
    language,
    screenMode,
    onPermissionChange,
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

test("TUI 屏幕模式：环境变量只接受 auto、always 和 never", () => {
  assert.equal(parseTuiScreenMode(undefined), "auto");
  assert.equal(parseTuiScreenMode(""), "auto");
  assert.equal(parseTuiScreenMode("always"), "always");
  assert.equal(parseTuiScreenMode("never"), "never");
  assert.throws(() => parseTuiScreenMode("maybe"), /invalid AGENT_TUI_SCREEN/);
});

test("TUI 配色模式：默认 mono，只保留用户消息任务条的颜色", async (t) => {
  assert.equal(parseTuiColorMode(undefined), "mono");
  assert.equal(parseTuiColorMode(""), "mono");
  assert.equal(parseTuiColorMode("mono"), "mono");
  assert.equal(parseTuiColorMode("full"), "full");
  assert.throws(() => parseTuiColorMode("maybe"), /invalid AGENT_TUI_COLOR/);

  const mono = makeTui({ interactive: true, tty: true, color: true, colorMode: "mono" });
  const full = makeTui({ interactive: true, tty: true, color: true, colorMode: "full" });
  t.after(() => { mono.cleanup(); full.cleanup(); });
  mono.tui.start();
  full.tui.start();
  mono.tui.beginTurn("你好");
  full.tui.beginTurn("你好");
  await tick();

  assert.match(mono.text(), /\x1b\[37;100m\x1b\[38;5;246;48;5;237m(?:❯|>) /, "用户消息任务条颜色保留");
  assert.doesNotMatch(mono.text(), /\x1b\[(?:90|38;5;244)m(?:❯|>) /, "输入行提示符用默认色，不再是灰色");
  assert.match(mono.text(), /\x1b\[(?:90|38;5;244)m Ask anything, or type \/help\.\.\./, "占位提示保留灰色");
  assert.doesNotMatch(mono.text(), /\x1b\[(?:33|38;5;215)m/, "标题与状态不再使用强调色");
  assert.doesNotMatch(mono.text(), /\x1b\[(?:90|38;5;244)m[-─]/, "分隔线不再使用灰色层次色");
  assert.match(full.text(), /\x1b\[(?:90|38;5;244)m(?:❯|>) /, "full 模式提示符仍用灰色强调");
  assert.match(full.text(), /\x1b\[(?:33|38;5;215)m/, "full 模式恢复强调色");
});

test("TUI auto：能力不明时启动只提示一次兼容模式，never 不重复提示", (t) => {
  const fallback = makeTui({ interactive: true, tty: true, screenMode: "auto", autoLayout: true, term: "wyse60" });
  const manual = makeTui({ interactive: true, tty: true, screenMode: "never", autoLayout: true, term: "wyse60" });
  t.after(() => { fallback.cleanup(); manual.cleanup(); });
  fallback.tui.start();
  fallback.tui.logLine("more output");
  assert.equal((fallback.text().match(/Terminal compatibility mode/g) ?? []).length, 1);
  assert.doesNotMatch(fallback.text(), /\x1b\[\?1049h|\x1b\[2J/);
  manual.tui.start();
  assert.doesNotMatch(manual.text(), /Terminal compatibility mode/);
});

test("TUI auto：linux/vt100/ansi/unknown 不误入备用屏幕，always 允许显式覆盖", (t) => {
  for (const term of ["linux", "vt100", "ansi", "unknown", "cons25", "dumb", "wyse60"]) {
    const ui = makeTui({ interactive: true, tty: true, screenMode: "auto", term });
    t.after(() => ui.cleanup());
    ui.tui.start();
    assert.doesNotMatch(ui.text(), /\x1b\[\?1049h/, `TERM=${term} 不能默认进入备用屏幕`);
  }
  const forced = makeTui({ interactive: true, tty: true, screenMode: "always", term: "vt100" });
  t.after(() => forced.cleanup());
  forced.tui.start();
  assert.match(forced.text(), /\x1b\[\?1049h/, "显式 always 可覆盖保守检测");
});

test("TUI auto：继承了现代终端标记但 TERM 未知时仍保守降级", (t) => {
  const previous = process.env.WT_SESSION;
  try {
    process.env.WT_SESSION = "inherited-from-other-terminal";
    const ui = makeTui({ interactive: true, tty: true, screenMode: "auto", term: "wyse60" });
    t.after(() => ui.cleanup());
    ui.tui.start();
    assert.doesNotMatch(ui.text(), /\x1b\[\?1049h/);
  } finally {
    if (previous === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previous;
  }
});

test("TUI auto：受支持终端才启用备用屏幕，never 始终关闭", (t) => {
  const previous = process.env.WT_SESSION;
  try {
    if (process.platform === "win32") process.env.WT_SESSION = "test-windows-terminal";
    const supported = makeTui({ interactive: true, tty: true, screenMode: "auto", term: "xterm-256color" });
    t.after(() => supported.cleanup());
    supported.tui.start();
    assert.match(supported.text(), /\x1b\[\?1049h/);
    const denied = makeTui({ interactive: true, tty: true, screenMode: "never" });
    t.after(() => denied.cleanup());
    denied.tui.start();
    assert.doesNotMatch(denied.text(), /\x1b\[\?1049h/);
  } finally {
    if (previous === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previous;
  }
});

test("TUI：start 前 close 不清屏、不移动光标、不进入备用屏幕，之后也不能启动", (t) => {
  const ui = makeTui({ interactive: true, tty: true, screenMode: "always" });
  t.after(() => ui.cleanup());
  ui.tui.close();
  assert.equal(ui.text(), "", "未启动的界面只能释放资源，不应更改 Shell");
  ui.tui.start();
  assert.equal(ui.text(), "", "已关闭的界面不能再启动");
});

test("TUI 独立屏幕：初次绘制和缩放清屏必须包含在同步帧内", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, screenMode: "always" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.output.columns = 96;
  ui.output.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 130));
  const output = ui.text();
  const frames = output.match(/\x1b\[\?2026h[\s\S]*?\x1b\[\?2026l/g) ?? [];
  assert.equal(frames.length >= 2, true, "启动与缩放均产生同步帧");
  assert.equal(frames.filter((frame) => frame.includes("\x1b[2J\x1b[H")).length, 2,
    "两次清屏各自与完整重绘同帧提交");
  const outside = output.replace(/\x1b\[\?2026h[\s\S]*?\x1b\[\?2026l/g, "");
  assert.doesNotMatch(outside, /\x1b\[2J/, "不能在同步帧外清空可见屏幕");
});

test("TUI 独立屏幕：忽略同步协议的终端在多次缩放后仍显示单份正确画面", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, screenMode: "always" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.logLine("ORIGINAL_VISIBLE");
  for (const columns of [110, 40, 95]) {
    ui.output.columns = columns;
    ui.output.emit("resize");
    ui.tui.logLine(`NEW_AT_${columns}`);
    await new Promise((resolve) => setTimeout(resolve, 95));
  }
  const lines = [...screenWithoutSync(ui.text()).values()];
  const screen = lines.join("\n");
  assert.match(lines[0], /agent-Kernel/);
  assert.match(lines[1], /C:\\work\\repo/);
  assert.match(lines[2], /^(?:─|-){94}$/, "分隔线长度对应最后一次 95 列窗口");
  for (const text of ["ORIGINAL_VISIBLE", "NEW_AT_110", "NEW_AT_40", "NEW_AT_95"]) {
    assert.equal((screen.match(new RegExp(text, "g")) ?? []).length, 1, `${text} 只在最终画面出现一次`);
  }
});

test("TUI 独立屏幕：窄窗口提示清屏也不能漏出同步帧", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, screenMode: "always" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("请检查窗口");
  ui.output.columns = 20;
  ui.output.rows = 8;
  ui.output.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 130));
  const output = ui.text();
  const outside = output.replace(/\x1b\[\?2026h[\s\S]*?\x1b\[\?2026l/g, "");
  assert.doesNotMatch(outside, /\x1b\[2J/);
  assert.match(output, /窗口太小/);
});

test("TUI 独立屏幕：滚动到历史中段后，缩放期间流式增长不能移动历史锚点", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 80, rows: 35, screenMode: "always" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  for (let i = 0; i < 85; i++) ui.tui.logLine(`ANCHOR_${String(i).padStart(3, "0")} ${"内容 ".repeat(17)}`);
  ui.input.emit("keypress", "", { name: "pageup" });
  await tick();
  const before = lastRow(ui.text(), 4).match(/ANCHOR_\d{3}/)?.[0];
  assert.ok(before, "应能滚动到历史中段的稳定日志行");

  ui.output.columns = 45;
  ui.output.emit("resize");
  ui.tui.assistantDelta("新增流式回答\n".repeat(70));
  ui.tui.confirmAssistant("新增流式回答\n".repeat(70));
  await new Promise((resolve) => setTimeout(resolve, 130));
  const after = lastRow(ui.text(), 4);
  assert.match(after, new RegExp(before), "视口仍从相同逻辑行开始，而非跳到新的流式输出");
});

test("TUI 稳定日志 ID：展开较早的工具详情不会把历史中段跳到最新", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, screenMode: "always" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("Inspect a file");
  const call = { id: "history-group", type: "function", function: { name: "read", arguments: '{"path":"history.txt"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "content\n".repeat(25));
  for (let i = 0; i < 95; i++) ui.tui.logLine(`STABLE_${String(i).padStart(3, "0")} ${"内容 ".repeat(7)}`);
  ui.input.emit("keypress", "", { name: "pageup" });
  const before = lastRow(ui.text(), 4).match(/STABLE_\d{3}/)?.[0];
  assert.ok(before, "向上翻页后必须有可见历史锚点");
  ui.input.write("\x0f");
  await tick();
  assert.match(lastRow(ui.text(), 4), new RegExp(before), "收起较早活动后仍看同一段历史");
  ui.input.write("\x0f");
  await tick();
  assert.match(lastRow(ui.text(), 4), new RegExp(before), "重新展开更多详情行时不能二次累加滚动偏移");
  ui.output.columns = 50;
  ui.output.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.match(lastRow(ui.text(), 4), new RegExp(before), "窗口重新换行也应保持同一条日志");
});

test("TUI 稳定日志 ID：缩放期间历史被裁剪时显示告知并定位到剩余记录", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, screenMode: "always" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查历史");
  for (let i = 0; i < 90; i++) ui.tui.logLine(`ORIGINAL_${String(i).padStart(3, "0")}`);
  ui.input.emit("keypress", "", { name: "pageup" });
  assert.match(lastRow(ui.text(), 4), /ORIGINAL_\d{3}/);

  ui.output.columns = 65;
  ui.output.emit("resize");
  for (let i = 0; i < 2_120; i++) ui.tui.logLine(`LATER_${i}`);
  await new Promise((resolve) => setTimeout(resolve, 130));
  const current = screenRows(ui, 35).join("\n");
  assert.match(current, /LATER_\d+/);
  assert.match(current, /历史已截断/, "找不到锚点时不可无声跳转");
  ui.input.emit("keypress", "", { name: "pagedown" });
  assert.doesNotMatch(lastRow(ui.text(), 32), /历史已截断/, "用户继续滚动后提示消失");
});

test("TUI 独立屏幕：进入和退出成对恢复 Shell 画面，保留原有聊天和统计", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, screenMode: "always", flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  assert.match(ui.text(), /\x1b\[\?1049h/);
  ui.tui.beginTurn("请检查项目");
  ui.tui.finishAssistant("检查完成");
  ui.tui.setStats(session);
  const screen = screenRows(ui, 35).join("\n");
  assert.match(screen, /检查完成/);
  assert.match(screen, /2 次请求/);
  ui.tui.close();
  assert.match(ui.text(), /\x1b\[\?1049l/);
  assert.equal((ui.text().match(/\x1b\[\?1049h/g) ?? []).length, 1);
  assert.equal((ui.text().match(/\x1b\[\?1049l/g) ?? []).length, 1);
});

test("TUI 独立屏幕：连续缩放只在最后尺寸重排一次，流式回复不重复写入历史", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, screenMode: "always", flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查窗口缩放");
  ui.tui.assistantDelta("一段输出，");
  for (const columns of [85, 96, 107, 121]) {
    ui.output.columns = columns;
    ui.output.emit("resize");
  }
  ui.tui.assistantDelta("继续输出");
  ui.tui.confirmAssistant("一段输出，继续输出");
  assert.equal((ui.text().match(/\x1b\[2J/g) ?? []).length, 1, "缩放期间不应反复清屏");
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal((ui.text().match(/\x1b\[2J/g) ?? []).length, 2, "稳定后只能清屏重建一次");
  const screen = screenRows(ui, 35).join("\n");
  assert.equal((screen.match(/一段输出，继续输出/g) ?? []).length, 1, "历史中只有一份确认回复");
  assert.match(lastRow(ui.text(), 3), /^(?:─|-){120}$/, "分隔线使用最终宽度而非中间宽度");
});

test("TUI 独立屏幕：缩到不足最小尺寸不退回逐行输出，放大后恢复原有对话", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, screenMode: "always" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("请处理窗口变化");
  ui.output.columns = 20;
  ui.output.rows = 8;
  ui.output.emit("resize");
  ui.tui.finishAssistant("最终回答");
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.match(ui.text(), /窗口太小，放大后/, "窄屏提示会按可用列宽截断");
  ui.output.columns = 80;
  ui.output.rows = 35;
  ui.output.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.match(screenRows(ui, 35).join("\n"), /最终回答/);
  assert.doesNotMatch(screenRows(ui, 35).join("\n"), /窗口太小/);
});

test("TUI：已确认模型正文覆盖不一致的流式草稿，不向历史提交错误文本", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("ask");
  ui.tui.assistantDelta("DRAFT_MISMATCH");
  ui.tui.confirmAssistant("CONFIRMED_BODY");

  const screen = screenRows(ui, 35).join("\n");
  assert.match(screen, /CONFIRMED_BODY/);
  assert.doesNotMatch(screen, /DRAFT_MISMATCH/);
});

test("TUI：行式模式不能收回流式字节，必须追加更正声明和权威消息", (t) => {
  const ui = makeTui({ interactive: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.assistantDelta("DRAFT_MISMATCH");
  ui.tui.confirmAssistant("CONFIRMED_BODY");

  assert.match(ui.text(), /model: DRAFT_MISMATCH/);
  assert.match(ui.text(), /stream corrected: confirmed message follows/);
  assert.match(ui.text(), /model \(confirmed\): CONFIRMED_BODY/);
});

test("TUI：模型确认无正文时不得把旧流式草稿当作工具前置说明", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("ask");
  ui.tui.assistantDelta("UNCONFIRMED");
  ui.tui.confirmAssistant(null);

  assert.doesNotMatch(screenRows(ui, 35).join("\n"), /UNCONFIRMED/);
});

test("TUI：输入区仅用两条横线，提示与正文共用左边界，中文光标保持正确", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("中文A");
  await tick();
  assert.match(lastRow(ui.text(), 18), /^(?:-{79}|─{79})$/);
  assert.match(lastRow(ui.text(), 19), /^(?:>|❯) 中文A/);
  assert.equal(lastRow(ui.text(), 20), lastRow(ui.text(), 18));
  assert.match(ui.text(), /\x1b\[19;8H/);
  ui.input.write("\r");
  assert.equal(await pending, "中文A");
});

test("TUI：已有对话后空输入仅显示提示符和光标，不重复欢迎占位文字", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("hello");
  const pending = ui.tui.readLine();
  await tick();
  assert.match(lastRow(ui.text(), 19).trimEnd(), /^(?:>|❯)$/);
  ui.input.write("\r");
  assert.equal(await pending, "");
});

test("TUI flowInput：过程小字后留一行空白再接输入横线", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.logLine("Worked for 3s");
  assert.equal(lastRow(ui.text(), 4), "Worked for 3s");
  assert.equal(lastRow(ui.text(), 5).trim(), "");
  assert.match(lastRow(ui.text(), 6), /^(?:-{79}|─{79})$/);
});

test("TUI：等待状态分层并动态换符号，首段正文到达后停止更新", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.setThinking(true);
  const first = lastRow(ui.text(), 8);
  assert.match(first, /Thinking\.\.\. \(0s\)/);
  assert.match(lastRow(ui.text(), 9), /^  [└+] Ctrl-C to cancel$/);
  t.mock.timers.tick(200);
  assert.notEqual(lastRow(ui.text(), 8), first);
  ui.tui.assistantDelta("hello");
  t.mock.timers.tick(1000);
  assert.match(lastRow(ui.text(), 8), /hello/);
  assert.doesNotMatch(lastRow(ui.text(), 9), /Ctrl-C/);
});

test("TUI：Thinking 三个点保持静止，前置符号变化且耗时信息不左右跳动", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.setThinking(true);
  const detailColumn = lastRow(ui.text(), 8).indexOf("(");
  let previousSymbol = "";
  for (let frame = 0; frame < 5; frame++) {
    const line = lastRow(ui.text(), 8);
    assert.match(line, /Thinking\.\.\. \(0s\)(?: │ .+)?$/);
    assert.equal(line.indexOf("("), detailColumn);
    const symbol = line.split(" ")[0];
    assert.notEqual(symbol, previousSymbol);
    previousSymbol = symbol;
    t.mock.timers.tick(200);
  }
});

test("TUI：现代终端等待动画所有帧使用文本符号，不触发彩色 emoji", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const previous = process.env.WT_SESSION;
  process.env.WT_SESSION = "spinner-glyph-regression";
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => {
    ui.cleanup();
    if (previous === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previous;
  });
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.setThinking(true);
  for (let frame = 0; frame < 4; frame++) {
    const symbol = lastRow(ui.text(), 8).split(" ")[0];
    assert.equal([...symbol].length, 1);
    assert.doesNotMatch(symbol, /\p{Emoji}/u, "等待符号不能被终端回退成彩色 emoji");
    t.mock.timers.tick(200);
  }
});

test("TUI：工具执行中有次要状态，结果到达后替换且不残留 Running", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const call = { id: "running", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  ui.tui.toolCall(call);
  assert.match(lastRow(ui.text(), 5), /^    [└+] Running\.\.\.$/);
  ui.tui.toolResult(call, "hello");
  await tick();
  assert.match(lastRow(ui.text(), 5), /Received 1 line/);
  assert.doesNotMatch(lastRow(ui.text(), 5), /Running/);
});

test("TUI：后续等待展示实际收到的工具结果数，不把它冒充流式 token", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  const call = { id: "progress", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "hello");
  ui.tui.setThinking(true);
  assert.match(ui.text(), /Thinking\.\.\. \(0s · 1 tool result\)/);
});

test("TUI：结束后展示本次 Run 的实际耗时和工具数，新 Run 重新计时", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  const run = { requests: 2, toolCalls: 2, usage, tokenBudget: { exceeded: false } };
  ui.tui.start();
  ui.tui.beginTurn("first");
  t.mock.timers.tick(3200);
  ui.tui.finishAssistant("done");
  ui.tui.finishTurn(run, session, { failed: false });
  assert.match(lastRow(ui.text(), 6), /Completed · in 3s/);
  ui.tui.beginTurn("second");
  t.mock.timers.tick(1000);
  ui.tui.finishTurn({ ...run, toolCalls: 0 }, session, { failed: true });
  assert.match(lastRow(ui.text(), 12), /Failed · after 1s/);
  assert.doesNotMatch(lastRow(ui.text(), 12), /after 4s/);
});

test("TUI：下一轮用户消息与上轮耗时之间留一行空白，首条消息仍贴顶", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true, flowInput: true, rows: 35 });
  t.after(() => ui.cleanup());
  const run = { requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } };
  ui.tui.start();
  ui.tui.beginTurn("first");
  assert.match(lastRow(ui.text(), 4), /^(?:❯|>) first/);
  ui.tui.finishAssistant("done");
  t.mock.timers.tick(2000);
  ui.tui.finishTurn(run, session, { failed: false });
  ui.tui.beginTurn("second");
  assert.match(lastRow(ui.text(), 6), /Completed · in 2s/);
  assert.equal(lastRow(ui.text(), 9), "");
  assert.match(lastRow(ui.text(), 10), /^(?:❯|>) second/);
});

test("TUI：标题标明程序和项目，用户正文与输入边界使用中性层次", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, color: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("READ_ME");
  await tick();
  assert.match(ui.text(), /agent-Kernel · repo/);
  assert.match(ui.text(), /\x1b\[37;100m\x1b\[38;5;246;48;5;237m(?:❯|>) \x1b\[1;97;100m\x1b\[38;5;255;48;5;237mREAD_ME/, "用户消息使用 Claude Code 任务条：灰色前缀 + 深灰底色 + 白色粗体正文");
  const inputTop = ui.text().slice(ui.text().lastIndexOf("\x1b[18;1H\x1b[2K"));
  assert.match(inputTop, /\x1b\[(?:90|38;5;244)m[-─]/);
});

test("TUI 用户消息样式：Claude Code 任务条，多行任务整行铺底色", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, color: true, columns: 60, rows: 30 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("第一行\n第二行");
  await tick();
  const text = ui.text();
  assert.match(text, /\x1b\[37;100m\x1b\[38;5;246;48;5;237m(?:❯|>) \x1b\[1;97;100m\x1b\[38;5;255;48;5;237m第一行 {2,}\x1b\[0m/, "首行：灰色前缀 + 深灰底色 + 白色粗体正文");
  assert.match(text, /\x1b\[1;97;100m\x1b\[38;5;255;48;5;237m  第二行 {2,}\x1b\[0m/, "续行同样整行铺底色");
});

test("TUI：回答审批后收起已结束的面板，保留决定与工具结果", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const call = { id: "approval", type: "function", function: { name: "shell", arguments: '{"command":"echo safe"}' } };
  ui.tui.toolCall(call);
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  assert.match(ui.text(), /Do you want to proceed\?/);
  ui.input.write("n\r");
  assert.equal(await pending, false);
  ui.tui.toolResult(call, 'ERROR: permission denied: user denied tool "shell"');
  await tick();
  const screen = Array.from({ length: 14 }, (_, index) => lastRow(ui.text(), index + 4)).join("\n");
  assert.doesNotMatch(screen, /Do you want to proceed\?|Shell permission|1\. Yes, allow once/);
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
  assert.match(ui.text(), /Thinking\.\.\. \(0s\)/);
  assert.match(lastRow(ui.text(), 9), /Ctrl-C to cancel/);
  t.mock.timers.tick(2000);
  assert.match(ui.text(), /Thinking\.\.\. \(2s\)/);
  ui.tui.assistantDelta("hello");
  t.mock.timers.tick(3000);
  assert.match(lastRow(ui.text(), 8), /hello/);
  assert.doesNotMatch(lastRow(ui.text(), 8), /Thinking/, "正文后不再残留等待态");
});

test("TUI：Shell 审批使用两项菜单，空回车默认拒绝", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, color: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  pending.catch(() => {});
  await tick();
  assert.match(ui.text(), /Do you want to proceed\?/);
  assert.match(ui.text(), /1\. Yes, allow once/);
  assert.match(ui.text(), /2\. No \(default\)/);
  assert.match(ui.text(), /Esc to cancel/);
  assert.doesNotMatch(ui.text(), /↑↓ select · Enter · Esc >/, "审批期间没有额外文字输入行");
  assert.match(ui.text(), /\x1b\[\?25l/, "审批期间隐藏终端光标");
  assert.match(ui.text(), /\x1b\[39m[^\x1b]*echo safe/);
  ui.input.write("\r");
  assert.equal(await pending, false);
  const finalInput = ui.text().slice(ui.text().lastIndexOf("\x1b[19;1H\x1b[2K"));
  assert.match(ui.text(), /\x1b\[\?25h/, "审批结束必须恢复终端光标");
  assert.doesNotMatch(finalInput, /Esc to cancel/, "审批结束后恢复普通聊天输入提示");
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
  assert.match(lastRow(ui.text(), 19), /6789\s*$/);
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
  assert.equal(lastRow(ui.text(), 8), "  56789");
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
  assert.match(lastRow(ui.text(), 5), /^Shell permission$/);
  assert.match(lastRow(ui.text(), 6), /^Workspace: C:\\work\\repo$/);
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
  assert.match(lastRow(ui.text(), 8), /已读取文件|Read files/);
  assert.match(lastRow(ui.text(), 9), /(?:✓|\+) Read a.txt/);
  assert.match(lastRow(ui.text(), 10), /Received 1 line/);
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

test("TUI 固定布局：流式响应失败时撤销未确认正文，但保留失败状态", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.assistantDelta("UNCONFIRMED_RESPONSE_42");

  assert.match(screenRows(ui).join("\n"), /UNCONFIRMED_RESPONSE_42/);
  ui.tui.discardAssistantDraft();
  ui.tui.finishTurn({ requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } },
    session, { failed: true });

  const current = screenRows(ui).join("\n");
  assert.doesNotMatch(current, /UNCONFIRMED_RESPONSE_42/);
  assert.match(current, /unconfirmed text discarded/);
  assert.match(current, /Failed/);
});

test("TUI 行式输出：已写出的流式片段不能撤回，但明确标记其未确认", async (t) => {
  const ui = makeTui();
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.assistantDelta("UNCONFIRMED_LINE");
  ui.tui.discardAssistantDraft();

  assert.match(ui.text(), /UNCONFIRMED_LINE/);
  assert.match(ui.text(), /\[stream interrupted: unconfirmed text discarded\]/);
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
  assert.match(ui.text(), /Thinking\.\.\. \(0s\)/);

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
  ui.tui.toolCall({ id: "allowed-running", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "echo hi\necho bye" }) } });
  const pending = ui.tui.approve({
    tool: "shell",
    args: { command: "echo hi\necho bye" },
  });
  const beforeDecision = ui.text().length;
  ui.input.write("\x1b[A\r");

  assert.equal(await pending, true);
  assert.match(ui.text().slice(beforeDecision), /Running\.\.\./, "允许后恢复执行中子行");
  await tick();
  const text = ui.text();
  assert.match(text, /Shell permission/);
  assert.match(text, /Workspace: C:\\work\\repo/);
  assert.match(text, /Command:/);
  assert.match(text, /[|│]\s+echo hi/);
  assert.match(text, /[|│]\s+echo bye/);
  assert.match(text, /1\. Yes, allow once/);
  assert.match(text, /2\. No \(default\)/);
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
  assert.match(lastRow(text, 5), /^    [└+] ok/);
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
  assert.ok(Math.max(...chunks.map((chunk) => chunk.length)) <= 16, "每行不超过 33 显示列");
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

  assert.match(ui.text(), /❯ \x1b\[1;97;100m\x1b\[38;5;255;48;5;237mhello/, "Unicode 前缀 + 任务条正文");
  assert.match(ui.text(), /✻ Thinking/);
  assert.match(ui.text(), /\x1b\[2 q/, "现代终端输入使用块状光标");
  ui.tui.close();
  assert.match(ui.text(), /\x1b\[0 q/, "退出恢复终端默认光标");
});


test("TUI：现代终端窄窗口启动后放大也设置块状光标，退出恢复默认", async (t) => {
  const previous = process.env.WT_SESSION;
  process.env.WT_SESSION = "test-resize-session";
  const ui = makeTui({ interactive: true, tty: true, columns: 20 });
  t.after(() => {
    ui.cleanup();
    if (previous === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previous;
  });
  ui.tui.start();
  assert.doesNotMatch(ui.text(), /\x1b\[2 q/);
  ui.output.columns = 80;
  ui.output.emit("resize");
  await tick();
  assert.match(ui.text(), /\x1b\[2 q/);
  ui.tui.close();
  assert.match(ui.text(), /\x1b\[0 q/);
});

test("TUI flowInput：空会话和短回复的输入框跟随正文，不沉在屏幕底部", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  await tick();
  assert.match(lastRow(ui.text(), 6), /^[-─]+$/, "空会话输入横线应位于标题下方");
  assert.match(lastRow(ui.text(), 7), /Ask anything/, "空会话输入可直接看到");
  assert.match(lastRow(ui.text(), 9), /workspace-write/);

  ui.tui.beginTurn("hello");
  await tick();
  assert.match(lastRow(ui.text(), 4), /hello/);
  assert.match(lastRow(ui.text(), 10), /^(?:❯|>)\s*$/, "用户提问后输入框应在对话下方");
  ui.tui.assistantDelta("reply");
  ui.tui.finishAssistant("");
  await tick();
  assert.match(lastRow(ui.text(), 8), /reply/);
  assert.match(lastRow(ui.text(), 12), /^(?:❯|>)\s*$/, "模型短回复后输入框跟随内容");
  assert.doesNotMatch(lastRow(ui.text(), 30), /(?:❯|>)/, "短会话不能仍钉在最底部");
});

test("TUI flowInput：Shell 审批菜单与确认输入就近，决策后恢复聊天", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("Run test");
  ui.tui.toolCall({ id: "approval-flow", type: "function", function: { name: "shell", arguments: '{"command":"echo safe"}' } });
  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  await tick();

  const screen = Array.from({ length: 35 }, (_, row) => lastRow(ui.text(), row + 1));
  assert.ok(screen.some((row) => row.includes("Shell: echo safe")), "审批上方仍应看到工具标题");
  assert.equal(screen.some((row) => row.includes("Running...")), false, "待审批不能称作已经执行");
  const hint = screen.findIndex((row) => row.includes("Esc to cancel"));
  assert.ok(hint >= 0, "审批菜单内应显示 Esc 取消提示");
  assert.equal(screen[hint + 1]?.trim(), "", "Esc 下方不能再出现横线");
  assert.equal(screen.some((row) => row.includes("↑↓ select · Enter · Esc >")), false,
    "审批期间不显示额外输入提示");
  assert.equal(screen.some((row) => row.includes("workspace-write")), false,
    "审批期间隐藏普通聊天状态栏");
  assert.ok(hint < 30, "短命令审批不应沉到屏幕最底部");

  const beforeDecision = ui.text().length;
  ui.input.write("n\r");
  assert.equal(await pending, false);
  assert.doesNotMatch(ui.text().slice(beforeDecision), /Running\.\.\./, "拒绝到结果回传之间也不能闪现执行中");
  await tick();
  const after = Array.from({ length: 35 }, (_, row) => lastRow(ui.text(), row + 1));
  assert.equal(after.some((row) => row.includes("Do you want to proceed?")), false, "决策后收起菜单");
  const inputIndex = after.findIndex((row) => /^(?:❯|>)\s*$/.test(row));
  assert.ok(inputIndex >= 0 && inputIndex < 20, "普通输入回到对话附近");
});

test("TUI flowInput：长会话自动停靠底部，仍可翻历史且保留草稿", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  for (let i = 0; i < 40; i++) ui.tui.logLine("LINE_" + i);
  await tick();
  assert.match(lastRow(ui.text(), 30), /^(?:❯|>)\s*$/, "长会话回到底部固定输入行");

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


test("TUI 审批菜单：上键选允许、下键选拒绝，Enter 只确认当前选择", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const allow = ui.tui.approve({ tool: "shell", args: { command: "echo once" } });
  allow.catch(() => {});
  assert.match(ui.text(), /(?:❯|>) 2\. No \(default\)/);
  ui.input.write("\x1b[A");
  await tick();
  assert.match(ui.text(), /(?:❯|>) 1\. Yes, allow once/);
  ui.input.write("\r");
  assert.equal(await allow, true, "明确上移并按 Enter 才允许一次");

  const deny = ui.tui.approve({ tool: "shell", args: { command: "echo second" } });
  deny.catch(() => {});
  assert.match(ui.text(), /(?:❯|>) 2\. No \(default\)/, "下次审批不得继承上次允许");
  ui.input.write("\x1b[A\x1b[B\r");
  assert.equal(await deny, false, "下移到 No 后按 Enter 拒绝");
});

test("TUI 审批菜单：Esc 和空回车拒绝，粘贴 y/1 不能变成隐形授权", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const escaped = ui.tui.approve({ tool: "shell", args: { command: "echo esc" } });
  escaped.catch(() => {});
  ui.input.write("\x1b");
  assert.equal(await escaped, false, "Esc 直接拒绝");

  const empty = ui.tui.approve({ tool: "shell", args: { command: "echo empty" } });
  empty.catch(() => {});
  ui.input.write("\r");
  assert.equal(await empty, false, "空回车默认拒绝");

  for (const pasted of ["1", "y", "yes", "unknown"]) {
    const pending = ui.tui.approve({ tool: "shell", args: { command: "echo " + pasted } });
    pending.catch(() => {});
    ui.input.write(pasted + "\r");
    assert.equal(await pending, false, "隐藏的文字输入不能放行命令: " + pasted);
  }
  const nextTask = ui.tui.readLine();
  ui.input.write("next task\r");
  assert.equal(await nextTask, "next task", "审批期间的文字没有进入下一轮任务");
});

test("TUI 审批菜单：固定布局直接键盘操作，不创建输入提示与聊天状态栏", async (t) => {
  for (const flowInput of [false, true]) {
    const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput });
    t.after(() => ui.cleanup());
    ui.tui.start();
    const pending = ui.tui.approve({ tool: "shell", args: { command: "echo visual" } });
    pending.catch(() => {});
    await tick();

    const rows = Array.from({ length: 35 }, (_, row) => lastRow(ui.text(), row + 1));
    assert.ok(rows.some((row) => row.includes("Esc to cancel")));
    assert.equal(rows.some((row) => row.includes("Ask anything")), false, "审批期间不应看到普通输入区");
    assert.equal(rows.some((row) => row.includes("workspace-write")), false, "审批期间不显示聊天状态栏");
    assert.equal(rows.some((row) => row.includes("↑↓ select · Enter · Esc >")), false);
    assert.match(ui.text(), /\x1b\[\?25l/);

    ui.input.write("\r");
    assert.equal(await pending, false);
    await tick();
    assert.match(ui.text(), /\x1b\[\?25h/, "完成后恢复光标");
  }
});

test("TUI 审批菜单：中文、长命令和控制字符展示保持安全，EOF 不授权", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.approve({
    tool: "shell",
    args: { command: "echo 第一行\necho 第二行\x1b[31m\n" + "x".repeat(220) + "\necho TAIL" },
  });
  pending.catch(() => {});
  const text = ui.text();
  assert.match(text, /Workspace: C:\\work\\repo/);
  assert.match(text, /echo 第一行/);
  assert.match(text, /echo TAIL/);
  assert.match(text, /\\u001b\[31m/);
  assert.doesNotMatch(text, /\x1b\[31m/);
  ui.input.end();
  await assert.rejects(pending, /approval prompt closed/);
});


test("TUI 审批菜单：无论底部固定或短会话跟随，Esc 下方都不画分隔线", async (t) => {
  for (const flowInput of [false, true]) {
    const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput });
    t.after(() => ui.cleanup());
    ui.tui.start();
    const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
    pending.catch(() => {});
    await tick();

    const rows = Array.from({ length: 35 }, (_, row) => lastRow(ui.text(), row + 1));
    const hint = rows.findIndex((row) => row.includes("Esc to cancel"));
    assert.ok(hint >= 0, "必须显示 Esc to cancel");
    assert.equal(rows[hint + 1]?.trim(), "", "Esc 下方无横线或输入框顶边");
    assert.equal(rows.some((row) => row.includes("Enter · Esc >")), false, "菜单不显示输入框");
    assert.match(rows[hint - 1], /No \(default\)|^\s*$/, "取消说明紧接菜单后");

    ui.input.write("n\r");
    assert.equal(await pending, false);
  }
});


test("TUI Shift+Tab：只在等待任务时切换模式，状态行展示快捷键，保留输入草稿", async (t) => {
  const modes = [];
  let ui;
  ui = makeTui({
    interactive: true, tty: true, rows: 35, flowInput: true,
    onPermissionChange: (mode) => {
      modes.push(mode);
      ui.tui.setPermission(mode);
    },
  });
  t.after(() => ui.cleanup());

  ui.tui.start();
  const task = ui.tui.readLine();
  assert.match(ui.text(), /workspace-write \(shift-tab to cycle\)/);
  ui.input.write("draft");
  ui.input.write("\x1b[Z");
  await tick();
  assert.equal(modes.length, 0, "从 workspace-write 进入 full-access 必须要求确认");
  assert.match(ui.text(), /Confirm full-access: Shift\+Tab again/);

  // 显式触发 Esc 按键事件，避免把流式 ESC 前缀与紧随的空格合并成 Meta+Space。
  // 这里测试的是按键处理器是否保留 readline 草稿，而不是解析器的序列超时。
  ui.input.emit("keypress", "", { name: "escape", sequence: "\x1b" });
  await tick();
  assert.equal(modes.length, 0);
  assert.match(ui.text(), /workspace-write \(shift-tab to cycle\)/);

  ui.input.write(" task\r");
  assert.equal(await task, "draft task", "Shift+Tab 不能修改已输入的任务正文");
});

test("TUI Shift+Tab：full-access 二次确认；切换后下一次 /permission 切换可同步状态", async (t) => {
  const modes = [];
  let ui;
  ui = makeTui({
    interactive: true, tty: true, rows: 35,
    onPermissionChange: (mode) => {
      modes.push(mode);
      ui.tui.setPermission(mode);
    },
  });
  t.after(() => ui.cleanup());

  ui.tui.start();
  const task = ui.tui.readLine();

  // 当前默认 workspace-write：第一次进入提权待确认，第二次才生效。
  ui.input.write("\x1b[Z");
  await tick();
  assert.equal(modes.length, 0);
  ui.input.write("\x1b[Z");
  await tick();
  assert.deepEqual(modes, ["full-access"]);
  assert.match(ui.text(), /full-access \(shift-tab to cycle\)/);

  // full-access -> read-only -> workspace-write ->（等待提升），每次都保留三档真实状态。
  ui.input.write("\x1b[Z");
  await tick();
  ui.input.write("\x1b[Z");
  await tick();
  assert.deepEqual(modes, ["full-access", "read-only", "workspace-write"]);
  ui.input.write("\x1b[Z");
  await tick();
  assert.match(ui.text(), /Confirm full-access/);
  // /permission 命令路径用 setPermission 同步，必须清理未确认的提升。
  ui.tui.setPermission("read-only");
  assert.doesNotMatch(lastRow(ui.text(), 32), /Confirm full-access/);
  ui.input.write("\x1b[Z");
  await tick();
  assert.equal(modes.at(-1), "workspace-write", "手动设置后下一轮快捷键必须从新的模式开始");

  ui.input.write("\r");
  assert.equal(await task, "");
});

test("TUI Shift+Tab：审批中、模型运行中和普通 Tab 都不能改变权限", async (t) => {
  const modes = [];
  let ui;
  ui = makeTui({
    interactive: true, tty: true, rows: 35,
    onPermissionChange: (mode) => {
      modes.push(mode);
      ui.tui.setPermission(mode);
    },
  });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.input.write("\x1b[Z");
  assert.deepEqual(modes, [], "没有等待任务输入时不能切换模式");

  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  pending.catch(() => {});
  ui.input.write("\x1b[Z");
  await tick();
  assert.deepEqual(modes, [], "Shell 审批期间绝不能用 Shift+Tab 改权限");
  assert.match(ui.text(), /2\. No \(default\)/);
  ui.input.write("\x1b");
  assert.equal(await pending, false);

  const task = ui.tui.readLine();
  ui.input.write("\t");
  await tick();
  assert.deepEqual(modes, [], "普通 Tab 不是 Shift+Tab");
  ui.input.write("\r");
  await task;
});


test("TUI 语言识别：忽略路径、文件名和代码，按最近一次用户任务自动判断", () => {
  assert.equal(detectUiLanguage("请读取 README.md 并总结这个仓库"), "zh");
  assert.equal(detectUiLanguage("请检查 src/agent.ts 并修复问题"), "zh");
  assert.equal(detectUiLanguage("Summarize the README.md in English, please"), "en");
  assert.equal(detectUiLanguage("Explain the Chinese 中文 words quickly"), "en");
  assert.equal(detectUiLanguage("请使用 TypeScript 进行修改"), "zh");
  assert.equal(detectUiLanguage("123?!", "zh"), "zh", "无可判断语言时保持上一次用户语言");
});

test("TUI 启动语言：按系统 locale 初始化，中文系统启动即显示中文权限标签", (t) => {
  assert.equal(uiLanguageFromLocale("zh-CN"), "zh");
  assert.equal(uiLanguageFromLocale("zh-Hans-CN"), "zh");
  assert.equal(uiLanguageFromLocale("en-US"), "en");
  assert.equal(uiLanguageFromLocale("ja-JP"), "en");
  assert.equal(uiLanguageFromLocale(""), "en");

  const zh = makeTui({ interactive: true, tty: true, rows: 35, language: "zh", onPermissionChange: () => {} });
  const en = makeTui({ interactive: true, tty: true, rows: 35, language: "en", onPermissionChange: () => {} });
  t.after(() => { zh.cleanup(); en.cleanup(); });
  zh.tui.start();
  en.tui.start();

  assert.match(lastRow(zh.text(), 32), /工作区读写（Shift\+Tab 切换）/);
  assert.match(lastRow(en.text(), 32), /workspace-write \(shift-tab to cycle\)/);
});

test("TUI 展示：固定布局隐藏 Markdown 代码块围栏，块内正文用竖线缩进显示", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("创建 hello 文件");

  const reply = "已在当前目录创建 `hello_world.txt`，内容为：\n```\nhello world\n```\n完成。";
  ui.tui.assistantDelta(reply);
  const draft = screenRows(ui, 40).join("\n");
  assert.doesNotMatch(draft, /```/, "流式草稿也不能闪出围栏行");
  assert.match(draft, /(?:│|\|) hello world/, "块内正文用竖线标出");
  assert.match(draft, /创建 `hello_world\.txt`/, "行内反引号保持原文");

  ui.tui.finishAssistant(reply);
  const screen = screenRows(ui, 40).join("\n");
  assert.doesNotMatch(screen, /```/);
  assert.match(screen, /(?:│|\|) hello world/);
  assert.match(screen, /完成。/);
});

test("TUI 展示：只有围栏的回复退回原文，不能显示成空消息", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("空回复");
  ui.tui.finishAssistant("```\n```");
  const screen = screenRows(ui, 40).join("\n");
  assert.match(screen, /```/, "纯围栏回复退回原文，至少让人看见收到了什么");
});

test("TUI 布局：顶部模型名和底部统计与窗口右边缘留 2 列余量", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, columns: 80 });
  t.after(() => ui.cleanup());
  ui.tui.setStats(session);
  ui.tui.start();
  // 可用内容宽 = columns - 1（末列留空防折行），再让出 2 列右边距。
  assert.equal(lastRow(ui.text(), 1).length, 77, "顶部模型名不能贴右边框");
  assert.equal(lastRow(ui.text(), 32).length, 77, "底部统计不能贴右边框");
});

test("TUI 权限显示：中文任务翻译三档权限，英文任务仍显示命令标识", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const footer = () => lastRow(ui.text(), 32);

  ui.tui.beginTurn("请检查项目文件");
  assert.match(footer(), /工作区读写/);
  assert.doesNotMatch(footer(), /workspace-write/);
  ui.tui.setPermission("read-only");
  assert.match(footer(), /只读模式/);
  assert.doesNotMatch(footer(), /read-only/);
  ui.tui.setPermission("full-access");
  assert.match(footer(), /完全访问/);
  assert.doesNotMatch(footer(), /full-access/);

  ui.tui.beginTurn("Please check the project files in English");
  assert.match(footer(), /full-access/);
  ui.tui.setPermission("workspace-write");
  assert.match(footer(), /workspace-write/);
});

test("TUI 中英文切换：中文工具事件/审批/统计自动适配，Thinking 始终是英文", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  ui.tui.beginTurn("请读取 README.md 并总结仓库");
  assert.match(ui.text(), /0 次请求 · 0 tokens/);
  ui.tui.setThinking(true);
  assert.match(ui.text(), /Thinking\.\.\. \(0s\)/, "Thinking... 必须保持英文不变");
  assert.match(ui.text(), /Ctrl-C 取消/);

  const read = { id: "localized-read", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } };
  ui.tui.toolCall(read);
  assert.match(ui.text(), /读取 README\.md/);
  ui.tui.toolResult(read, "line 1\nline 2");
  assert.match(ui.text(), /收到 2 行/);

  const pending = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  pending.catch(() => {});
  assert.match(ui.text(), /Shell 权限审批/);
  assert.match(ui.text(), /工作目录： C:\\work\\repo/);
  assert.match(ui.text(), /命令：/);
  assert.match(ui.text(), /是否允许执行？/);
  assert.match(ui.text(), /1\. 是，仅允许本次/);
  assert.match(ui.text(), /2\. 否（默认）/);
  assert.match(ui.text(), /Esc 取消/);
  assert.match(ui.text(), /echo safe/, "Shell 命令保持原文");
  ui.input.write("\r");
  assert.equal(await pending, false);
  assert.match(ui.text(), /已拒绝/);

  ui.tui.beginTurn("Please read README.md and summarize this project in English");
  assert.match(ui.text(), /0 requests · 0 tokens/);
  assert.equal(ui.tui.uiText("Allowed once", "已允许本次执行"), "Allowed once");
  ui.tui.setThinking(true);
  assert.match(ui.text(), /Thinking\.\.\. \(0s\)/);
  assert.match(ui.text(), /Ctrl-C to cancel/);

  const englishRead = { ...read, id: "english-read" };
  ui.tui.toolCall(englishRead);
  ui.tui.toolResult(englishRead, "one\ntwo");
  assert.match(ui.text(), /Read README\.md/);
  assert.match(ui.text(), /Received 2 lines/);
});

test("TUI 中英文切换：不翻译模型正文和实际工具错误，不因 /permission 反馈改变语言", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  ui.tui.beginTurn("请检查这个文件并解释错误");
  const modelReply = "The model answered in English: Hello, world!";
  ui.tui.assistantDelta(modelReply);
  ui.tui.finishAssistant(modelReply);
  assert.match(ui.text(), /The model answered in English: Hello, world!/, "不得翻译模型回复");

  const call = { id: "localized-error", type: "function", function: { name: "read", arguments: '{"path":"missing.txt"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "ERROR: file not found: missing.txt");
  assert.match(ui.text(), /file not found: missing\.txt/, "工具错误必须原样保留");

  assert.equal(ui.tui.uiText("permission: workspace-write", "权限：workspace-write"), "权限：workspace-write");
  assert.match(ui.tui.helpText("read-only;workspace-write;full-access"), /命令：\/exit/);
  ui.tui.setPermission("read-only");
  assert.equal(ui.tui.uiText("session reset", "会话已重置"), "会话已重置");

  ui.tui.beginTurn("Please explain the error in English");
  assert.equal(ui.tui.uiText("permission: read-only", "权限：read-only"), "permission: read-only");
  assert.match(ui.tui.helpText("read-only;workspace-write;full-access"), /commands: \/exit/);
});


test("TUI Slash：输入 / 显示真实命令菜单，输入 /per 筛选，Enter 执行选中项", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const task = ui.tui.readLine();

  ui.input.write("/");
  await tick();
  let rows = Array.from({ length: 35 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => row.includes("/help") && row.includes("Show available commands")));
  assert.ok(rows.some((row) => row.includes("/permission") && row.includes("View or switch permission mode")));
  assert.ok(rows.some((row) => row.includes("/reset")));
  assert.ok(rows.some((row) => row.includes("/exit")));
  assert.ok(rows.some((row) => row.includes("/quit")));
  assert.equal(rows.some((row) => row.includes("/branch") || row.includes("/compact")), false, "不显示未实现命令");

  ui.input.write("per");
  await tick();
  rows = Array.from({ length: 35 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => row.includes("/permission")));
  assert.equal(rows.some((row) => row.includes("/help")), false, "实时筛选移除其他命令");

  ui.input.write("\r");
  assert.equal(await task, "/permission", "Enter 直接提交高亮补全后的命令");
});

test("TUI Slash：上下键只移动高亮，不会载入历史命令；Tab 补全但不执行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const old = ui.tui.readLine();
  ui.input.write("previous task\r");
  assert.equal(await old, "previous task");

  const task = ui.tui.readLine();
  ui.input.write("/");
  await tick();
  ui.input.write("\x1b[B");
  await tick();
  assert.ok(ui.text().includes("/permission"));
  ui.input.write("\t");
  await tick();
  const rows = Array.from({ length: 35 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => /(?:❯|>) \/permission/.test(row)), "Tab 将选中命令填入编辑行");
  assert.equal(rows.some((row) => row.includes("View or switch permission mode")), false, "补全后关闭候选菜单");

  ui.input.write("\r");
  assert.equal(await task, "/permission", "方向键不能替换成上一条历史任务");
});

test("TUI Slash：Esc 关闭菜单但保留输入，修改前缀后重新打开；未知命令保持原样", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const task = ui.tui.readLine();

  ui.input.write("/h");
  await tick();
  assert.match(ui.text(), /Show available commands/);
  ui.input.emit("keypress", "", { name: "escape", sequence: "\x1b" });
  await tick();
  const hidden = Array.from({ length: 35 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.equal(hidden.some((row) => row.includes("Show available commands")), false);
  assert.ok(hidden.some((row) => /(?:❯|>) \/h/.test(row)), "Esc 不清空输入");

  ui.input.write("e");
  await tick();
  assert.match(ui.text(), /Show available commands/, "修改查询后重新展示菜单");
  ui.input.write("lp\r");
  assert.equal(await task, "/help", "明确输入的命令按原语义提交");

  const task2 = ui.tui.readLine();
  ui.input.write("/unknown\r");
  assert.equal(await task2, "/unknown", "不识别的命令不被菜单改写");
});

test("TUI Slash：中文菜单跟随最近任务语言；输入参数/审批时不显示候选；窗口缩放不越界", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 80, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("请检查这个项目");
  const task = ui.tui.readLine();

  ui.input.write("/");
  await tick();
  let rows = Array.from({ length: 35 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => row.includes("/help") && row.includes("查看可用命令")));

  ui.output.rows = 13;
  ui.output.columns = 40;
  ui.output.emit("resize");
  await tick();
  rows = Array.from({ length: 13 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => row.includes("/help")), "小终端仍保留至少一项菜单");
  ui.input.write("permission read-only");
  await tick();
  rows = Array.from({ length: 13 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.equal(rows.some((row) => row.includes("查看或切换权限模式")), false, "命令参数不会弹菜单");

  ui.input.write("\r");
  assert.equal(await task, "/permission read-only");

  const approval = ui.tui.approve({ tool: "shell", args: { command: "echo safe" } });
  approval.catch(() => {});
  const approvalRows = Array.from({ length: 13 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.equal(approvalRows.some((row) => row.includes("查看可用命令")), false,
    "Shell 审批应在当前终端画面中隐藏 Slash 菜单，历史 ANSI 输出不计入");
  ui.input.write("\r");
  assert.equal(await approval, false);
});

test("角色语气：状态分类、中文英文独立文案与最近不重复", () => {
  const first = selectMood("thinking", "zh", [], () => 0);
  assert.ok(first.length > 0);
  const next = selectMood("thinking", "zh", [first], () => 0);
  assert.notEqual(next, first, "同一状态应避开最近展示的台词");
  const english = selectMood("searching", "en", [], () => 0);
  assert.match(english, /[A-Za-z]/);
  assert.doesNotMatch(english, /[\u4E00-\u9FFF]/);
  assert.notEqual(selectMood("approval", "zh", [], () => 0), "", "审批只使用明确的中性文案");
});

test("TUI：生命周期标题从准备到执行再到完成，不统计操作次数", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 38 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查项目");
  assert.match(screenRows(ui, 38).join("\n"), /准备执行/);
  ui.tui.setThinking(true);
  assert.match(screenRows(ui, 38).join("\n"), /正在执行 · 已用时/);
  assert.match(screenRows(ui, 38).join("\n"), /Thinking\.\.\./);
  ui.tui.finishAssistant("检查完毕。");
  ui.tui.finishTurn({ requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  const final = screenRows(ui, 38).join("\n");
  assert.match(final, /已完成 · 用时/);
  assert.match(final, /检查完毕/);
  assert.doesNotMatch(final, /\d+ 项操作|\d+ 成功|\d+ 失败/);
});

test("TUI：真实 AI 阶段说明与独立工具组匹配；超过三类显示等", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 55, columns: 108 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查并修改项目");
  ui.tui.assistantDelta("先检查相关文件和代码。");
  const calls = [
    ["read", { path: "package.json" }, "file"],
    ["grep", { pattern: "foo", path: "src" }, "matching"],
    ["edit", { path: "src/config.ts", old_string: "foo", new_string: "bar" }, "updated"],
    ["shell", { command: "npm run check" }, "exit 0"],
  ];
  calls.forEach(([name, args, result], index) => {
    const call = { id: "activity-" + index, type: "function", function: { name, arguments: JSON.stringify(args) } };
    ui.tui.toolCall(call);
    ui.tui.toolResult(call, result);
  });
  ui.tui.assistantDelta("再查看修复结果。");
  const second = { id: "activity-last", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } };
  ui.tui.toolCall(second);
  ui.tui.toolResult(second, "hello");
  ui.tui.finishAssistant("最终结果已经整理好。");
  ui.tui.finishTurn({ requests: 2, toolCalls: 5, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  const result = screenRows(ui, 55).join("\n");
  assert.match(result, /先检查相关文件和代码/);
  assert.match(result, /再查看修复结果/);
  assert.match(result, /已读取文件、已搜索代码、已修改代码等/);
  assert.match(result, /(?:↳|\+) 已读取文件/);
  assert.equal((result.match(/^  (?:↳|\+) 已读取文件/gm) ?? []).length, 2, "只计活动摘要，避免把 Windows 的 + 完成符号算进去");
  assert.match(result, /最终结果已经整理好/);
  assert.doesNotMatch(result, /Read package\.json/, "结束后默认折叠工具明细");
});

test("TUI：失败原因与命令同行，阶段折叠仍保留真实失败", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40, columns: 106 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("运行检查");
  ui.tui.assistantDelta("接下来运行类型检查。");
  const call = { id: "typecheck", type: "function", function: { name: "shell", arguments: '{"command":"npm run check"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "exit 1\nTypeScript 类型检查未通过");
  ui.tui.finishAssistant("发现类型检查错误，需要修复。");
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  const rows = screenRows(ui, 40);
  const failedRows = rows.filter((line) => line.includes("TypeScript 类型检查未通过"));
  assert.equal(failedRows.length, 1);
  assert.match(failedRows[0], /npm run check 失败 · exit 1 · TypeScript 类型检查未通过/);
  assert.match(rows.join("\n"), /已完成 · 用时/, "Shell 失败并不代表 AI 任务失败");
});

test("TUI：Ctrl+O 按阶段依次展开详情，审批键盘优先级不变", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 45 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  for (let i = 0; i < 2; i++) {
    ui.tui.assistantDelta("stage " + i);
    const call = { id: String(i), type: "function", function: { name: "read", arguments: JSON.stringify({ path: "stage" + i + ".txt" }) } };
    ui.tui.toolCall(call);
    ui.tui.toolResult(call, "content");
  }
  ui.tui.finishAssistant("done");
  ui.tui.finishTurn({ requests: 1, toolCalls: 2, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  assert.doesNotMatch(screenRows(ui, 45).join("\n"), /Read stage1\.txt/);
  ui.input.write("\x0f"); // Ctrl+O，优先查看最近一段
  await tick();
  assert.match(screenRows(ui, 45).join("\n"), /Read stage1\.txt/);
  ui.input.write("\x0f");
  await tick();
  const earlier = screenRows(ui, 45).join("\n");
  assert.match(earlier, /Read stage0\.txt/);
  assert.match(earlier, /Read stage1\.txt/, "之前展开的阶段仍保持展开");
  ui.input.write("\x0f");
  await tick();
  assert.doesNotMatch(screenRows(ui, 45).join("\n"), /Read stage1\.txt/, "再次选中该组后单独收起");
});

test("TUI：组合字符、ZWJ emoji 与日文 IME 一次性提交保持输入原文，resize 不丢字", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, columns: 108, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  // IME 上屏是连续的一段文本，而不一定是逐键 ASCII；这里验证 readline 与 TUI 缓存协作。
  const input = "日本語e\u0301👨‍👩‍👧🇯🇵";
  const pending = ui.tui.readLine();
  ui.input.write(input);
  await tick();
  assert.match(screenRows(ui, 35).join("\n"), /日本語e\u0301👨‍👩‍👧🇯🇵/);

  // 光标恢复/窗口重排不得更改实际提交文本；精确字形宽度仍取决于终端。
  ui.output.columns = 90;
  ui.output.emit("resize");
  await tick();
  ui.input.write("\r");
  assert.equal(await pending, input);
  ui.tui.beginTurn(input);
  ui.tui.assistantDelta("answer: " + input);
  ui.tui.finishAssistant();
  assert.match(screenRows(ui, 35).join("\n"), /日本語e\u0301👨‍👩‍👧🇯🇵/);
});

test("TUI：长会话超过 2000 条逻辑行后仍展示最新内容，退出恢复监听器与光标", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40, columns: 100, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  for (let turn = 0; turn < 80; turn++) {
    ui.tui.beginTurn("task-" + turn);
    const chunk = Array.from({ length: 28 }, (_, line) => "turn-" + turn + "-line-" + line).join("\n");
    ui.tui.assistantDelta(chunk);
    ui.tui.finishAssistant();
    ui.tui.finishTurn({ requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } },
      session, { failed: false });
  }

  const rows = screenRows(ui, 40).join("\n");
  assert.match(rows, /turn-79-line-27/, "最新任务尾部必须可见");
  assert.doesNotMatch(rows, /turn-0-line-0/, "最早的日志不能挤走当前内容");
  assert.equal(ui.output.listenerCount("resize"), 1);
  ui.tui.close();
  assert.equal(ui.output.listenerCount("resize"), 0, "关闭后必须移除 resize 监听器");
  const length = ui.text().length;
  ui.output.emit("resize");
  await tick();
  assert.equal(ui.text().length, length, "关闭后 resize 不能重绘");
});

test("TUI：取消时尚未返回的工具不能在历史中继续显示运行中", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查并运行命令");
  const call = { id: "pending-cancel", type: "function", function: { name: "shell", arguments: '{"command":"npm run check"}' } };
  ui.tui.toolCall(call);
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: true, cancelled: true });
  const screen = screenRows(ui, 35).join("\n");
  assert.match(screen, /已取消 · 用时/);
  assert.match(screen, /未收到工具结果/);
  assert.doesNotMatch(screen, /正在执行命令|运行中\.\.\./);
});

test("TUI：右上角未配置模型，重试时只替换当前 Thinking 行且不污染历史", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, model: "未配置模型" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  assert.match(screenRows(ui, 35).join("\n"), /未配置模型/);
  ui.tui.beginTurn("你好");
  ui.tui.setThinking(true);
  ui.tui.setRetrying(3, 5);
  const during = screenRows(ui, 35).join("\n");
  assert.match(during, /正在重新连接 3\/5/);
  assert.doesNotMatch(during, /Thinking\.\.\./);
  ui.tui.setThinking(false);
  const after = screenRows(ui, 35).join("\n");
  assert.doesNotMatch(after, /正在重新连接 3\/5/);
  assert.match(after, /未配置模型/);
});

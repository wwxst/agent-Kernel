/**
 * 文件目的：测全屏界面的显示 —— 用假的输入输出流驱动，不需要真终端。
 *
 * 看的是外面能看到的东西：状态栏写了什么、运行记录怎么分类、工具结果怎么显示。
 * 屏幕上的控制字符只做最低限度的保护 —— 那些东西每改一次排版就变一遍，
 * 全钉死的话，以后每次调整界面都要改几十条测试，最后变成为了测试而不敢改界面。
 *
 * 文件职责：`Tui` 这一处缝的全部展示行为，外加语言识别与配色解析。
 * 不测 Agent 循环（`agent.test.mjs`）、不测真实终端（`cli-pty.test.mjs`）。
 *
 * 内容目录：
 *   - 辅助：`tick()` 等两个回合让渲染落地；把历史文件指向临时路径，绝不写用户真实文件。
 *   - 配色与主题：mono / full、dark / light / ansi、无颜色终端输出纯文本。
 *   - 主视图：只追加、不进备用屏（只有 `Ctrl+T` 的 transcript 视图进）、历史行不被抹掉、
 *     轮次之间留空行、窄屏只显示提示、放大后恢复。
 *   - 等待与状态：Thinking 的符号与计时、状态行排在回复之后、重试只替换当前行。
 *   - 工具活动：折叠层次、原地从运行中变成成功/失败、失败原因、真实参数摘录、
 *     真实提交的 Unified Diff、读图缩略图、失败不显示成成功。
 *   - 流式正文：草稿与确认正文不一致时显式更正、行式模式不能撤回只能标记未确认。
 *   - 输入：长输入滚动与光标、中文宽度换行、Tab、组合字符与 emoji、括号粘贴、
 *     UTF-8 与粘贴标记分片、CR / LF 归一化、粘贴前后文和历史回填、会话粘贴归档上限、输入流恢复、
 *     `Ctrl+J` 与 `Shift+Enter` 换行、`@` 补全、`/` 命令菜单、`Ctrl+X Ctrl+E`、上下键翻历史。
 *   - 语言与权限：按任务与 locale 判断语言、只翻译界面不翻译模型正文、状态栏固定完全访问、
 *     `Shift+Tab` 不再是快捷键。
 *
 * 模块关系：依赖 `src/ui/tui.ts`、`src/ui/tui-mood.ts` 与 `node:test`，
 * 用 `PassThrough` 假终端覆盖跨平台行为，由 `npm test` 启动。
 *
 * 已知边界：真实终端里的行为留给手动验收 —— 没在真终端里跑过，就不假装验过。
 */
import assert from "node:assert/strict";
import fs, { readFileSync, rmSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Tui, detectUiLanguage, parseTuiColorMode, parseTuiTheme, uiLanguageFromLocale } from "../src/ui/tui.ts";
import { selectMood } from "../src/ui/tui-mood.ts";

// 测试不许写用户真实的 ~/.agent-kernel/history.jsonl。
process.env.AGENT_HISTORY_FILE = path.join(tmpdir(), `agent-kernel-test-history-${process.pid}.jsonl`);

/** 等一轮微任务/IO：readline 的 line 事件不会在 write() 返回前同步跑完。 */
function tick() {
  // 主视图的输入刷新走 scheduleInputChrome（setImmediate）再进 renderNow，
  // 单次 setImmediate 可能早于那一帧；这里等两个回合，断言看到的是最新画面。
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

/** 完整 TUI 合并 75ms 内的 resize；这里验收稳定后的真实帧，而非中间尺寸。 */
function settledResize() {
  return new Promise((resolve) => setTimeout(resolve, 110));
}

/**
 * 只理解 TUI 真实用到的指令：绝对定位、相对上移/下移、行尾回车、清行、清到屏尾、
 * 换行与滚动。这不是通用终端模拟器，只还原主视图（追加 + 活动区）和 transcript
 * （整屏网格）实际会发出的那几条指令。
 */
function emulateScreen(output, rows = 24, includeCursor = false) {
  const lines = [""];
  let row = 0;
  let col = 0;
  const ensure = () => {
    while (lines.length <= row) lines.push("");
  };
  const scroll = () => {
    if (row >= rows) {
      lines.shift();
      row--;
    }
  };
  const put = (text) => {
    ensure();
    const line = lines[row] ?? "";
    const padded = line.length < col ? line + " ".repeat(col - line.length) : line;
    lines[row] = padded.slice(0, col) + text;
    col += text.length;
  };
  for (const token of output.match(/\x1b\[[0-9;? ]*[A-Za-z]|[^\x1b]+/g) ?? []) {
    if (token.startsWith("\x1b[")) {
      let match;
      if ((match = token.match(/^\x1b\[(\d+);(\d+)H$/))) {
        row = Number(match[1]) - 1;
        col = Number(match[2]) - 1;
        ensure();
      } else if ((match = token.match(/^\x1b\[(\d+)A$/))) {
        row = Math.max(0, row - Number(match[1]));
        col = 0;
      } else if ((match = token.match(/^\x1b\[(\d+)B$/))) {
        row += Number(match[1]);
        scroll();
      } else if ((match = token.match(/^\x1b\[(\d+)C$/))) {
        col += Number(match[1]);
      } else if (token === "\x1b[H") {
        row = 0;
        col = 0;
      } else if (token === "\x1b[2J") {
        lines.length = 1;
        lines[0] = "";
        row = 0;
        col = 0;
      } else if (token === "\x1b[2K") {
        ensure();
        lines[row] = "";
        col = 0;
      } else if (token === "\x1b[J") {
        ensure();
        lines[row] = (lines[row] ?? "").slice(0, col);
        lines.length = row + 1;
      }
      continue;
    }
    for (const part of token.split(/(\r\n|\n|\r)/)) {
      if (part === "\r\n" || part === "\n") {
        row++;
        scroll();
        ensure();
        col = 0;
      } else if (part === "\r") {
        col = 0;
      } else if (part !== "") {
        put(part);
      }
    }
  }
  const screen = lines.map((line) => line.trimEnd());
  return includeCursor ? { lines: screen, row, col } : screen;
}

/** 取当前画面第 row 行（1 起）；主视图的历史是追加的，行号按屏幕从上往下数。 */
function lastRow(text, row) {
  return emulateScreen(text, 40)[row - 1] ?? "";
}

/** 把屏幕还原成数组；不足 count 行用空串补齐，索引 0 对应第 1 行。 */
function screenRows(ui, count = 40) {
  // 用这台假终端真实的窗口高度：主视图超出窗口时会像真终端一样往上滚。
  const rows = emulateScreen(ui.text(), ui.output?.rows ?? 24);
  while (rows.length < count) rows.push("");
  return rows.slice(0, count);
}

/**
 * 输入框不再固定在屏幕底部：主视图里它跟着内容走。
 * 因此按「提示符开头的那一行」定位，而不是写死行号。
 */
function inputIndex(ui) {
  // 用户消息也以 > 开头，输入框永远在最下面，所以取最后一个匹配。
  return screenRows(ui).findLastIndex((line) => /^[>❯]/.test(line));
}

function inputLine(ui) {
  const rows = screenRows(ui);
  const index = rows.findLastIndex((line) => /^[>❯]/.test(line));
  return index < 0 ? "" : rows[index];
}

function boxTopLine(ui) {
  const rows = screenRows(ui);
  const index = inputIndex(ui);
  return index > 0 ? rows[index - 1] : "";
}

function boxBottomLine(ui) {
  const rows = screenRows(ui);
  const index = inputIndex(ui);
  return index < 0 ? "" : rows[index + 1] ?? "";
}

function statusLine(ui) {
  const rows = screenRows(ui);
  // 状态行永远在最下面：权限标签 + 请求/token 统计，按这一行的特征找，不写死行号。
  return rows.findLast((line) => /(?:requests|请求|tokens)/.test(line)) ?? "";
}

/** 进 transcript 抓一帧详情：主视图只留摘要，细节都在这个视图里。 */
async function detailText(ui) {
  ui.input.emit("keypress", "", { name: "t", ctrl: true });
  // 帧是节流渲染的，等一个周期再抓。
  await new Promise((resolve) => setTimeout(resolve, 60));
  const text = ui.text();
  ui.input.emit("keypress", "", { name: "escape" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  return text.slice(text.lastIndexOf("\x1b[?1049h"));
}

/** 按内容找一行：主视图排版随内容变化，断言不该写死行号。 */
function rowWith(ui, pattern) {
  return screenRows(ui, 40).find((line) => pattern.test(line)) ?? "";
}

/**
 * 一套假终端。interactive 模拟真实键盘输入；tty=true 才模拟 stdout 是终端，
 * 从而启用固定布局。两者分开，才能单独验证行式输出与固定布局。
 */
function makeTui({ interactive = false, tty = false, columns = 80, rows = 24, color = false, colorMode = "full", theme = "dark", flowInput = false, language, term = "xterm-256color", model = "mock-model", workspace = "C:\\work\\repo" } = {}) {
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
    workspace,
    controller,
    interactive,
    columns,
    rows,
    color,
    colorMode,
    theme,
    flowInput,
    language,
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


test("TUI 主题：light 换成浅底深字，ansi 强制 16 色", async (t) => {
  assert.equal(parseTuiTheme(undefined), "dark");
  assert.equal(parseTuiTheme(""), "dark");
  assert.equal(parseTuiTheme("dark"), "dark");
  assert.equal(parseTuiTheme("light"), "light");
  assert.equal(parseTuiTheme("ansi"), "ansi");
  assert.throws(() => parseTuiTheme("solarized"), /invalid AGENT_TUI_THEME/);

  const light = makeTui({ interactive: true, tty: true, color: true, colorMode: "full", theme: "light" });
  const ansi = makeTui({ interactive: true, tty: true, color: true, colorMode: "full", theme: "ansi" });
  t.after(() => { light.cleanup(); ansi.cleanup(); });
  light.tui.start();
  ansi.tui.start();
  light.tui.beginTurn("你好");
  ansi.tui.beginTurn("你好");
  await tick();

  // 任务条：浅色终端用浅灰底黑字，深灰底在白色背景上像一块污渍。
  assert.match(light.text(), /\x1b\[30;47m\x1b\[38;5;240;48;5;254m(?:❯|>) /, "浅色主题的任务条要反过来");
  assert.doesNotMatch(light.text(), /48;5;237m/, "不能再用深色主题的底色");

  // 强调色：浅色 34 / 166，深色 33 / 215。两组不重叠，能证明换的是色系不是开关。
  assert.match(light.text(), /\x1b\[(?:34|38;5;166)m/);
  assert.doesNotMatch(light.text(), /\x1b\[(?:33|38;5;215)m/, "浅色主题不能沿用深色终端的强调色");

  // ansi：就是要终端自己那套 16 色，rich 探测说了不算。
  assert.match(ansi.text(), /\x1b\[33m/);
  assert.doesNotMatch(ansi.text(), /\x1b\[38;5;215m/, "ansi 主题不能落到 256 色强调色");
});


test("TUI：start 前 close 不清屏、不移动光标、不进入备用屏幕，之后也不能启动", (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.close();
  assert.equal(ui.text(), "", "未启动的界面只能释放资源，不应更改 Shell");
  ui.tui.start();
  assert.equal(ui.text(), "", "已关闭的界面不能再启动");
});





test("TUI 稳定日志 ID：展开较早的工具详情不会把历史中段跳到最新", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
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








test("TUI 鼠标：拆包 SGR 序列安全解析，滚轮以小步长浏览历史", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 26, columns: 85 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  for (let i = 0; i < 60; i++) ui.tui.logLine(`mouse-history-${i}`);
  const last = screenRows(ui, 26).join("\n");
  assert.match(last, /mouse-history-59/);
  ui.input.write("\x1b[<64;20;");
  ui.input.write("10M");
  await tick();
  assert.match(screenRows(ui, 26).join("\n"), /(?:↑|\^) 3 (?:lines|行)/);
  ui.input.write("\x1b[<65;20;10M");
  await tick();
  assert.match(screenRows(ui, 26).join("\n"), /mouse-history-59/);
});


test("TUI 时间线：第四层展示真实调用和结果，不能编造 Diff", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 45, columns: 115 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("编辑文件并检查");
  const call = { id: "edit-detail", type: "function", function: { name: "edit", arguments: '{"path":"src/tui.ts","old_string":"a","new_string":"b"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "Updated src/tui.ts");
  let screen = await detailText(ui);
  assert.match(screen, /编辑 src\/tui\.ts.*(?:▸|>)/);
  assert.doesNotMatch(screen, /调用：/, "原始工具详情默认不展开");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  screen = await detailText(ui);
  assert.match(screen, /编辑 src\/tui\.ts.*(?:▾|v)/);
  assert.match(screen, /调用：.*edit/);
  assert.match(screen, /Updated src\/tui\.ts/);
  assert.match(screen, /替换片段（非完整 Diff）/);
  assert.match(screen, /- a/);
  assert.match(screen, /\+ b/);
  assert.doesNotMatch(screen, /@@ -\d/, "不根据路径虚构带行号的完整文件 Diff");
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
  assert.match(boxTopLine(ui), /^(?:-{78}|─{78})$/);
  assert.match(inputLine(ui), /^(?:>|❯) 中文A/);
  assert.equal(boxBottomLine(ui), boxTopLine(ui));
  // 主视图用相对列偏移把光标放回输入位置（不再有绝对行号）。
  assert.match(ui.text(), /\x1b\[\d+C\x1b\[\?25h/);
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
  assert.match(inputLine(ui).trimEnd(), /^(?:>|❯)$/);
  ui.input.write("\r");
  assert.equal(await pending, "");
});


test("TUI：等待状态分层并动态换符号，首段正文到达后停止更新", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.setThinking(true);
  const first = rowWith(ui, /Thinking\.\.\./);
  assert.match(first, /Thinking\.\.\. \(0s\)/);
  // 「怎么取消」在底部状态栏，不占内容行。
  assert.match(ui.text(), /Ctrl-C (?:to cancel|cancel|取消)/);
  t.mock.timers.tick(200);
  assert.notEqual(rowWith(ui, /Thinking\.\.\./), first);
  ui.tui.assistantDelta("hello");
  t.mock.timers.tick(1000);
  assert.match(rowWith(ui, /hello/), /hello/);
  assert.doesNotMatch(rowWith(ui, /Thinking\.\.\./), /Thinking/, "正文到达后不再残留等待态");
});

test("TUI：Thinking 三个点保持静止，前置符号变化且耗时信息不左右跳动", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.setThinking(true);
  const detailColumn = rowWith(ui, /Thinking\.\.\./).indexOf("(");
  let previousSymbol = "";
  for (let frame = 0; frame < 5; frame++) {
    const line = rowWith(ui, /Thinking\.\.\./);
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
    const symbol = rowWith(ui, /Thinking\.\.\./).split(" ")[0];
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
  const statusCall = { id: "status-tool", type: "function", function: { name: "ls", arguments: '{"path":"."}' } };
  ui.tui.toolCall(statusCall);
  ui.tui.toolResult(statusCall, "file 1 a.txt");
  t.mock.timers.tick(3200);
  ui.tui.finishAssistant("done");
  ui.tui.finishTurn(run, session, { failed: false });
  assert.match(screenRows(ui).join("\n"), /Completed · in 3s/, "状态位置允许随折叠布局上移");
  ui.tui.beginTurn("second");
  t.mock.timers.tick(1000);
  ui.tui.finishTurn({ ...run, toolCalls: 0 }, session, { failed: true });
  assert.match(screenRows(ui).join("\n"), /Failed · after 1s/);
  assert.doesNotMatch(screenRows(ui).join("\n"), /after 4s/);
});

test("TUI：下一轮用户消息与上轮耗时之间留一行空白，首条消息仍贴顶", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const ui = makeTui({ interactive: true, tty: true, flowInput: true, rows: 35 });
  t.after(() => ui.cleanup());
  const run = { requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } };
  ui.tui.start();
  ui.tui.beginTurn("first");
  const statusTool = { id: "status-tool", type: "function", function: { name: "ls", arguments: '{"path":"."}' } };
  ui.tui.toolCall(statusTool);
  ui.tui.toolResult(statusTool, "file 1 a.txt");
  assert.match(lastRow(ui.text(), 4), /^(?:❯|>) first/);
  ui.tui.finishAssistant("done");
  t.mock.timers.tick(2000);
  ui.tui.finishTurn(run, session, { failed: false });
  ui.tui.beginTurn("second");
  const rows = screenRows(ui, 35);
  const previous = rows.findIndex((row) => /Completed · in 2s/.test(row));
  const second = rows.findIndex((row) => /^(?:❯|>) second/.test(row));
  assert.ok(previous >= 0 && second > previous, "上一轮完成状态保留在新任务之前");
  assert.ok(rows.slice(previous + 1, second).some((row) => row.trim() === ""), "两轮之间保留空行");
});

test("TUI：标题标明程序和项目，用户正文与输入边界使用中性层次", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, color: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("READ_ME");
  await tick();
  assert.match(ui.text(), /agent-Kernel · repo/);
  assert.match(ui.text(), /\x1b\[37;100m\x1b\[38;5;246;48;5;237m(?:❯|>) \x1b\[1;97;100m\x1b\[38;5;255;48;5;237mREAD_ME/, "用户消息使用 Claude Code 任务条：灰色前缀 + 深灰底色 + 白色粗体正文");
  assert.match(ui.text(), /\x1b\[(?:90|38;5;244)m[-─]/, "输入框上边框用中性层次");
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


test("TUI：Shell 非零退出显示失败，文件中的退出码文本仍是成功读取", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const call = { id: "exit", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: 'node -e "process.exitCode=7"' }) } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "exit 7\nfailed check\nnext step");
  await tick();
  const rows = screenRows(ui, 40);
  const shellRow = rows.findIndex((line) => /(?:✗|x) Shell/.test(line));
  assert.ok(shellRow >= 0, "Shell 工具行在屏幕上");
  assert.match(rows[shellRow + 1], /exit 7/);
  assert.match(rows[shellRow + 2], /failed check/);
  assert.match(rows[shellRow + 3], /next step/);

  const read = { id: "read-exit", type: "function", function: { name: "read", arguments: '{"path":"status.txt"}' } };
  ui.tui.toolCall(read);
  ui.tui.toolResult(read, "exit 7\nfailed check");
  await tick();
  assert.match(rowWith(ui, /Read status\.txt/), /(?:✓|\+) Read status\.txt/);
  assert.match(rowWith(ui, /Received 2 lines/), /Received 2 lines/);
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
  assert.match(ui.text(), /Ctrl-C (?:to cancel|cancel|取消)/);
  t.mock.timers.tick(2000);
  assert.match(ui.text(), /Thinking\.\.\. \(2s\)/);
  ui.tui.assistantDelta("hello");
  t.mock.timers.tick(3000);
  assert.match(rowWith(ui, /hello/), /hello/);
  assert.doesNotMatch(rowWith(ui, /Thinking\.\.\./), /Thinking/, "正文后不再残留等待态");
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
  assert.match(inputLine(ui), /6789\s*$/);
  assert.ok(inputLine(ui).length <= 33, "输入行不能超过终端右边界");
  ui.input.write("\x1b[H");
  await tick();
  assert.match(inputLine(ui), /abcde/);
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
  assert.match(inputLine(ui), /draft/);
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
  const rows = screenRows(ui, 40);
  const toolRow = rows.findIndex((line) => /Received 1 line/.test(line));
  assert.ok(toolRow >= 0, "工具结果行在屏幕上");
  assert.equal(rows[toolRow + 1].trim(), "", "工具结果与回复之间留一行空白");
  assert.match(rows[toolRow + 2], /(?:✻|\*) abcdef/);
  assert.equal(rowWith(ui, /456789/), "  456789", "续行保持正文缩进");
});

test("TUI：缩至窄窗口只显示提示，恢复宽度后重新显示历史和草稿", async (t) => {
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
  await settledResize();
  // 主视图不再显示「窗口太小」提示：窄窗口只按当前宽度折行，历史仍然可读。
  assert.match(ui.text().slice(start), /narrow output/);
  ui.output.columns = 80;
  ui.output.rows = 24;
  ui.output.emit("resize");
  await settledResize();
  assert.match(lastRow(ui.text(), 4), /narrow output/);
  assert.match(inputLine(ui), /中文draft/);
  ui.input.write("\r");
  assert.equal(await pending, "中文draft");
});

test("TUI：窄屏状态行保留完整权限和请求/token 统计", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 34 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.setStats(session);
  await tick();
  const screen = screenRows(ui).join("\n");
  assert.match(screen, /full-access/);
  assert.match(screen, /2r 12tok/);
  assert.ok(statusLine(ui).length <= 34, "状态行不超出窗口宽度");
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
  await settledResize();
  const screen = screenRows(ui).join("\n");
  assert.match(screen, /TASK_NARROW/);
  // 主视图不重复描述：只有工具行，不再有「已读取文件…」这种同义概述。
  assert.match(screen, /(?:✓|\+|↳) Read a\.txt/);
  assert.match(screen, /(?:✓|\+|↳) Read a\.txt/);
  // 工具结果属于详情层：主视图只留一行工具，结果去 transcript 看。
  assert.match(await detailText(ui), /Received 1 line/);
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
  await settledResize();
  assert.match(inputLine(ui), /VISIBLE_DRAFT/);
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
  assert.doesNotMatch(inputLine(ui), /\t/);
  assert.match(inputLine(ui), /\\u0009/);
  assert.ok(inputLine(ui).length <= 34);
  ui.input.write("\r");
  assert.equal(await pending, task);
});


test("TUI：窄屏隐藏中间 Thinking，放大后显示真实回复和工具结果", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 20, rows: 8 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  const call = { id: "r", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  ui.tui.setThinking(true);
  ui.tui.toolCall(call);
  ui.tui.assistantDelta("I will inspect");
  ui.tui.toolResult(call, "body");
  ui.output.columns = 80;
  ui.output.rows = 24;
  ui.output.emit("resize");
  await settledResize();
  const screen = screenRows(ui).join("\n");
  assert.match(screen, /I will inspect/);
  assert.match(screen, /Read a\.txt/);
  assert.doesNotMatch(screen, /Thinking\.\.\./);
});

test("TUI：交互终端 TERM=dumb 明确报错，不悄悄切换行式聊天", () => {
  const previous = process.env.TERM;
  process.env.TERM = "dumb";
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    output.isTTY = true;
    assert.throws(() => new Tui({
      input, output, model: "mock", workspace: "repo",
      controller: new AbortController(), interactive: true, columns: 80, rows: 24,
    }), /full TUI requires an ANSI-capable terminal/);
    input.end();
  } finally {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  }
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
  ui.tui.toolResult(shellCall, "exit 1\nboom");
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
  assert.match(text, /access: full-access/);
  assert.match(text, /you: do it/);
  assert.match(text, /model: working on it/);
  assert.match(text, /second line/);
  assert.match(text, /→ read path=a\.txt/);
  assert.match(text, /✓ read \[ok\] read result/);
  assert.match(text, /→ shell echo hi/);
  assert.match(text, /✗ shell \[failed\] exit 1 …/);
  assert.match(text, /\[stats\] requests=2 tool_calls=2 tokens=12 · task failed/);
  assert.match(text, /\[session\] runs=1 requests=2 tool_calls=2 tokens=12/);
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

test("TUI：主视图不进备用屏，transcript 视图才进，退出还原", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  await tick();
  const started = ui.text();
  assert.match(started, /repo/);
  assert.match(started, /mock-model/);
  assert.match(started, /C:\\work\\repo/);
  assert.match(started, /full-access/);
  assert.match(started, /0 requests · 0 tokens/);
  assert.doesNotMatch(started, /\x1b\[\?1049h/, "主视图不切备用屏，打开前的历史才看得见");
  assert.match(started, /\x1b\[\?2026h/, "活动区整帧包在同步更新里");

  // Ctrl+T 进 transcript：临时独占备用屏回看历史。
  ui.input.emit("keypress", "", { name: "t", ctrl: true });
  await tick();
  assert.match(ui.text(), /\x1b\[\?1049h/, "transcript 视图才进备用屏");

  // Esc 退出，主屏原样还回来。
  ui.input.emit("keypress", "", { name: "escape" });
  await tick();
  assert.match(ui.text(), /\x1b\[\?1049l/, "退出 transcript 恢复主屏");
});

test("TUI：短对话内容紧接抬头，输入框跟着内容走", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.beginTurn("hello");
  await tick();
  const rows = screenRows(ui, 30);
  // 抬头占前三行，对话从第四行开始；内容不足一屏时输入框紧跟着它，不沉到屏幕底部。
  assert.match(rows[3] ?? "", /(?:❯|>) hello/, "对话从抬头下方第一行开始");
  assert.equal(rows[4] ?? "", "", "内容与输入框之间保留空行");
  assert.match(inputLine(ui), /^(?:>|❯)/, "输入框紧跟在内容下方");
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
  const notRun = {
    id: "tool-not-run",
    type: "function",
    function: { name: "shell", arguments: JSON.stringify({ command: "npm run check" }) },
  };

  ui.tui.start();
  ui.tui.toolCall(failed);
  ui.tui.toolResult(failed, "ERROR: File not found: src/missing.ts");
  ui.tui.toolCall(notRun);
  ui.tui.toolResult(notRun, "ERROR: not run: task cancelled");
  await tick();

  const text = ui.text();
  assert.match(text, /(?:✗|x) Read src\/missing\.ts/);
  assert.match(text, /File not found: src\/missing\.ts/);
  assert.match(text, /(?:–|-) Shell: npm run check/);
  assert.match(text, /not run: task cancelled/);
});

test("TUI：Shift+Tab 不再切换权限，页脚保持完全访问", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  await tick();
  const before = statusLine(ui);
  assert.match(before, /access: full-access/);

  ui.input.emit("keypress", "", { name: "tab", shift: true });
  await tick();

  assert.equal(statusLine(ui), before, "Shift+Tab 不再是权限切换快捷键");
  assert.doesNotMatch(ui.text(), /Confirm full-access|shift-tab to cycle/);
});

test("TUI：固定布局的页脚显示完全访问和完整统计", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());

  ui.tui.start();
  ui.tui.setStats(session);
  await tick();
  const text = ui.text();
  assert.match(text, /access: full-access/);
  assert.match(text, /2 requests · 2 tool calls · 12 tokens/);
  // 只有一种权限：页脚不能再出现切换提示。
  assert.doesNotMatch(text, /shift-tab/i);
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

  const zh = makeTui({ interactive: true, tty: true, rows: 35, language: "zh" });
  const en = makeTui({ interactive: true, tty: true, rows: 35, language: "en" });
  t.after(() => { zh.cleanup(); en.cleanup(); });
  zh.tui.start();
  en.tui.start();

  assert.match(statusLine(zh), /权限：完全访问/);
  assert.match(statusLine(en), /access: full-access/);
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
  // 可用内容宽 = columns - 2（末列留空防折行，再多留一列给模糊宽度字符），再让出 2 列右边距。
  assert.equal(screenRows(ui)[0].length, 76, "顶部模型名不能贴右边框");
  assert.equal(statusLine(ui).length, 76, "底部统计不能贴右边框");
});

test("TUI 权限显示：只有完全访问一个标签，语言跟随任务但不提供切换", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const footer = () => statusLine(ui);

  ui.tui.beginTurn("请检查项目文件");
  assert.match(footer(), /权限：完全访问/);
  assert.doesNotMatch(footer(), /full-access/);
  assert.doesNotMatch(footer(), /切换/);

  ui.tui.beginTurn("Please check the project files in English");
  assert.match(footer(), /access: full-access/);
  assert.doesNotMatch(footer(), /Shift\+Tab|shift-tab/i);
});

test("TUI 中英文切换：中文工具事件/统计自动适配，Thinking 始终是英文", async (t) => {
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
  // 结果行属于详情层：去 transcript 里断言。
  assert.match(await detailText(ui), /收到 2 行/);

  ui.tui.beginTurn("Please read README.md and summarize this project in English");
  assert.match(ui.text(), /0 requests · 0 tokens/);
  assert.equal(ui.tui.uiText("Allowed once", "已允许本次执行"), "Allowed once");
  ui.tui.setThinking(true);
  assert.match(ui.text(), /Thinking\.\.\. \(0s\)/);
  // 英文环境同样把「怎么取消」放在状态栏。
  assert.match(ui.text(), /Ctrl-C cancel/);

  const englishRead = { ...read, id: "english-read" };
  ui.tui.toolCall(englishRead);
  ui.tui.toolResult(englishRead, "one\ntwo");
  assert.match(ui.text(), /Read README\.md/);
  assert.match(await detailText(ui), /Received 2 lines/);
});

test("TUI 中英文切换：不翻译模型正文和实际工具错误，只翻译界面提示", async (t) => {
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

  assert.equal(ui.tui.uiText("session reset", "会话已重置"), "会话已重置");
  // 主视图已拍平：帮助只讲会话命令和按键，不再提权限切换。
  const help = ui.tui.helpText();
  assert.match(help, /命令：\/exit/);
  assert.match(help, /输入：Enter 发送 · Shift\+Enter 或 Ctrl\+J 换行/);
  assert.match(help, /视图：Ctrl\+E 历史 · PgUp 暂停刷新/);
  assert.doesNotMatch(help, /permission|权限/);

  ui.tui.beginTurn("Please explain the error in English");
  assert.equal(ui.tui.uiText("permission: denied", "权限：已拒绝"), "permission: denied");
  assert.match(ui.tui.helpText(), /commands: \/exit/);
  assert.match(ui.tui.helpText(), /input:  Enter send · Shift\+Enter or Ctrl\+J newline/);
});


test("TUI Slash：输入 / 显示真实命令菜单，输入 /he 筛选，Enter 执行选中项", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35, flowInput: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const task = ui.tui.readLine();

  ui.input.write("/");
  await tick();
  let rows = Array.from({ length: 35 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => row.includes("/help") && row.includes("Show available commands")));
  assert.ok(rows.some((row) => row.includes("/reset")));
  assert.ok(rows.some((row) => row.includes("/exit")));
  assert.ok(rows.some((row) => row.includes("/quit")));
  assert.equal(rows.some((row) => row.includes("/branch") || row.includes("/compact")), false, "不显示未实现命令");

  ui.input.write("he");
  await tick();
  rows = Array.from({ length: 35 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => row.includes("/help")));
  assert.equal(rows.some((row) => row.includes("/reset")), false, "实时筛选移除其他命令");

  ui.input.write("\r");
  assert.equal(await task, "/help", "Enter 直接提交高亮补全后的命令");
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
  assert.ok(ui.text().includes("/reset"));
  ui.input.write("\t");
  await tick();
  const rows = Array.from({ length: 35 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => /(?:❯|>) \/reset/.test(row)), "Tab 将选中命令填入编辑行");
  assert.equal(rows.some((row) => row.includes("Clear the current conversation")), false, "补全后关闭候选菜单");

  ui.input.write("\r");
  assert.equal(await task, "/reset", "方向键不能替换成上一条历史任务");
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

test("TUI Slash：中文菜单跟随最近任务语言；输入参数时不显示候选；窗口缩放不越界", async (t) => {
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
  await settledResize();
  rows = Array.from({ length: 13 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.ok(rows.some((row) => row.includes("/help")), "小终端仍保留至少一项菜单");
  ui.input.write("reset now");
  await tick();
  rows = Array.from({ length: 13 }, (_, i) => lastRow(ui.text(), i + 1));
  assert.equal(rows.some((row) => row.includes("查看可用命令")), false, "命令参数不会弹菜单");

  ui.input.write("\r");
  assert.equal(await task, "/reset now");
});

test("角色语气：状态分类、中文英文独立文案与最近不重复", () => {
  const first = selectMood("thinking", "zh", [], () => 0);
  assert.ok(first.length > 0);
  const next = selectMood("thinking", "zh", [first], () => 0);
  assert.notEqual(next, first, "同一状态应避开最近展示的台词");
  const english = selectMood("searching", "en", [], () => 0);
  assert.match(english, /[A-Za-z]/);
  assert.doesNotMatch(english, /[\u4E00-\u9FFF]/);
});

test("TUI：生命周期标题从准备到执行再到完成，不统计操作次数", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 38 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查项目");
  assert.match(screenRows(ui, 38).join("\n"), /准备执行/);
  const statusTool = { id: "status-tool", type: "function", function: { name: "ls", arguments: '{"path":"."}' } };
  ui.tui.toolCall(statusTool);
  ui.tui.toolResult(statusTool, "file 1 a.txt");
  ui.tui.setThinking(true);
  // 主视图拍平：等待模型时只留 Thinking 一行（带秒数和工具结果数），不再叠一行「正在执行」。
  assert.match(screenRows(ui, 38).join("\n"), /Thinking\.\.\. \(0s/);
  assert.doesNotMatch(screenRows(ui, 38).join("\n"), /正在执行 · 已用时/);
  ui.tui.finishAssistant("检查完毕。");
  ui.tui.finishTurn({ requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  const final = screenRows(ui, 38).join("\n");
  assert.match(final, /已完成 · 用时/);
  assert.match(final, /检查完毕/);
  assert.doesNotMatch(final, /\d+ 项操作|\d+ 成功|\d+ 失败/);
});

test("TUI 时间线：连续无文字模型请求仍分成独立活动阶段", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 48, columns: 118 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("请检查项目并运行验证");
  ui.tui.beginModelRequest();
  const first = { id: "phase-read", type: "function", function: { name: "read", arguments: '{"path":"src/tui.ts"}' } };
  ui.tui.toolCall(first);
  ui.tui.toolResult(first, "file content");
  ui.tui.beginModelRequest();
  const next = { id: "phase-shell", type: "function", function: { name: "shell", arguments: '{"command":"npm run check"}' } };
  ui.tui.toolCall(next);
  ui.tui.toolResult(next, "exit 0");
  const screen = await detailText(ui);
  assert.ok(screen.indexOf("已读取文件 src/tui.ts。") < screen.indexOf("命令执行结束 npm run check。"),
    "不同模型请求各自保存真实进度，按发生顺序展示");
  assert.equal((screen.match(/(?:↳|\+) 已读取文件/g) ?? []).length, 1);
  assert.equal((screen.match(/(?:↳|\+) 已执行命令/g) ?? []).length, 1);
});


test("TUI 图片详情：真实 PNG 字节在工具展开后显示缩略图和尺寸", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 45, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("查看图片");
  const call = { id: "image-read", type: "function", function: {
    name: "read", arguments: '{"path":"terminal.png"}',
  } };
  ui.tui.toolCall(call);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  ui.tui.recordImagePreview(call.id, "terminal.png", png);
  ui.tui.toolResult(call, "image file returned");
  assert.doesNotMatch(await detailText(ui), /真实图片预览：/);
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const screen = await detailText(ui);
  assert.match(screen, /真实图片预览： PNG · 1 × 1/);
  assert.match(screen, /│/, "应实际生成像素字符行，而非只画占位文本");
});


test("P2 write：远距离多处修改显示两段正确行号的独立 Unified Diff", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 70, columns: 120 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("覆盖配置文件");
  const call = { id: "multi-hunk-write", type: "function", function: {
    name: "write", arguments: '{"path":"config.txt","content":"two separate changes"}',
  } };
  const oldLines = Array.from({ length: 40 }, (_, i) => "line-" + String(i + 1).padStart(2, "0"));
  const newLines = [...oldLines];
  newLines[4] = "changed-05";
  newLines[32] = "changed-33";
  ui.tui.toolCall(call);
  ui.tui.recordEditDiff(call.id, "config.txt", oldLines.join("\n") + "\n", newLines.join("\n") + "\n");
  ui.tui.toolResult(call, "wrote 430 chars to config.txt");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const screen = await detailText(ui);
  const headers = screen.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g) ?? [];
  assert.deepEqual(headers, ["@@ -2,7 +2,7 @@", "@@ -30,7 +30,7 @@"],
    "相距很远的两个替换须有两段真实行号，而不是整片删除重建");
  assert.match(screen, /-line-05/);
  assert.match(screen, /\+changed-05/);
  assert.match(screen, /-line-33/);
  assert.match(screen, /\+changed-33/);
  assert.doesNotMatch(screen, / line-18/, "未变化的中间行不能挤进整个巨大 hunk");
});

test("P2 write：远处插入和删除也保留正确 hunk 行号", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 70, columns: 120 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("覆盖列表文件");
  const call = { id: "insert-delete-write", type: "function", function: {
    name: "write", arguments: '{"path":"list.txt","content":"content"}',
  } };
  const oldLines = Array.from({ length: 30 }, (_, i) => "entry-" + (i + 1));
  const newLines = [...oldLines];
  newLines.splice(2, 0, "inserted");
  newLines.splice(newLines.indexOf("entry-27"), 1);
  ui.tui.toolCall(call);
  ui.tui.recordEditDiff(call.id, "list.txt", oldLines.join("\n") + "\n", newLines.join("\n") + "\n");
  ui.tui.toolResult(call, "wrote list.txt");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const screen = await detailText(ui);
  assert.equal((screen.match(/@@ -/g) ?? []).length, 2, "插入与远处删除应分成两个 hunk");
  assert.match(screen, /\+inserted/);
  assert.match(screen, /-entry-27/);
  assert.match(screen, /@@ -1,5 \+1,6 @@/, "文件开头附近插入须准确计算范围");
});

test("P2 write：大文件快照不可用时明确降级且不伪造 Unified Diff", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 43, columns: 115 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("覆盖大文件");
  const call = { id: "large-write-no-snapshot", type: "function", function: {
    name: "write", arguments: '{"path":"large.txt","content":"..."}',
  } };
  ui.tui.toolCall(call);
  ui.tui.recordEditDiff(call.id, "large.txt", undefined, "short replacement", false);
  ui.tui.toolResult(call, "wrote 17 chars to large.txt");
  let screen = await detailText(ui);
  assert.match(screen, /Diff 预览已降级|Diff preview unavailable/, "无需展开原始工具详情即可看到降级原因");
  assert.match(screen, /2,000,000 (?:bytes|字节)/, "提示必须采用实际 Workspace 限制而不是近似 2 MiB");
  assert.doesNotMatch(screen, /2 MiB/, "禁止把 2,000,000 字节误写为 2 MiB");
  assert.doesNotMatch(screen, /实际提交的 Unified Diff/, "快照不存在不能显示冒充完整 Diff 的标题");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  screen = await detailText(ui);
  assert.match(screen, /Diff 预览已降级|Diff preview unavailable/);
  assert.doesNotMatch(screen, /--- a\/large\.txt/, "缺少真实前后快照不能伪造补丁");
});

test("TUI Unified Diff：write 新建文件展示 /dev/null 与完整新增行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 44, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("创建文件");
  const call = { id: "create-file-patch", type: "function", function: {
    name: "write", arguments: '{"path":"new.ts","content":"one\\ntwo\\n"}',
  } };
  ui.tui.toolCall(call);
  ui.tui.recordEditDiff(call.id, "new.ts", "", "one\ntwo\n", true);
  ui.tui.toolResult(call, "wrote 8 chars to new.ts");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const screen = await detailText(ui);
  assert.match(screen, /--- \/dev\/null/);
  assert.match(screen, /\+\+\+ b\/new\.ts/);
  assert.match(screen, /@@ -0,0 \+1,2 @@/);
  assert.match(screen, /\+one/);
  assert.match(screen, /\+two/);
});

test("TUI Unified Diff：超长行和超大文件严格限制预览尺寸", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 45, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("修改大文件");
  const call = { id: "large-diff", type: "function", function: {
    name: "edit", arguments: '{"path":"large.txt","old_string":"old","new_string":"new"}',
  } };
  ui.tui.toolCall(call);
  ui.tui.recordEditDiff(call.id, "large.txt", "a".repeat(1500) + "\n", "b".repeat(1500) + "\n");
  ui.tui.toolResult(call, "edited large.txt");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const screen = await detailText(ui);
  assert.match(screen, /line truncated|Diff 过大/, "很长的一行也必须截断，而非无限制重绘");
  assert.doesNotMatch(screen, /a{400}/, "不能把整条超长原始行推入终端");
  const hugeCall = { id: "huge-diff", type: "function", function: {
    name: "edit", arguments: '{"path":"huge.txt","old_string":"a","new_string":"b"}',
  } };
  ui.tui.toolCall(hugeCall);
  ui.tui.recordEditDiff(hugeCall.id, "huge.txt", "a\n".repeat(200_000), "b\n".repeat(200_000));
  ui.tui.toolResult(hugeCall, "edited huge.txt");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const huge = await detailText(ui);
  assert.match(huge, /bounded terminal diff preview limit/, "超大文件不能分配数十万条行对象");
});

test("TUI Unified Diff：仅修改 EOF 换行也要产生正确增删和缺少换行标记", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 44, columns: 108 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("修复文件结尾换行");
  const call = { id: "eof-newline", type: "function", function: {
    name: "edit", arguments: '{"path":"single.txt","old_string":"same","new_string":"same\\n"}',
  } };
  ui.tui.toolCall(call);
  ui.tui.recordEditDiff(call.id, "single.txt", "same", "same\n");
  ui.tui.toolResult(call, "edited single.txt");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const screen = await detailText(ui);
  assert.match(screen, /@@ -1,1 \+1,1 @@/);
  assert.match(screen, /-same/);
  assert.match(screen, /\+same/);
  assert.match(screen, /\\ No newline at end of file/);
  assert.doesNotMatch(screen, /@@ -2,0 \+2,0 @@/, "不能产生空的零长度假 hunk");
});

test("TUI Unified Diff：只有真实 Workspace 提交快照才显示带正确行号的补丁", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 45, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("修改文件");
  const call = { id: "full-patch", type: "function", function: {
    name: "edit", arguments: '{"path":"src/tui.ts","old_string":"old","new_string":"new"}',
  } };
  ui.tui.toolCall(call);
  ui.tui.recordEditDiff(call.id, "src/tui.ts", "first\nold\nlast\n", "first\nnew\nlast\n");
  ui.tui.toolResult(call, "edited src/tui.ts (15 → 15 chars)");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const screen = await detailText(ui);
  assert.match(screen, /实际提交的 Unified Diff/);
  assert.match(screen, /--- a\/src\/tui\.ts/);
  assert.match(screen, /\+\+\+ b\/src\/tui\.ts/);
  assert.match(screen, /@@ -1,3 \+1,3 @@/);
  assert.match(screen, /-old/);
  assert.match(screen, /\+new/);
  assert.match(screen, / last/, "Unified patch includes real context");
});

test("TUI Review Thread：write 工具展开显示真实内容，超限时明确截断", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 50, columns: 116 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查真实参数可追溯性");
  const write = { id: "review-write", type: "function", function: {
    name: "write", arguments: '{"path":"notes.txt","content":"actual saved text","options":{"mode":"new"}}',
  } };
  ui.tui.toolCall(write);
  ui.tui.toolResult(write, "wrote 17 chars to notes.txt");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  let screen = await detailText(ui);
  assert.match(screen, /原始参数（摘录）|Arguments \(excerpt\)/);
  assert.match(screen, /"content": "actual saved text"/);
  assert.match(screen, /"mode": "new"/);
  const large = { id: "review-large-write", type: "function", function: {
    name: "write", arguments: JSON.stringify({ path: "large.txt", content: "x".repeat(15_000) }),
  } };
  ui.tui.toolCall(large);
  ui.tui.toolResult(large, "wrote 15000 chars to large.txt");
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  screen = await detailText(ui);
  assert.match(screen, /arguments truncated for display|参数过长，展示已截断/,
    "防止超大输入刷屏，同时必须显式说明只是原始参数摘录");
});

test("TUI 第四层：工具参数是真实请求 JSON 摘录，不只有文件名", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 48, columns: 120 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("编辑文件");
  const call = { id: "raw-args", type: "function", function: {
    name: "edit", arguments: '{"path":"src/tui.ts","old_string":"old_value","new_string":"new_value"}',
  } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "edited src/tui.ts");
  assert.doesNotMatch(await detailText(ui), /原始参数（摘录）/);
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  const screen = await detailText(ui);
  assert.match(screen, /原始参数（摘录）：/);
  assert.match(screen, /"old_string": "old_value"/);
  assert.match(screen, /"new_string": "new_value"/);
  assert.match(screen, /edited src\/tui\.ts/);
});

test("TUI 过程概述：缺少模型阶段说明时按真实工具进展生成一条自然语言提示", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("请检查项目文件");
  const call = { id: "overview-read", type: "function", function: { name: "read", arguments: '{"path":"src/tui.ts"}' } };
  ui.tui.toolCall(call);
  let screen = await detailText(ui);
  assert.match(screen, /正在查看文件 src\/tui\.ts。/);
  assert.ok(screen.indexOf("正在查看文件 src/tui.ts") < screen.indexOf("正在读取文件"),
    "进度说明在可折叠活动前面，形成对话式时间线");
  ui.tui.toolResult(call, "real file content");
  screen = await detailText(ui);
  assert.match(screen, /已读取文件 src\/tui\.ts。/);
  assert.doesNotMatch(screen, /正在查看文件 src\/tui\.ts。/, "状态在同一条概述原地更新");
  assert.equal((screen.match(/已读取文件 src\/tui\.ts。/g) ?? []).length, 1, "不重复追加同一个阶段");

  ui.tui.confirmAssistant("文件已检查。", true);
  ui.tui.finishTurn({ requests: 2, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  screen = await detailText(ui);
  // 这一组已经结束，不再补叙述：摘要行和工具行已经说清做过什么。
  assert.doesNotMatch(screen, /已读取文件 src\/tui\.ts。/, "结束后不再重复叙述");
  assert.match(screen, /文件已检查。/, "最终答复不随过程折叠");
});

test("TUI 过程概述：优先展示模型真实阶段说明，不重复生成工具模板", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("请修复 TUI");
  ui.tui.assistantDelta("当前正在核对 TUI 的折叠逻辑，随后验证窗口缩放表现。");
  const call = { id: "narrated-read", type: "function", function: { name: "read", arguments: '{"path":"src/tui.ts"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "file contents");
  const screen = await detailText(ui);
  assert.match(screen, /当前正在核对 TUI 的折叠逻辑，随后验证窗口缩放表现。/);
  assert.doesNotMatch(screen, /正在查看文件 src\/tui\.ts。|已读取文件 src\/tui\.ts。/,
    "已有模型原文时不再添加机械化的重复说明");
  assert.match(screen, /已读取文件/, "真实工具活动仍独立可折叠");
});

test("TUI 过程概述：同组多工具只更新一个当前操作说明，缩放不额外创建日志", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 45, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("请查找项目内容");
  const read = { id: "overview-read2", type: "function", function: { name: "read", arguments: '{"path":"package.json"}' } };
  const grep = { id: "overview-grep", type: "function", function: { name: "grep", arguments: '{"pattern":"resize","path":"src"}' } };
  ui.tui.toolCall(read);
  ui.tui.toolResult(read, "package contents");
  ui.tui.toolCall(grep);
  let screen = await detailText(ui);
  assert.match(screen, /正在搜索代码 resize。/);
  assert.doesNotMatch(screen, /已读取文件 package\.json。/, "同一阶段不累计重复进度文字");
  ui.tui.toolResult(grep, "match in src/tui.ts");
  ui.output.columns = 80;
  ui.output.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 130));
  screen = await detailText(ui);
  assert.equal((screen.match(/已搜索代码 resize。/g) ?? []).length, 1);
  assert.match(screen, /已读取文件、已搜索代码/);
});

test("TUI 预执行状态：write/edit 从请求到结果才宣称已写入、已修改", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 48, columns: 116 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查写文件请求");
  for (const [name, id, status, done] of [
    ["write", "pending-write", "文件写入", "已写入文件 blocked.txt。"],
    ["edit", "pending-edit", "文件编辑", "已修改文件 blocked.txt。"],
  ]) {
    ui.tui.beginModelRequest();
    const call = { id, type: "function", function: {
      name, arguments: '{"path":"blocked.txt","content":"not applied","old_string":"old","new_string":"new"}',
    } };
    ui.tui.toolCall(call);
    const before = await detailText(ui);
    assert.match(before, new RegExp("正在处理" + status + "请求 blocked.txt。"));
    assert.match(before, /等待工具结果/);
    assert.doesNotMatch(before, new RegExp(done), "结果返回前不能说文件已经写完");
    ui.tui.toolResult(call, `wrote 5 chars to blocked.txt`);
    const after = await detailText(ui);
    assert.match(after, new RegExp(done.replace(".", "\\.")));
  }
});

test("TUI 预授权状态：取消的 edit 不能留下正在编辑或已编辑的概述", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 45, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("尝试编辑文件");
  const call = { id: "cancelled-edit-before-permission", type: "function", function: {
    name: "edit", arguments: '{"path":"notes.txt","old_string":"a","new_string":"b"}',
  } };
  ui.tui.toolCall(call);
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } },
    session, { failed: true, cancelled: true });
  ui.input.emit("keypress", "", { name: "e", ctrl: true });
  const screen = await detailText(ui);
  assert.match(screen, /执行状态未知|未收到工具结果/);
  assert.doesNotMatch(screen, /正在修改文件 notes\.txt。|已修改文件 notes\.txt。/);
});


test("TUI 过程概述：工具失败不显示为操作已成功", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 45, columns: 110 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("请运行检查");
  const shell = { id: "overview-fail", type: "function", function: { name: "shell", arguments: '{"command":"npm run check"}' } };
  ui.tui.toolCall(shell);
  ui.tui.toolResult(shell, "exit 1\nboom");
  let screen = await detailText(ui);
  assert.doesNotMatch(screen, /命令执行结束 npm run check。/);
  assert.match(screen, /失败|boom/);
  ui.tui.assistantDelta("检查失败，改为只检查文件。");
  const read = { id: "overview-fail-read", type: "function", function: { name: "read", arguments: '{"path":"missing.txt"}' } };
  ui.tui.toolCall(read);
  ui.tui.toolResult(read, "ERROR: file not found");
  screen = await detailText(ui);
  assert.match(screen, /检查失败，改为只检查文件。/);
  assert.doesNotMatch(screen, /已读取文件 missing\.txt。/, "模型已说明的新阶段也不应由工具伪造成功进度");
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
  ui.input.emit("keypress", "", { name: "e", ctrl: true });
  const rows = screenRows(ui, 40);
  const failedRows = rows.filter((line) => line.includes("TypeScript 类型检查未通过"));
  assert.equal(failedRows.length, 1);
  assert.match(failedRows[0], /npm run check 失败 · exit 1 · TypeScript 类型检查未通过/);
  assert.match(rows.join("\n"), /已完成 · 用时/, "Shell 失败并不代表 AI 任务失败");
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


test("TUI：取消时尚未返回的工具不能在历史中继续显示运行中", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 35 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查并运行命令");
  const call = { id: "pending-cancel", type: "function", function: { name: "shell", arguments: '{"command":"npm run check"}' } };
  ui.tui.toolCall(call);
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: true, cancelled: true });
  ui.input.emit("keypress", "", { name: "e", ctrl: true });
  const screen = await detailText(ui);
  assert.match(screen, /已取消 · 用时/);
  assert.match(screen, /未收到工具结果/);
  // 取消后必须显示「没有结果」，而不是任何形式的「正在跑」。
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

test("TUI 主视图：只追加，历史行不会被后续输出抹掉", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.logLine("FIRST_LINE");
  await tick();
  for (let index = 0; index < 6; index++) ui.tui.logLine(`LATER_${index}`);
  await tick();
  const text = ui.text();
  // 这就是 Claude Code 的 <Static> / Codex 的 inline viewport：打印过的行留在 Shell 历史里。
  assert.match(text, /FIRST_LINE/);
  assert.doesNotMatch(text, /\x1b\[2J/, "主视图不再整屏清空");
  assert.ok(screenRows(ui, 20).some((row) => /LATER_5/.test(row)), "最新输出在活动区可见");
});


test("TUI 主视图：一轮结束后仍保留轮次之间的空行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const stats = { requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } };
  // 第一轮带一次工具调用：结束时这一轮会折叠，展示行数变少，最容易踩到游标错位。
  ui.tui.beginTurn("first");
  const call = { id: "c1", type: "function", function: { name: "ls", arguments: '{"path":"."}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "file 13 a.txt");
  ui.tui.confirmAssistant("reply one", true);
  ui.tui.finishTurn(stats, session, { failed: false });
  await tick();
  ui.tui.beginTurn("second");
  ui.tui.confirmAssistant("reply two", true);
  ui.tui.finishTurn(stats, session, { failed: false });
  await tick();
  const rows = screenRows(ui, 20);
  const firstReply = rows.findIndex((row) => /reply one/.test(row));
  const secondTask = rows.findIndex((row) => /second/.test(row));
  assert.ok(firstReply >= 0 && secondTask > firstReply, "两轮都在屏幕上");
  // 折叠上一轮会让展示行变少：游标必须跟着退回，否则之后的行整体错位、空行被吞掉。
  assert.ok(rows.slice(firstReply + 1, secondTask).some((row) => row.trim() === ""), "两轮之间保留空行");
});

test("TUI：折叠箭头后面标出对应快捷键，不能只留一个三角", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("检查一下");
  const call = { id: "hint", type: "function", function: { name: "ls", arguments: '{"path":"."}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "file 13 a.txt");
  ui.tui.confirmAssistant("好的", true);
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  await tick();
  const screen = await detailText(ui);
  // 主视图不捕获鼠标：箭头后面必须写明按哪个键，否则用户不知道能展开。
  assert.match(screen, /Ctrl\+E/);
});

test("TUI 主视图：状态行排在回复之后，轮次之间留空行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const stats = { requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } };

  ui.tui.beginTurn("first");
  const statusTool = { id: "status-tool", type: "function", function: { name: "ls", arguments: '{"path":"."}' } };
  ui.tui.toolCall(statusTool);
  ui.tui.toolResult(statusTool, "file 1 a.txt");
  ui.tui.confirmAssistant("reply one", true);
  ui.tui.finishTurn(stats, session, { failed: false });
  await tick();

  const rows = screenRows(ui, 20);
  const replyRow = rows.findIndex((line) => /reply one/.test(line));
  const statusRow = rows.findIndex((line) => /Completed|已完成/.test(line));
  assert.ok(replyRow >= 0, "回复在屏幕上");
  assert.ok(statusRow >= 0, "状态行在屏幕上");
  // Claude Code 的 "Cooked for 12s"、Codex 的耗时都在回复之后：它是这一轮的结果。
  assert.ok(statusRow > replyRow, `状态行必须排在回复之后（回复第 ${replyRow + 1} 行，状态第 ${statusRow + 1} 行）`);

  ui.tui.beginTurn("second");
  await tick();
  const next = screenRows(ui, 20);
  const secondTask = next.findIndex((line) => /[>❯] second/.test(line));
  assert.ok(secondTask > statusRow, "新任务在状态行之后");
  assert.ok(next.slice(statusRow + 1, secondTask).some((line) => line.trim() === ""), "轮次之间留一行空白");
});

test("TUI 主视图：折叠态下用户消息、回复、状态行之间各留一行空白", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const stats = { requests: 1, toolCalls: 0, usage, tokenBudget: { exceeded: false } };
  ui.tui.beginTurn("问题");
  const statusTool = { id: "status-tool", type: "function", function: { name: "ls", arguments: '{"path":"."}' } };
  ui.tui.toolCall(statusTool);
  ui.tui.toolResult(statusTool, "file 1 a.txt");
  ui.tui.confirmAssistant("回复", true);
  ui.tui.finishTurn(stats, session, { failed: false });
  await tick();
  const rows = screenRows(ui, 20);
  const userRow = rows.findIndex((line) => /[>❯] 问题/.test(line));
  const replyRow = rows.findIndex((line) => /[✻*] 回复/.test(line));
  const statusRow = rows.findIndex((line) => /已完成|Completed/.test(line));
  assert.ok(userRow >= 0 && replyRow > userRow && statusRow > replyRow, "三行顺序正确");
  // 折叠态下空白行不能被当成「过程」隐藏，否则三行又挤在一起。
  assert.equal(rows[replyRow - 1].trim(), "", "用户消息与回复之间留一行空白");
  assert.equal(rows[statusRow - 1].trim(), "", "回复与状态行之间留一行空白");
});

test("TUI 主视图：历史轮次不能原地展开，失败行在折叠态仍然可见", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("跑检查");
  const call = { id: "f", type: "function", function: { name: "shell", arguments: '{"command":"npm run check"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "exit 1\n类型检查未通过");
  ui.tui.finishAssistant("失败了。");
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: true });
  await tick();

  // 折叠只隐藏详情层：摘要和失败原因必须一直看得见（安全信息）。
  const folded = screenRows(ui, 40).join("\n");
  assert.match(folded, /类型检查未通过/, "失败原因在折叠态可见");

  // 主视图只追加：已打印的历史不能原地展开，提示去 transcript 视图。
  ui.input.emit("keypress", "", { name: "e", ctrl: true });
  await tick();
  assert.match(ui.text(), /\x1b\[\?1049h/, "历史轮次改在 transcript 视图里展开");
});

test("TUI transcript：Ctrl+T 进入后必须真的画出历史内容", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("看看历史");
  ui.tui.logLine("TRANSCRIPT_CONTENT");
  await tick();

  ui.input.emit("keypress", "", { name: "t", ctrl: true });
  // 帧是节流渲染的，等一个周期。
  await new Promise((resolve) => setTimeout(resolve, 60));
  const text = ui.text();
  const frame = text.slice(text.lastIndexOf("\x1b[?1049h"));
  assert.match(frame, /TRANSCRIPT_CONTENT/, "transcript 不能是空白屏");

  ui.input.emit("keypress", "", { name: "escape" });
  await tick();
  assert.match(ui.text(), /\x1b\[\?1049l/, "Esc 退出并还原主屏");
});

test("TUI 主视图：运行中的状态行与流式正文之间留一行空白", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("做个游戏");
  ui.tui.assistantDelta("流式正文内容");
  await tick();

  const rows = screenRows(ui, 24);
  const textRow = rows.findIndex((line) => /流式正文内容/.test(line));
  const statusRow = rows.findIndex((line) => /准备执行|正在执行/.test(line));
  assert.ok(textRow >= 0, "流式正文在屏幕上");
  assert.ok(statusRow > textRow, "状态行排在正文之后");
  // 贴着正文会被读成同一段话的续行。
  assert.equal(rows[statusRow - 1].trim(), "", "正文与状态行之间留一行空白");
});

test("TUI 主视图：PgUp 暂停刷新，翻历史时不再抢视口，PgDn 恢复", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("跑起来");
  await tick();

  const beforePause = ui.text().length;
  ui.input.emit("keypress", "", { name: "pageup" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(ui.text().slice(beforePause), /已暂停刷新|paused/, "暂停时给出明确提示");

  // 暂停期间收到流式增量也不能往底部写，否则终端会把视口拉回底部。
  const pausedAt = ui.text().length;
  ui.tui.assistantDelta("PAUSED_DELTA");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ui.text().slice(pausedAt).includes("PAUSED_DELTA"), false, "暂停期间不重绘活动区");

  ui.input.emit("keypress", "", { name: "pagedown" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(ui.text().slice(pausedAt), /PAUSED_DELTA/, "恢复后继续输出");
});

test("TUI 主视图：括号粘贴的多行文本是一条消息，不是多次回车", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const pending = ui.tui.readLine();
  // 终端开启括号粘贴后，整段粘贴被 ESC[200~ ... ESC[201~ 包住。
  ui.input.write("\x1b[200~第一行\n第二行\n第三行\x1b[201~");
  await tick();
  // 输入框只显示一行占位提示，不把三行原文铺开。
  assert.match(inputLine(ui), /已粘贴 3 行|Pasted text \+3 lines/, "多行粘贴折叠成占位提示");
  ui.input.write("\r");

  assert.equal(await pending, "第一行\n第二行\n第三行", "粘贴内容是一条消息，换行保留");
});

test("TUI：中文与 emoji 按字节分片输入仍保留完整正文", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  for (const byte of Buffer.from("中文😀")) ui.input.write(Buffer.from([byte]));
  ui.input.write("\r");
  assert.equal(await pending, "中文😀");
});

for (const newline of ["\r", "\r\n", "\n"]) {
  test(`TUI：括号粘贴的 ${JSON.stringify(newline)} 换行在确认前不提交`, async (t) => {
    const ui = makeTui({ interactive: true, tty: true });
    t.after(() => ui.cleanup());
    ui.tui.start();
    let submitted = false;
    const pending = ui.tui.readLine().then((line) => { submitted = true; return line; });
    ui.input.write(`\x1b[200~first${newline}second\x1b[201~`);
    await tick();
    assert.equal(submitted, false);
    ui.input.write("\r");
    assert.equal(await pending, "first\nsecond");
  });
}

test("TUI：括号粘贴标记在每个位置拆包仍能提交，且同块 Enter 不丢失", async () => {
  for (let split = 1; split < 6; split++) {
    for (const boundary of ["start", "end"]) {
      const ui = makeTui({ interactive: true, tty: true });
      try {
        ui.tui.start();
        const pending = ui.tui.readLine();
        const start = "\x1b[200~";
        const end = "\x1b[201~";
        if (boundary === "start") {
          ui.input.write(start.slice(0, split));
          await tick();
          ui.input.write(`${start.slice(split)}first\nsecond${end}\r`);
        } else {
          ui.input.write(`${start}first\nsecond${end.slice(0, split)}`);
          await tick();
          ui.input.write(`${end.slice(split)}\r`);
        }
        // 有界等待只为让失败给出明确断言，而不是让整个测试文件悬挂。
        const timer = setTimeout(() => ui.tui.close(), 1000);
        try { assert.equal(await pending, "first\nsecond"); } finally { clearTimeout(timer); }
      } finally { ui.cleanup(); }
    }
  }
});

test("TUI：多行粘贴保留光标两侧文字，多次粘贴分别还原原文", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("prefix  suffix");
  for (let index = 0; index < 7; index++) ui.input.write("\x1b[D");
  ui.input.write("\x1b[200~first\nsecond\x1b[201~");
  await tick();
  ui.input.write("\x1b[200~third\nfourth\x1b[201~");
  await tick();
  ui.input.write("\r");
  assert.equal(await pending, "prefix first\nsecondthird\nfourth suffix");
});

test("TUI：关闭后恢复原始输入流 emit，不残留粘贴拦截器", () => {
  const input = new PassThrough();
  const originalEmit = input.emit;
  const ui = new Tui({ input, output: new PassThrough(), model: "mock", workspace: ".",
    controller: new AbortController(), interactive: false });
  ui.close();
  assert.equal(input.emit, originalEmit);
  input.end();
});

test("TUI：同一数据块的两条粘贴消息分别还原原文", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const first = ui.tui.readLine();
  ui.input.write("\x1b[200~first\nsecond\x1b[201~\r\x1b[200~third\nfourth\x1b[201~\r");
  assert.equal(await first, "first\nsecond");
  assert.equal(await ui.tui.readLine(), "third\nfourth");
});

test("TUI：提交后继续编辑下一条粘贴，新增提示不会覆盖已有原文", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const first = ui.tui.readLine();
  ui.input.write("\x1b[200~first\nsecond\x1b[201~\r\x1b[200~third\nfourth\x1b[201~");
  assert.equal(await first, "first\nsecond");
  const next = ui.tui.readLine();
  ui.input.write("\x1b[200~fifth\nsixth\x1b[201~\r");
  assert.equal(await next, "third\nfourthfifth\nsixth");
});

test("TUI：readline 剪切后 Ctrl+Y 仍能恢复多行粘贴原文", async (t) => {
  const scenarios = [
    { name: "Ctrl+U", cut: "\x15" },
    { name: "Ctrl+K", cut: "\x01\x0b" },
    { name: "部分 Ctrl+K", cut: `\x01${"\x06".repeat(8)}\x0b` },
  ];

  for (const scenario of scenarios) {
    const ui = makeTui({ interactive: true, tty: true, language: "en" });
    try {
      ui.tui.start();
      const pending = ui.tui.readLine();
      ui.input.write("\x1b[200~first\nsecond\x1b[201~");
      await tick();

      ui.input.write(scenario.cut);
      await tick();

      ui.input.write("\x19");
      await tick();
      ui.input.write("\r");
      assert.equal(await pending, "first\nsecond", scenario.name);
    } finally {
      ui.cleanup();
    }
  }
});

test("TUI：提交其他任务后 Ctrl+Y 仍能恢复上一条被剪切的粘贴原文", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, language: "en" });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const first = ui.tui.readLine();
  ui.input.write("\x1b[200~first\nsecond\x1b[201~");
  await tick();
  ui.input.write("\x15");
  await tick();
  ui.input.write("keep\r");
  assert.equal(await first, "keep");

  const next = ui.tui.readLine();
  ui.input.write("\x19\r");
  assert.equal(await next, "first\nsecond");
});

test("TUI：重复剪切相同内容 32 次后仍可跨任务恢复原文", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, language: "en" });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const first = ui.tui.readLine();
  ui.input.write("\x1b[200~first\nsecond\x1b[201~");
  await tick();
  ui.input.write("\x15");
  await tick();
  ui.input.write("\x19\x15".repeat(32));
  await tick();
  ui.input.write("keep\r");
  assert.equal(await first, "keep");

  const next = ui.tui.readLine();
  ui.input.write("\x19\r");
  assert.equal(await next, "first\nsecond");
});

test("TUI：已提交的剪切占位不会被后续同长度粘贴复用", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, language: "en" });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const first = ui.tui.readLine();
  ui.input.write("\x1b[200~first\nsecond\x1b[201~");
  await tick();
  ui.input.write("\x15");
  await tick();
  ui.input.write("\x19\r");
  assert.equal(await first, "first\nsecond");

  const second = ui.tui.readLine();
  ui.input.write("\x1b[200~third\nfourth\x1b[201~");
  await tick();
  ui.input.write("\x19\r");
  assert.equal(await second, "third\nfourthfirst\nsecond");
});

test("TUI：撤销与重做 2048 次后仍能恢复多行粘贴原文", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, language: "en" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();

  ui.input.write("\x1b[200~first\nsecond\x1b[201~");
  await tick();
  ui.input.write("\x7f");
  await tick();
  ui.input.write("x");
  await tick();
  ui.input.write("\x1f\x1e".repeat(2_048));
  await tick();
  ui.input.write("\x1f\x1f\r");
  assert.equal(await pending, "first\nsecond");
});

test("TUI：多行粘贴历史达到会话上限后拒绝新内容并明确提示", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, language: "zh" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();

  ui.input.write("\x1b[200~a\nb\x1b[201~".repeat(256));
  await tick();
  ui.input.write("\x1b[200~rejected\npaste\x1b[201~");
  await tick();
  assert.ok(ui.text().includes("粘贴内容未插入"), "超过会话上限必须显示明确警告");

  ui.input.write("\r");
  const submitted = await pending;
  assert.equal(submitted, "a\nb".repeat(256));
});

test("TUI：提交多行粘贴后，上键能恢复原文再次提交", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const first = ui.tui.readLine();
  ui.input.write("\x1b[200~first\nsecond\x1b[201~\r");
  assert.equal(await first, "first\nsecond");
  const next = ui.tui.readLine();
  ui.input.write("\x1b[A\r");
  assert.equal(await next, "first\nsecond");
});

test("TUI：外部编辑器往返后连续撤销仍能恢复原始粘贴", async (t) => {
  const script = path.join(tmpdir(), `agent-editor-undo-${process.pid}.mjs`);
  await writeFile(script, "process.exitCode = 0;\n");
  const previousEditor = process.env.EDITOR;
  const previousVisual = process.env.VISUAL;
  delete process.env.VISUAL;
  process.env.EDITOR = `"${process.execPath}" "${script}"`;
  t.after(() => {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    rmSync(script, { force: true });
  });

  const ui = makeTui({ interactive: true, tty: true, language: "en" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("\x1b[200~first\nsecond\x1b[201~");
  await tick();
  ui.input.emit("keypress", "", { name: "x", ctrl: true });
  ui.input.emit("keypress", "", { name: "e", ctrl: true });
  await tick();
  ui.input.write("\x1f\x1f\r");
  assert.equal(await pending, "first\nsecond");
});

test("TUI：外部编辑器接收粘贴原文，正文里的提示文字不会再次展开", async (t) => {
  const script = path.join(tmpdir(), `agent-editor-paste-${process.pid}.mjs`);
  await writeFile(script, "process.exitCode = 0;\n");
  const previousEditor = process.env.EDITOR;
  const previousVisual = process.env.VISUAL;
  delete process.env.VISUAL;
  process.env.EDITOR = `"${process.execPath}" "${script}"`;
  t.after(() => {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    rmSync(script, { force: true });
  });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("\x1b[200~[Pasted text +2 lines]\nraw\x1b[201~");
  await tick();
  ui.input.emit("keypress", "", { name: "x", ctrl: true });
  ui.input.emit("keypress", "", { name: "e", ctrl: true });
  await tick();
  ui.input.write("\r");
  assert.equal(await pending, "[Pasted text +2 lines]\nraw");
});

test("TUI 主视图：超过日志保留上限后，新行仍持续进入 Shell 滚动历史", (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  for (let index = 0; index < 2100; index++) ui.tui.logLine(`UNIQUE_LOG_${index}`);
  const history = emulateScreen(ui.text(), 100_000).join("\n");
  for (const index of [0, 1980, 2050, 2099]) {
    assert.ok(new RegExp(`UNIQUE_LOG_${index}\\b`).test(history), `历史必须保留第 ${index} 行`);
  }
});

test("TUI 主视图：日志裁剪时包含首尾空行，后续历史仍完整保留", (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  for (let index = 0; index < 1050; index++) {
    ui.tui.logLine(`BLANK_LOG_${index}`);
    ui.tui.logLine("");
  }
  const history = emulateScreen(ui.text(), 100_000).join("\n");
  for (const index of [0, 980, 1020, 1049]) {
    assert.ok(new RegExp(`BLANK_LOG_${index}\\b`).test(history), `历史必须保留第 ${index} 行`);
  }
});

test("TUI：不支持括号粘贴的终端，裸换行当换行处理，回车才提交", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const pending = ui.tui.readLine();
  // 老 conhost 不发 ESC[200~：裸换行现在是 Ctrl+J 语义（换行），不是提交。
  ui.input.write("第一行\n第二行\n第三行");
  ui.input.write("\r");

  assert.equal(await pending, "第一行\n第二行\n第三行", "整段是一条消息，换行保留");
});

test("TUI 主视图：Ctrl+J 换行，输入区变成多行，回车一次提交整段", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const pending = ui.tui.readLine();
  ui.input.write("第一行");
  ui.input.write("\n");          // Ctrl+J：换行，不提交
  ui.input.write("第二行");
  await tick();

  const rows = screenRows(ui, 30);
  assert.ok(rows.some((line) => /第一行/.test(line)), "第一行显示在输入区");
  assert.ok(rows.some((line) => /第二行/.test(line)), "第二行显示在输入区");
  assert.ok(rows.indexOf(rows.find((line) => /第二行/.test(line))) >
    rows.indexOf(rows.find((line) => /第一行/.test(line))), "第二行在第一行下面");

  ui.input.write("\r");          // 回车才提交
  assert.equal(await pending, "第一行\n第二行", "整段作为一条消息提交，换行保留");
});

test("TUI 主视图：Shift+Enter 的两种终端编码都当换行，不是提交", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();

  const pending = ui.tui.readLine();
  ui.input.write("第一行");
  ui.input.write("\x1b[13;2u");   // 支持 CSI-u 的终端
  ui.input.write("第二行");
  ui.input.write("\x1b\r");       // 老终端把 Shift+Enter 发成 ESC + CR
  ui.input.write("第三行");
  await tick();
  ui.input.write("\r");

  assert.equal(await pending, "第一行\n第二行\n第三行", "两种编码都产生换行");
});

test("TUI 主视图：输入 @ 列出工作区文件，回车补全路径但不提交", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, workspace: process.cwd() });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();

  ui.input.write("@");
  await tick();
  assert.match(ui.text(), /@\S+/, "输入 @ 后列出工作区文件");

  ui.input.write("package");
  await tick();
  assert.match(ui.text(), /@package\.json/, "按片段过滤到目标文件");
  ui.input.write("\r");
  await tick();

  // 补全进输入框，而不是把半句话发出去。
  assert.match(inputLine(ui), /@package\.json/, "回车把路径补进输入框");
  ui.input.write(" 看一下版本");
  ui.input.write("\r");
  assert.match(await pending, /@package\.json 看一下版本/, "补全后继续输入，整句才提交");
});

test("TUI 主视图：Ctrl+X Ctrl+E 用 $EDITOR 编辑当前输入", async (t) => {
  const script = path.join(tmpdir(), `agent-editor-${process.pid}.mjs`);
  // 假编辑器：把文件内容改成固定文本，模拟「用户在编辑器里写完保存」。
  await writeFile(script, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], '编辑后的内容');\n", "utf8");
  const previous = process.env.EDITOR;
  process.env.EDITOR = `"${process.execPath}" "${script}"`;
  t.after(() => {
    if (previous === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previous;
    rmSync(script, { force: true });
  });

  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("原始内容");
  await tick();

  ui.input.emit("keypress", "", { name: "x", ctrl: true });
  ui.input.emit("keypress", "", { name: "e", ctrl: true });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.match(inputLine(ui), /编辑后的内容/, "编辑器保存后内容回到输入框");
  ui.input.write("\r");
  assert.equal(await pending, "编辑后的内容");
});

test("TUI 主视图：启动时读回跨进程历史，上键能翻出上一次的任务", async (t) => {
  const file = process.env.AGENT_HISTORY_FILE;
  await writeFile(file, `${JSON.stringify({ ts: 1, cwd: "/w", text: "上一次的任务" })}\n`, "utf8");

  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.readLine();

  // 方向键要走真实转义序列：合成的 keypress 事件不带 sequence，readline 不认。
  ui.input.write("\x1b[A");
  await tick();
  assert.match(inputLine(ui), /上一次的任务/, "上键翻出上一次的输入");
});


test("TUI 主视图：长流式正文的可变区域有界，确认后完整进入历史", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 80, rows: 12 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("stream many lines");
  await tick();

  const lines = Array.from({ length: 25 }, (_, index) => `STREAM_LINE_${index + 1}`);
  const beforeDraft = ui.text().length;
  ui.tui.assistantDelta(lines.join("\n"));
  await tick();
  const draft = ui.text().slice(beforeDraft);

  assert.match(draft, /earlier streaming lines pending confirmation/);
  assert.doesNotMatch(draft, /STREAM_LINE_1(?:\r|\n)/, "未确认的旧流式行不进入滚动历史");
  const upward = [...draft.matchAll(/\x1b\[(\d+)A/g)].map((match) => Number(match[1]));
  assert.ok(upward.every((count) => count <= 12), `光标上移必须受终端高度约束：${upward.join(", ")}`);

  const beforeConfirm = ui.text().length;
  ui.tui.finishAssistant();
  await tick();
  const confirmed = ui.text().slice(beforeConfirm);
  assert.match(confirmed, /STREAM_LINE_1/, "确认后完整正文的开头进入历史");
  assert.match(confirmed, /STREAM_LINE_25/, "确认后完整正文的结尾仍可见");
});

test("TUI transcript：完成后的工具仍可用 Ctrl+G 打开真实参数与结果", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  const call = { id: "completed-detail", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "COMPLETED_RAW_RESULT");
  ui.tui.confirmAssistant("done", true);
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  ui.input.emit("keypress", "", { name: "t", ctrl: true });
  const before = ui.text().length;
  ui.input.emit("keypress", "", { name: "g", ctrl: true });
  await tick();
  assert.match(ui.text().slice(before), /Arguments \(excerpt\):/);
  assert.match(ui.text().slice(before), /COMPLETED_RAW_RESULT/);
});

test("TUI 主视图：真实 Run 的读取截断提示一直可见", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  const call = { id: "flat-truncated", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "body\n… [truncated 400 chars]\n… [stopped after 32768 bytes]");
  assert.match(screenRows(ui).join("\n"), /truncated 400 chars/);
  assert.match(screenRows(ui).join("\n"), /stopped after 32768 bytes/);
});

test("TUI 主视图：任务结束时无结果的工具明确显示状态未知", (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.toolCall({ id: "flat-unfinished", type: "function", function: { name: "shell", arguments: '{"command":"npm test"}' } });
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: true, cancelled: true });
  assert.match(screenRows(ui).join("\n"), /npm test.*no tool result received/);
});

test("TUI 输入：长行滚动后光标紧跟可见正文末尾", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, columns: 34 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.readLine();
  ui.input.write("abcdefghijklmnopqrstuvwxyz0123456789");
  await tick();
  const screen = emulateScreen(ui.text(), 24, true);
  assert.equal(screen.col, screen.lines[screen.row].length, "光标必须落在可见输入末尾，不能落到框外");
});

test("TUI 输入：多行内容中移回第一行后光标和后续重绘仍留在第一行", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 30 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("first\nsecond");
  ui.input.write("\x01");
  await tick();
  let screen = emulateScreen(ui.text(), 30, true);
  assert.match(screen.lines[screen.row], /^[>❯] first/);
  assert.equal(screen.col, 2);
  ui.tui.logLine("NEW_OUTPUT");
  await tick();
  screen = emulateScreen(ui.text(), 30, true);
  assert.match(screen.lines[screen.row], /^[>❯] first/);
  ui.input.write("X\r");
  assert.equal(await pending, "Xfirst\nsecond");
});

test("TUI 输入：暂停刷新时仍显示正在编辑的文字", async (t) => {
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.readLine();
  ui.input.emit("keypress", "", { name: "pageup" });
  ui.input.write("VISIBLE_WHILE_PAUSED");
  await tick();
  assert.match(inputLine(ui), /VISIBLE_WHILE_PAUSED/);
});

test("TUI transcript：历史阶段说明可见，折叠只影响详情视图且退出不重打主视图", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, rows: 40 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.beginTurn("inspect");
  ui.tui.confirmAssistant("HISTORICAL_STAGE_NARRATION");
  const call = { id: "completed-collapse", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } };
  ui.tui.toolCall(call);
  ui.tui.toolResult(call, "body");
  ui.tui.confirmAssistant("FINAL_REPLY", true);
  ui.tui.finishTurn({ requests: 1, toolCalls: 1, usage, tokenBudget: { exceeded: false } }, session, { failed: false });
  const main = screenRows(ui).join("\n");
  ui.input.emit("keypress", "", { name: "t", ctrl: true });
  assert.match(screenRows(ui).join("\n"), /HISTORICAL_STAGE_NARRATION/);
  ui.input.emit("keypress", "", { name: "o", ctrl: true });
  assert.doesNotMatch(screenRows(ui).join("\n"), /Received 1 line/);
  ui.input.emit("keypress", "", { name: "o", ctrl: true });
  assert.match(screenRows(ui).join("\n"), /Received 1 line/);
  const beforeExit = ui.text().length;
  ui.input.emit("keypress", "", { name: "escape" });
  assert.doesNotMatch(ui.text().slice(beforeExit), /HISTORICAL_STAGE_NARRATION/);
  // 模拟器不实现备用屏保存，直接检查退出后最新一帧的内容边界。
  assert.ok(main.includes("FINAL_REPLY"));
});

test("TUI 文件补全：上下键选择候选，Tab 保留前文并补入所选路径", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-completion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a-first.ts"), "");
  await writeFile(path.join(root, "b-second.ts"), "");
  const ui = makeTui({ interactive: true, tty: true, workspace: root });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("please @");
  await tick();
  ui.input.write("\x1b[B\t");
  await tick();
  assert.match(inputLine(ui), /please @b-second\.ts/);
  ui.input.write("\r");
  assert.equal(await pending, "please @b-second.ts");
});

test("TUI 外部编辑器：临时目录含空格时完整传递路径，不覆盖已有同名文件", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent editor space "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "editor.mjs");
  await writeFile(script, "import { writeFileSync } from 'node:fs';\nif (process.argv.length !== 3) process.exitCode = 4; else writeFileSync(process.argv[2], 'EDITED_WITH_SPACES');\n");
  const legacy = path.join(root, `agent-prompt-${process.pid}.md`);
  await writeFile(legacy, "UNRELATED_TEMP_FILE");
  const saved = Object.fromEntries(["TEMP", "TMP", "TMPDIR", "EDITOR", "VISUAL"].map((key) => [key, process.env[key]]));
  for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = root;
  delete process.env.VISUAL;
  process.env.EDITOR = `"${process.execPath}" "${script}"`;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("original");
  ui.input.emit("keypress", "", { name: "x", ctrl: true });
  ui.input.emit("keypress", "", { name: "e", ctrl: true });
  await tick();
  assert.match(inputLine(ui), /EDITED_WITH_SPACES/);
  assert.equal(readFileSync(legacy, "utf8"), "UNRELATED_TEMP_FILE");
  ui.input.write("\r");
  assert.equal(await pending, "EDITED_WITH_SPACES");
});

test("TUI 粘贴：未闭合的超大粘贴及时拒绝，结束标记后仍可输入", async (t) => {
  const ui = makeTui({ interactive: true, tty: true, language: "en" });
  t.after(() => ui.cleanup());
  ui.tui.start();
  const pending = ui.tui.readLine();
  ui.input.write("\x1b[200~first\n");
  const block = "x".repeat(1024 * 1024);
  for (let index = 0; index < 17; index++) ui.input.write(block);
  await tick();
  assert.ok(ui.text().includes("Paste not inserted"), "不用等到结束标记才检查容量");
  assert.match(ui.text(), /this paste exceeds the single-paste limit \(32 MiB\)/);
  assert.doesNotMatch(ui.text(), /Close and reopen|session reached its multiline paste history limit/,
    "单段超限不代表会话归档已满，不应要求重开界面");
  ui.input.write("\x1b[201~kept\r");
  assert.equal(await pending, "kept", "超大粘贴整体拒绝，不能截成半条消息或吞掉后续输入");
  const next = ui.tui.readLine();
  ui.input.write("\x1b[200~small\npaste\x1b[201~\r");
  assert.equal(await next, "small\npaste", "单段超限后仍能接受小段多行粘贴，无需重开界面");
});

test("TUI 文件补全：候选文件名里的方向控制字符不能直接进入终端", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-completion-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "unsafe\u202e.ts"), "");
  const ui = makeTui({ interactive: true, tty: true, workspace: root });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.readLine();
  ui.input.write("@");
  await tick();
  assert.doesNotMatch(ui.text(), /\u202e/);
  assert.match(ui.text(), /unsafe\\u202e\.ts/);
});

test("TUI 文件补全：选中的长文件名也必须限制在终端宽度内", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-completion-width-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a".repeat(100) + ".ts"), "");
  const ui = makeTui({ interactive: true, tty: true, workspace: root, columns: 34 });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.readLine();
  ui.input.write("@");
  await tick();
  const row = rowWith(ui, /@aaaa/);
  assert.ok(row.includes("@aaaa"));
  assert.ok(row.length <= 32, "高亮候选不能绕过裁剪后撑破活动区");
});

test("TUI 外部编辑器：准备文件写入失败后清理已创建的空目录并报告失败", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-editor-write-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 人为加长临时根路径，让测试在 Linux/macOS/Windows 都能覆盖「路径挤掉真正错误」的情况。
  const tempRoot = await mkdtemp(path.join(root, "deeply-nested-temporary-root-".repeat(2)));
  const saved = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) process.env[key] = tempRoot;
  const ui = makeTui({ interactive: true, tty: true });
  t.after(() => ui.cleanup());
  ui.tui.start();
  ui.tui.readLine();
  const originalWrite = fs.writeFileSync;
  try {
    // 文件系统是外部边界：在真实 mkdtemp 成功后注入磁盘写入失败，不替换 Tui 自己的方法。
    fs.writeFileSync = () => { throw new Error("injected disk full"); };
    syncBuiltinESMExports();
    ui.input.emit("keypress", "", { name: "x", ctrl: true });
    ui.input.emit("keypress", "", { name: "e", ctrl: true });
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.match(ui.text(), /could not prepare the editor buffer/);
  assert.ok(ui.text().includes("injected disk full"));
  assert.deepEqual(await readdir(tempRoot), [], "写入失败后不能遗留空的编辑器临时目录");
});


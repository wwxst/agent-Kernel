/**
 * 轻量 TUI：Claude Code 风格的聊天式终端界面。
 *
 * v0.2 的目标是「像聊天，而不是调试控制台」：顶部是项目/模型/路径，中间是用户、
 * 模型和工具调用的对话视口，底部是带分隔线的固定输入区，最下面是权限和 Session 统计。
 *
 * 渲染用绝对光标定位 + 整帧重绘：传统 Windows conhost 不实现 DECSTBM，靠滚动区域
 * 固定栏位会让回复互相覆盖；整帧重绘虽然多写几行 ANSI，但在 conhost / Windows Terminal
 * / xterm 上都能成立。不切 alternate screen、不引 TUI 库、不改 Agent。
 *
 * 非 TTY（管道、CI、e2e）退化成逐行输出：没有颜色和固定位置，但走同一套日志/审批逻辑。
 * 已知边界：固定布局要求终端至少 10 行、30 列；resize 会重新排版但不做历史重排；
 * 只保留最后一屏；宽度按近似显示宽度（CJK/emoji 按 2 列），不做完整 Unicode 宽度表。
 */
import { createInterface, emitKeypressEvents } from "node:readline";
import type { Interface, Key } from "node:readline";
import { APPROVAL_QUESTION, escapeControlCharacters, formatApproval } from "./approval.ts";
import type { AgentSessionStats, AgentStats } from "./agent.ts";
import { approvalGate, isApproved } from "./permission.ts";
import type { PermissionMode, PermissionRequest } from "./permission.ts";
import type { ToolCall } from "./types.ts";

/** 固定布局至少需要：标题/路径/分隔线 + 日志 + 分隔线/输入/页脚 + 一行缓冲。 */
const MIN_ROWS = 10;
/** 太窄时顶部标题和页脚会挤成一团，退回行式聊天更可读。 */
const MIN_COLUMNS = 30;

const TITLE_ROW = 1;
const PATH_ROW = 2;
const TOP_DIVIDER_ROW = 3;
const LOG_TOP = 4;

/** 日志最多保留多少条逻辑行；视口只显示最后 N 行，旧记录丢弃。 */
const MAX_LOG_LINES = 2_000;

/** 流式增量最多每 40ms 重绘一次，避免每个 token 都扫一整屏。 */
const RENDER_INTERVAL_MS = 40;

const PLACEHOLDER = "Ask anything, or type /help...";
const COMMAND_PROMPT = "> ";

type Tone =
  | "accent"
  | "assistant"
  | "user"
  | "muted"
  | "success"
  | "error"
  | "warning"
  | "info"
  | "plain";

interface LogLine {
  text: string;
  tone: Tone;
}

interface Glyphs {
  user: string;
  assistant: string;
  running: string;
  success: string;
  error: string;
  divider: string;
  scroll: string;
}

const UNICODE_GLYPHS: Glyphs = {
  user: "❯",
  assistant: "✻",
  running: "⋯",
  success: "✓",
  error: "✗",
  divider: "─",
  scroll: "↑",
};

/** 传统 conhost 的默认字体不一定有 ❯/✻/✓，宁可退化也不要在屏幕上显示方框。 */
const ASCII_GLYPHS: Glyphs = {
  user: ">",
  assistant: "*",
  running: "...",
  success: "+",
  error: "x",
  divider: "-",
  scroll: "^",
};

export interface TuiOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  model: string;
  workspace: string;
  permission: PermissionMode;
  /** 取消链的起点；TUI 的 Ctrl-C 和 CLI 的 SIGINT 都 abort 同一个 controller。 */
  controller: AbortController;
  /** stdin / stdout 都是 TTY 时才有审批通道和固定布局。 */
  interactive: boolean;
  columns?: number;
  rows?: number;
  /** 测试可以显式强制开关固定布局；生产代码不传。 */
  layout?: boolean;
  /** 测试可以显式关掉颜色；生产代码不传，按终端能力自动判断。 */
  color?: boolean;
}

/**
 * TUI 的显示与输入层。
 *
 * 它不认识 Agent：CLI 把 Agent 的回调接到 `assistantDelta` / `toolCall` / `toolResult`，
 * 把 `approve` 交给 Permission。TUI 只负责「怎么看、怎么问」，循环和策略仍在原处。
 */
export class Tui {
  private readonly output: NodeJS.WritableStream;

  private readonly input: NodeJS.ReadableStream;

  private readonly model: string;

  private readonly workspace: string;

  private readonly project: string;

  private readonly controller: AbortController;

  private readonly interactive: boolean;

  private readonly layout: boolean;

  private readonly style: Style;

  private readonly glyphs: Glyphs;

  private columns: number;

  private rows: number;

  private inputRow: number;

  private footerRow: number;

  private separatorRow: number;

  private logHeight: number;

  private readonly rl: Interface;

  private permissionMode: PermissionMode;

  private stats?: AgentSessionStats;

  /** 已经收尾的日志行（已转义的单行文本 + 语义色）。 */
  private readonly log: LogLine[] = [];

  /** 正在运行的工具调用行：结果到达时原地替换，而不是再追一行。 */
  private readonly pendingTools = new Map<string, LogLine>();

  /** 当前正在流式输出的模型正文；只用于显示。 */
  private streamingText = "";

  private assistantOpen = false;

  private assistantAtLineStart = true;

  private thinking = false;

  /** 历史滚动偏移：0 = 跟随最新；正数 = 向上查看旧记录。 */
  private scrollOffset = 0;

  /** 本次 readLine 的原始 prompt；滚动后重绘输入行要用。 */
  private promptText = COMMAND_PROMPT;

  /** 正在等待 readline 输入；此时不要重画输入行，以免打断用户编辑。 */
  private promptActive = false;

  /** 上一帧每行的原始内容；只写变化的行，减少流式输出时的整屏闪烁。 */
  private lastFrame: string[] = [];

  /** 输入行被 readline 写过；下一帧必须强制清掉。 */
  private inputDirty = true;

  private renderScheduled = false;

  private renderTimer?: NodeJS.Timeout;

  /** 已读到但还没被消费的输入行。审批和任务输入共用同一个队列。 */
  private readonly lines: string[] = [];

  private readonly waiting: Array<(line: string | null) => void> = [];

  private ended = false;

  private closed = false;

  private readonly onAbort: () => void;

  private readonly onKeypress: (text: string, key: Key) => void;

  private readonly onResize: () => void;

  private resizeSource?: NodeJS.EventEmitter;

  constructor(options: TuiOptions) {
    this.output = options.output;
    this.input = options.input;
    this.model = options.model;
    this.workspace = options.workspace;
    this.project = projectName(options.workspace);
    this.controller = options.controller;
    this.interactive = options.interactive;
    this.permissionMode = options.permission;

    const initialColumns = options.columns !== undefined && options.columns > 0 ? options.columns : 80;
    const initialRows = options.rows !== undefined && options.rows > 0 ? options.rows : 24;
    this.layout =
      options.layout ??
      (options.interactive &&
        isTerminalOutput(options.output) &&
        initialColumns >= MIN_COLUMNS &&
        initialRows >= MIN_ROWS);

    this.columns = Math.max(MIN_COLUMNS, initialColumns);
    this.rows = Math.max(MIN_ROWS, initialRows);
    this.inputRow = 0;
    this.footerRow = 0;
    this.separatorRow = 0;
    this.logHeight = 1;
    this.recomputeGeometry();

    const colorEnabled =
      this.layout &&
      (options.color ??
        (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"));
    this.style = new Style(colorEnabled, prefersRichColor());
    // Windows Terminal / VS Code 终端里用 ❯/✻；传统 conhost 退化成 >/*，避免方框。
    this.glyphs = process.platform !== "win32" || prefersRichColor() ? UNICODE_GLYPHS : ASCII_GLYPHS;

    this.rl = createInterface({ input: options.input, output: options.output, terminal: options.interactive });

    // 一个 line 监听器同时服务任务输入和审批：谁先 await 谁拿下一行。
    this.rl.on("line", (line) => {
      const resolve = this.waiting.shift();
      if (resolve === undefined) {
        this.lines.push(line);
        this.inputDirty = true;
      } else {
        resolve(line);
      }
    });
    this.rl.on("close", () => {
      this.ended = true;
      this.promptActive = false;
      this.inputDirty = true;
      for (const resolve of this.waiting.splice(0)) resolve(null);
    });
    // readline 在终端模式下会自己处理 Ctrl-C，进程收不到 SIGINT；这里仍然 abort 同一个 controller。
    this.rl.on("SIGINT", () => {
      this.controller.abort(new Error("received SIGINT"));
      this.rl.close();
    });

    // PageUp/PageDown 走历史滚动；readline 仍然负责输入行的编辑。
    this.onKeypress = (_text, key) => {
      if (!this.layout || this.closed) return;
      const name = key?.name?.toLowerCase();
      if (name === "pageup") this.scrollPage("up");
      else if (name === "pagedown") this.scrollPage("down");
    };
    if (options.interactive) {
      emitKeypressEvents(options.input);
      (options.input as NodeJS.EventEmitter).on("keypress", this.onKeypress);
    }

    this.onResize = () => {
      const stream = this.output as NodeJS.WriteStream;
      const columns = typeof stream.columns === "number" ? stream.columns : this.columns;
      const rows = typeof stream.rows === "number" ? stream.rows : this.rows;
      this.resize(columns, rows);
    };
    this.resizeSource = options.output as NodeJS.EventEmitter;
    if (this.layout) this.resizeSource.on("resize", this.onResize);

    this.onAbort = () => {
      this.rl.close();
    };
    this.controller.signal.addEventListener("abort", this.onAbort, { once: true });
    if (this.controller.signal.aborted) this.rl.close();
  }

  /** 画第一帧。固定布局清屏但不切 alternate screen。 */
  start(): void {
    if (this.layout) {
      this.output.write("\x1b[2J\x1b[H");
      this.renderNow();
      this.moveToInput();
      return;
    }

    if (this.interactive) {
      this.logLine(this.formatStatus());
      this.logLine(this.formatStatsLine());
      return;
    }

    this.logLine(`model: ${singleLine(this.model)}`);
    this.logLine(`workspace: ${singleLine(this.workspace)}`);
    this.logLine(`permission: ${this.permissionMode}`);
  }

  /** 终端尺寸变化后重新排版；保持当前输入行和滚动位置。 */
  private resize(columns: number, rows: number): void {
    if (!this.layout || this.closed) return;

    this.columns = Math.max(MIN_COLUMNS, columns);
    this.rows = Math.max(MIN_ROWS, rows);
    this.recomputeGeometry();
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll());

    const wasPrompt = this.promptActive;
    this.promptActive = false;
    this.inputDirty = true;
    this.lastFrame = [];
    this.output.write("\x1b[2J\x1b[H");
    this.renderNow();
    if (wasPrompt) {
      this.restorePrompt();
    }
  }

  /** 切换权限后刷新页脚；真正的放行/拒绝仍由 Permission 决定。 */
  setPermission(mode: PermissionMode): void {
    this.permissionMode = mode;
    if (this.layout) this.renderNow();
  }

  /** 更新统计；非 TTY 在每轮结束时由 finishTurn 打一行。 */
  setStats(stats: AgentSessionStats): void {
    this.stats = stats;
    if (this.layout) this.renderNow();
  }

  /**
   * 模型请求开始/结束时切换 thinking。
   *
   * 固定布局把 thinking 作为日志视口最后一行，第一段正文/工具调用到达时整帧重绘掉；
   * 行式聊天用 `\r\x1b[2K` 原地覆盖，不在记录里留下多余的一行。
   */
  setThinking(thinking: boolean): void {
    if (this.thinking === thinking) return;
    this.thinking = thinking;

    if (!this.interactive) return;
    if (this.layout) {
      this.renderNow();
      return;
    }

    if (thinking) this.writeRaw(`${this.glyphs.assistant} thinking...`);
    else this.writeRaw("\r\x1b[2K");
  }

  /**
   * 任务开始：把用户这一轮写进对话，并关掉上一段可能未收尾的模型回复。
   *
   * 固定布局清掉 readline 的输入回显，所以写一条 `❯ task`；行式聊天默认不重复。
   */
  beginTurn(task: string, { show = this.layout || !this.interactive }: { show?: boolean } = {}): void {
    if (this.layout) {
      this.thinking = false;
      this.commitAssistant();
      this.scrollOffset = 0;
      if (show) this.pushTask(task);
      this.renderNow();
      return;
    }

    this.setThinking(false);
    this.finishAssistant();
    if (!show) return;
    const lines = splitDisplayLines(task);
    lines.forEach((line, index) => {
      this.logLine(index === 0 ? `you: ${line}` : `${" ".repeat("you: ".length)}${line}`);
    });
  }

  /** 模型正文增量。固定布局只累积、限频重绘；行式聊天直接写。 */
  assistantDelta(text: string): void {
    if (text === "") return;

    if (this.layout) {
      const first = !this.assistantOpen;
      this.thinking = false;
      this.assistantOpen = true;
      this.streamingText += normalizeNewlines(text);
      if (first) this.renderNow();
      else this.scheduleRender();
      return;
    }

    this.setThinking(false);
    if (!this.assistantOpen) {
      this.writeRaw("model: ");
      this.assistantOpen = true;
      this.assistantAtLineStart = false;
    }

    const safe = escapeControlCharacters(normalizeNewlines(text));
    const parts = safe.split("\n");
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) {
        this.writeRaw(this.newline());
        this.assistantAtLineStart = true;
      }
      const part = parts[index];
      if (part === "") continue;
      if (this.assistantAtLineStart) {
        this.writeRaw("  ");
        this.assistantAtLineStart = false;
      }
      this.writeRaw(part);
    }
  }

  /**
   * 收尾一段模型回复。content 是 Agent 的最终消息：流式已经显示过时只提交缓冲，
   * 没显示过（非流式或增量被漏掉）时整段补上。
   */
  finishAssistant(content: string | null = null): void {
    if (this.layout) {
      if (!this.assistantOpen && content !== null && content.trim() !== "") {
        this.assistantOpen = true;
        this.streamingText = normalizeNewlines(content);
      }
      if (!this.assistantOpen) return;
      this.commitAssistant();
      this.renderNow();
      return;
    }

    if (!this.assistantOpen && content !== null && content.trim() !== "") {
      this.assistantDelta(content);
    }
    if (!this.assistantOpen) return;
    if (!this.assistantAtLineStart) this.writeRaw(this.newline());
    this.assistantOpen = false;
    this.assistantAtLineStart = true;
  }

  /** 工具调用开始：固定布局先写「正在运行」；结果到达时原地替换成 ✓/✗。 */
  toolCall(call: ToolCall): void {
    if (this.layout) {
      this.thinking = false;
      this.commitAssistant();
      const line = this.makeLogLine(`  ${this.glyphs.running} ${formatToolCall(call)}`, "warning");
      this.log.push(line);
      this.pendingTools.set(call.id, line);
      this.trimLog();
      this.renderNow();
      return;
    }

    this.setThinking(false);
    this.finishAssistant();
    this.logLine(`  → ${formatToolCall(call)}`);
  }

  /** 工具结果：成功、失败、权限拒绝都在这里落一行；拒绝原因直接来自 Tool result。 */
  toolResult(call: ToolCall, result: string): void {
    if (this.layout) {
      this.thinking = false;
      this.commitAssistant();
      const pending = this.pendingTools.get(call.id);
      this.pendingTools.delete(call.id);
      const raw = toolResultLine(call, result, this.glyphs);
      const line = this.makeLogLine(raw.text, raw.tone);
      const index = pending === undefined ? -1 : this.log.indexOf(pending);
      if (index >= 0) this.log[index] = line;
      else this.log.push(line);
      this.trimLog();
      this.renderNow();
      return;
    }

    this.setThinking(false);
    this.finishAssistant();
    this.logLine(`  ${formatToolResult(call, result)}`);
  }

  /** 一轮结束：更新统计；固定布局重画页脚，其余布局打一行 [stats]。 */
  finishTurn(run: AgentStats, session: AgentSessionStats, { failed }: { failed: boolean }): void {
    this.stats = session;

    if (this.layout) {
      this.thinking = false;
      this.commitAssistant();
      if (run.tokenBudget.exceeded) {
        this.pushLog(`[budget] exceeded (limit=${run.tokenBudget.limit})`, "warning");
      }
      this.renderNow();
      return;
    }

    this.setThinking(false);
    this.finishAssistant();
    const overBudget = run.tokenBudget.exceeded ? ` · budget exceeded (limit=${run.tokenBudget.limit})` : "";
    const outcome = failed ? " · task failed" : "";
    this.logLine(`[stats] ${formatStats(session)}${overBudget}${outcome}`);
  }

  /** 进程级总账：跨 Run 累计，和每轮的 [stats] 是两个口径。 */
  sessionSummary(session: AgentSessionStats): void {
    const lower = session.usage.unknown > 0 ? "at least " : "";
    const text =
      `[session] runs=${session.runs} requests=${session.requests} tool_calls=${session.toolCalls} ` +
      `tokens=${lower}${session.usage.totalTokens} (prompt=${lower}${session.usage.promptTokens} ` +
      `completion=${lower}${session.usage.completionTokens})`;
    if (this.layout) {
      this.commitAssistant();
      this.pushLog(text, "muted");
      this.renderNow();
      return;
    }
    this.logLine(text);
  }

  /**
   * 读下一行。返回 null 表示 readline 已关闭（EOF / 取消）。
   *
   * 固定布局先把当前帧画好，再把光标放到输入行；line 到达后由调用方写日志并重绘。
   */
  readLine(prompt = COMMAND_PROMPT): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);

    // 先消费已缓冲的行：管道里可能有 /exit 排着，而 readline 已经读到 EOF 并 close。
    // close 之后不能再调 prompt()（Node 会抛 "readline was closed"）。
    const queued = this.lines.shift();
    if (queued !== undefined) {
      this.inputDirty = true;
      return Promise.resolve(queued);
    }
    if (this.ended) return Promise.resolve(null);

    this.promptText = prompt;

    if (this.layout) {
      this.inputDirty = true;
      this.renderNow();
      this.promptActive = true;
      this.moveToInput();
      this.rl.setPrompt(this.inputPrompt(prompt));
      this.rl.prompt();
      this.writePlaceholder(prompt);
      return new Promise((resolve) => {
        this.waiting.push((line) => {
          this.promptActive = false;
          this.inputDirty = true;
          resolve(line);
        });
      });
    }

    if (this.interactive) {
      // 行式聊天把提示符也放到窗口最后一行，避免刚启动时停在顶部。
      this.output.write(`\x1b[${this.rows};1H\x1b[2K`);
    }
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * shell 审批：先完整展示命令和实际 cwd，再读一行 y/N。
   *
   * 审批头进入对话区，问题放在固定输入行；无 TTY、取消、EOF、已有排队输入都按拒绝处理。
   */
  async approve(request: PermissionRequest): Promise<boolean> {
    const gate = approvalGate(this.controller.signal, this.interactive, this.lines.length > 0);
    if (!gate.ask) throw new Error(`shell approval skipped: ${gate.reason}`);

    const formatted = formatApproval(request, this.workspace);
    const header = formatted.endsWith(APPROVAL_QUESTION)
      ? formatted.slice(0, -APPROVAL_QUESTION.length)
      : formatted;
    this.logLine(header.replace(/\n$/, ""), "warning");

    const answer = await this.readLine(APPROVAL_QUESTION);
    if (answer === null) {
      // EOF/readline 关闭不是「用户拒绝」；让 Permission 折成审批通道错误。
      throw new Error(
        this.controller.signal.aborted
          ? "shell approval skipped: task cancelled"
          : "shell approval skipped: approval prompt closed",
      );
    }

    const approved = isApproved(answer);
    this.logLine(`approval: ${approved ? "allowed once" : "denied"}`, approved ? "success" : "error");
    return approved;
  }

  /** 结束 TUI：清掉监听器和定时器、提交当前回复、恢复终端。 */
  close(): void {
    if (this.closed) return;
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderScheduled = false;

    if (this.layout) {
      this.thinking = false;
      this.commitAssistant();
      this.renderNow();
    } else {
      this.setThinking(false);
    }

    this.closed = true;
    this.controller.signal.removeEventListener("abort", this.onAbort);
    (this.input as NodeJS.EventEmitter).removeListener("keypress", this.onKeypress);
    this.resizeSource?.removeListener("resize", this.onResize);
    this.rl.close();

    if (this.layout) {
      // 最后一行是缓冲行；从那里换行，shell 提示符会出现在 TUI 下方。
      this.output.write(`\x1b[${this.rows};1H`);
      this.output.write("\r\n");
    }
  }

  /** 写一行运行记录。固定布局进入对话缓冲；行式聊天直接写。 */
  logLine(text: string, tone: Tone = "info"): void {
    if (this.layout) {
      this.commitAssistant();
      this.pushLog(text, tone);
      this.renderNow();
      return;
    }

    this.finishAssistant();
    for (const line of splitDisplayLines(text)) {
      const safe = escapeControlCharacters(line);
      this.writeRaw(`${safe}${this.newline()}`);
    }
  }

  /** 红色错误行；行式聊天里和普通文本一样（颜色只属于固定布局）。 */
  logError(text: string): void {
    this.logLine(text, "error");
  }

  // ---- 固定布局 ----

  /** 重画整帧：标题、路径、分隔线、对话视口、输入区、页脚。 */
  private renderNow(): void {
    if (!this.layout || this.closed || this.promptActive) return;

    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderScheduled = false;

    const width = this.contentWidth();
    const rows: string[] = new Array(this.rows).fill("");
    rows[TITLE_ROW - 1] = this.titleLine(width);
    rows[PATH_ROW - 1] = `  ${this.style.paint("muted", fitPath(singleLine(this.workspace), width))}  `;
    const divider = this.dividerLine(width);
    rows[TOP_DIVIDER_ROW - 1] = divider;

    const lines = this.wrappedDisplayLines();
    const maxOffset = Math.max(0, lines.length - this.logHeight);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
    const end = lines.length - this.scrollOffset;
    const start = Math.max(0, end - this.logHeight);
    const visible = lines.slice(start, end);
    // 对话贴底：内容少时从输入区上方开始，而不是堆在顶部留下大片空白。
    const padTop = Math.max(0, this.logHeight - visible.length);
    for (let index = 0; index < this.logHeight; index++) {
      const line = visible[index - padTop];
      rows[LOG_TOP - 1 + index] = line === undefined
        ? ""
        : `  ${this.style.paint(line.tone, clip(line.text, width))}`;
    }

    rows[this.footerRow - 1] = this.footerLine(width);
    rows[this.separatorRow - 1] = divider;
    rows[this.inputRow - 1] = "";

    if (this.lastFrame.length !== this.rows) this.lastFrame = [];
    for (let index = 0; index < rows.length; index++) {
      const forceInput = this.inputDirty && index === this.inputRow - 1;
      if (forceInput || this.lastFrame[index] !== rows[index]) {
        this.writeRow(index + 1, rows[index]);
        this.lastFrame[index] = rows[index];
      }
    }
    this.inputDirty = false;
    this.moveToInput();
  }

  private scheduleRender(): void {
    if (!this.layout || this.closed || this.promptActive || this.renderScheduled) return;
    this.renderScheduled = true;
    this.renderTimer = setTimeout(() => {
      this.renderScheduled = false;
      this.renderTimer = undefined;
      this.renderNow();
    }, RENDER_INTERVAL_MS);
    this.renderTimer.unref?.();
  }

  private scrollPage(direction: "up" | "down"): void {
    const max = this.maxScroll();
    const step = Math.max(1, this.logHeight - 2);
    this.scrollOffset = Math.min(
      max,
      Math.max(0, this.scrollOffset + (direction === "up" ? step : -step)),
    );
    this.redrawKeepingInput();
  }

  private maxScroll(): number {
    return Math.max(0, this.wrappedDisplayLines().length - this.logHeight);
  }

  /** 滚动后重画，同时保留正在编辑的输入行。 */
  private redrawKeepingInput(): void {
    if (!this.layout) return;
    const wasPrompt = this.promptActive;
    this.promptActive = false;
    this.inputDirty = true;
    this.renderNow();
    if (!wasPrompt) return;

    this.restorePrompt();
  }

  /** 滚动/ resize 后恢复输入行；`prompt(true)` 保留 readline 里的当前文本和光标。 */
  private restorePrompt(): void {
    this.promptActive = true;
    this.moveToInput();
    this.rl.setPrompt(this.inputPrompt(this.promptText));
    this.rl.prompt(true);
    this.writePlaceholder(this.promptText);
  }

  private commitAssistant(): void {
    if (!this.assistantOpen) return;
    for (const line of this.assistantDisplayLines()) {
      this.log.push({ text: line, tone: "assistant" });
    }
    this.streamingText = "";
    this.assistantOpen = false;
    this.pushBlank();
    this.trimLog();
  }

  private assistantDisplayLines(): string[] {
    const safe = escapeControlCharacters(normalizeNewlines(this.streamingText));
    const parts = safe.split("\n");
    const lines = [`${this.glyphs.assistant} ${parts[0] ?? ""}`];
    for (let index = 1; index < parts.length; index++) {
      lines.push(`  ${parts[index]}`);
    }
    return lines;
  }

  private pushTask(task: string): void {
    const lines = splitDisplayLines(task);
    lines.forEach((line, index) => {
      this.pushLog(index === 0 ? `${this.glyphs.user} ${line}` : `  ${line}`, "user");
    });
    this.pushBlank();
  }

  private pushLog(text: string, tone: Tone): void {
    for (const line of splitDisplayLines(text)) {
      this.log.push(this.makeLogLine(line, tone));
    }
    this.trimLog();
  }

  /** 所有进入固定布局日志的文本都在这里转义，避免工具/模型输出改写光标或颜色。 */
  private makeLogLine(text: string, tone: Tone): LogLine {
    return { text: escapeControlCharacters(text), tone };
  }

  private pushBlank(): void {
    if (this.log.length === 0) return;
    const last = this.log[this.log.length - 1];
    if (last.text !== "") this.log.push({ text: "", tone: "plain" });
  }

  private trimLog(): void {
    const overflow = this.log.length - MAX_LOG_LINES;
    if (overflow > 0) this.log.splice(0, overflow);
  }

  private wrappedDisplayLines(): LogLine[] {
    const logical: LogLine[] = [...this.log];
    if (this.assistantOpen) {
      for (const line of this.assistantDisplayLines()) {
        logical.push({ text: line, tone: "assistant" });
      }
    }
    if (this.thinking) logical.push({ text: `${this.glyphs.assistant} thinking...`, tone: "warning" });

    const width = this.contentWidth();
    const wrapped: LogLine[] = [];
    for (const line of logical) {
      for (const part of wrapLine(line.text, width)) {
        wrapped.push({ text: part, tone: line.tone });
      }
    }
    return wrapped;
  }

  private titleLine(width: number): string {
    const rawProject = singleLine(this.project);
    const maxProject = Math.max(1, width - 2);
    const project = clip(rawProject, maxProject);
    const modelRoom = Math.max(0, width - displayWidth(project) - 1);
    const model = modelRoom > 0 ? clip(singleLine(this.model), modelRoom) : "";
    const gap = Math.max(1, width - displayWidth(project) - displayWidth(model));
    return (
      `  ${this.style.bold(this.style.paint("accent", project))}` +
      `${" ".repeat(gap)}${this.style.paint("assistant", model)}  `
    );
  }

  private dividerLine(width: number): string {
    const line = this.glyphs.divider.repeat(Math.max(0, width));
    return `  ${this.style.paint("muted", line)}  `;
  }

  private footerLine(width: number): string {
    const permissionTone: Tone =
      this.permissionMode === "full-access"
        ? "error"
        : this.permissionMode === "read-only"
          ? "assistant"
          : "warning";
    const scrollPrefix = `${this.glyphs.scroll} ${this.scrollOffset} lines`;
    let left =
      this.scrollOffset > 0
        ? `${scrollPrefix} · ${this.permissionMode}`
        : this.permissionMode;
    let right = this.formatSessionStats(width >= 60);

    // 窄终端先压成短单位；还不够就丢掉滚动状态里的权限名，优先保留统计。
    if (displayWidth(left) + displayWidth(right) + 1 > width) {
      right = this.formatSessionStats(true);
      if (this.scrollOffset > 0) left = scrollPrefix;
    }

    const rightText = clip(right, Math.max(1, width));
    const leftText = clip(left, Math.max(1, width - displayWidth(rightText) - 1));
    const gap = Math.max(1, width - displayWidth(leftText) - displayWidth(rightText));
    return (
      `  ${this.style.paint(this.scrollOffset > 0 ? "warning" : permissionTone, leftText)}` +
      `${" ".repeat(gap)}${this.style.paint("muted", rightText)}  `
    );
  }

  private formatSessionStats(full: boolean): string {
    const stats = this.stats;
    if (stats === undefined) return full ? "0 requests · 0 tokens" : "0 req · 0 tok";
    const requests = formatNumber(stats.requests);
    const tools = formatNumber(stats.toolCalls);
    const lower = stats.usage.unknown > 0 ? "at least " : "";
    const tokens = `${lower}${formatNumber(stats.usage.totalTokens)}`;

    if (full) {
      const parts = [`${requests} ${stats.requests === 1 ? "request" : "requests"}`];
      if (stats.toolCalls > 0) {
        parts.push(`${tools} ${stats.toolCalls === 1 ? "tool call" : "tool calls"}`);
      }
      parts.push(`${tokens} tokens`);
      return parts.join(" · ");
    }

    const parts = [`${requests} req`];
    if (stats.toolCalls > 0) parts.push(`${tools} tools`);
    parts.push(`${tokens} tok`);
    return parts.join(" · ");
  }

  private inputPrompt(prompt: string): string {
    if (prompt === COMMAND_PROMPT) return `  ${this.style.paint("accent", this.glyphs.user)} `;
    return `  ${this.style.paint("warning", singleLine(prompt))}`;
  }

  private writePlaceholder(prompt: string): void {
    if (!this.layout || prompt !== COMMAND_PROMPT || this.rl.line !== "") return;
    const room = Math.max(0, this.contentWidth() - 3);
    if (room <= 3) return;
    // 前面留一个空格，让光标块落在空白处，而不是盖住 placeholder 的第一个字母。
    const text = ` ${clip(PLACEHOLDER, room)}`;
    this.output.write(this.style.paint("muted", text));
    this.output.write(`\x1b[${displayWidth(text)}D`);
  }

  private contentWidth(): number {
    return Math.max(1, this.columns - 4);
  }

  private recomputeGeometry(): void {
    // 控制台窗口最后 2~3 行容易被边框/滚动条吃掉。底部从上到下留：
    // 页脚（权限/统计）、分隔线、输入行，最后三行只作缓冲。
    this.footerRow = this.rows - 5;
    this.separatorRow = this.rows - 4;
    this.inputRow = this.rows - 3;
    this.logHeight = Math.max(1, this.footerRow - LOG_TOP);
  }

  private moveToInput(): void {
    this.output.write(`\x1b[${this.inputRow};1H`);
  }

  private writeRow(row: number, text: string): void {
    const target = Math.min(Math.max(1, row), this.rows);
    this.output.write(`\x1b[${target};1H\x1b[2K${text}`);
  }

  private formatStatus(): string {
    const prefix = `model ${clip(singleLine(this.model), 24)} | permission ${this.permissionMode} | workspace `;
    const room = this.columns - displayWidth(prefix);
    const workspace = singleLine(this.workspace);
    let shown = "";
    if (room > 0) {
      if (displayWidth(workspace) <= room) shown = workspace;
      else if (room > 3) shown = `...${tailByWidth(workspace, room - 3)}`;
    }
    return clip(prefix + shown, this.columns);
  }

  private formatStatsLine(): string {
    if (this.stats === undefined) return "requests=0  tool_calls=0  tokens=0";
    return `requests=${this.stats.requests}  tool_calls=${this.stats.toolCalls}  tokens=${formatTokens(this.stats)}`;
  }

  // ---- 行式聊天/非 TTY ----

  private newline(): string {
    return "\n";
  }

  private writeRaw(text: string): void {
    if (text !== "") this.output.write(text);
  }
}

/** 16 色或 256 色的极简样式；无颜色终端直接返回原文。 */
class Style {
  private readonly enabled: boolean;

  private readonly palette: Record<Tone, string>;

  constructor(enabled: boolean, rich: boolean) {
    this.enabled = enabled;
    this.palette = rich ? RICH_PALETTE : BASIC_PALETTE;
  }

  paint(tone: Tone, text: string): string {
    if (!this.enabled || text === "" || tone === "plain") return text;
    return `\x1b[${this.palette[tone]}m${text}\x1b[0m`;
  }

  bold(text: string): string {
    if (!this.enabled || text === "") return text;
    return `\x1b[1m${text}\x1b[22m`;
  }
}

const BASIC_PALETTE: Record<Tone, string> = {
  accent: "33",
  assistant: "36",
  user: "37",
  muted: "90",
  success: "32",
  error: "31",
  warning: "33",
  info: "37",
  plain: "0",
};

const RICH_PALETTE: Record<Tone, string> = {
  accent: "38;5;215",
  assistant: "38;5;117",
  user: "38;5;255",
  muted: "38;5;244",
  success: "38;5;114",
  error: "38;5;203",
  warning: "38;5;221",
  info: "38;5;250",
  plain: "0",
};

function prefersRichColor(): boolean {
  if (process.platform !== "win32") return true;
  if (process.env.WT_SESSION !== undefined && process.env.WT_SESSION !== "") return true;
  if (process.env.COLORTERM !== undefined && process.env.COLORTERM !== "") return true;
  const program = process.env.TERM_PROGRAM;
  return program === "vscode" || program === "WezTerm" || program === "iTerm.app";
}

/** 固定布局只在 stdout 真的是终端时启用；测试里的假输出流可以只开审批、不开布局。 */
function isTerminalOutput(output: NodeJS.WritableStream): boolean {
  return (output as { isTTY?: boolean }).isTTY === true;
}

/** Windows 路径也取最后一段，跨平台测试不依赖 path.win32。 */
function projectName(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized || "agent";
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 标题/路径这种单行字段：换行也转义，避免把固定栏位撑破。 */
function singleLine(text: string): string {
  return escapeControlCharacters(normalizeNewlines(text).replace(/\n/g, "\\n"));
}

/** 按行展示；末尾换行不额外制造一条空记录。 */
function splitDisplayLines(text: string): string[] {
  const lines = normalizeNewlines(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 硬换行到视口宽度；CJK/emoji 按 2 列算，避免中文回复在 conhost 里自动换行破帧。 */
function wrapLine(text: string, width: number): string[] {
  if (text === "") return [""];
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const char of text) {
    const charWidth = codePointWidth(char);
    if (used > 0 && used + charWidth > safeWidth) {
      lines.push(current);
      current = "";
      used = 0;
    }
    current += char;
    used += charWidth;
  }
  lines.push(current);
  return lines;
}

/** 按显示宽度裁剪；宽度不够时用 `...` 收尾。 */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width <= 3) return takeByWidth(text, width);
  return `${takeByWidth(text, width - 3)}...`;
}

function takeByWidth(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    const charWidth = codePointWidth(char);
    if (used + charWidth > width) break;
    out += char;
    used += charWidth;
  }
  return out;
}

/** 从尾部保留最多 width 列，用于顶部路径里截断很长的 workspace。 */
function tailByWidth(text: string, width: number): string {
  const chars = [...text];
  let out = "";
  let used = 0;
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    const charWidth = codePointWidth(char);
    if (used + charWidth > width) break;
    out = char + out;
    used += charWidth;
  }
  return out;
}

/** 路径太长时保留尾部（盘符/项目名比开头更有用），前面用省略号。 */
function fitPath(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 3) return takeByWidth(text, width);
  return `...${tailByWidth(text, width - 3)}`;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += codePointWidth(char);
  return width;
}

/**
 * 近似的终端显示宽度：CJK / 全角 / 常见 emoji 算 2，组合字符和零宽字符算 0。
 * 不做完整的 Unicode East Asian Width 表，这是 v0.2 的已知边界。
 */
function codePointWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function formatNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatTokens(stats: AgentSessionStats): string {
  return `${stats.usage.unknown > 0 ? "at least " : ""}${stats.usage.totalTokens}`;
}

function formatStats(stats: AgentSessionStats): string {
  const unknown =
    stats.usage.unknown > 0 ? ` · ${stats.usage.unknown} request(s) without usage` : "";
  return `requests=${stats.requests} tool_calls=${stats.toolCalls} tokens=${formatTokens(stats)}${unknown}`;
}

/**
 * 工具调用的一行摘要。`write` / `edit` 只显示路径，不把整个文件内容搬进对话；
 * `shell` 显示完整命令的转义文本（多行折成 `\n`），审批界面才是逐行完整展示的地方。
 */
function formatToolCall(call: ToolCall): string {
  const name = call.function.name;
  const detail = toolArgumentSummary(name, call.function.arguments);
  return clip(detail === "" ? name : `${name} ${detail}`, 200);
}

function toolArgumentSummary(name: string, raw: string): string {
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch {
    // 参数是模型给的文本，可能不是合法 JSON；原文照示，至少能看出它想干什么。
    return clip(normalizeNewlines(raw), 120);
  }
  if (!isRecord(args)) return "";

  switch (name) {
    case "shell":
      return typeof args.command === "string" ? oneLine(args.command) : "";
    case "read":
    case "write":
    case "edit":
    case "ls":
      return typeof args.path === "string" ? `path=${oneLine(args.path)}` : "";
    case "glob":
      return typeof args.pattern === "string" ? `pattern=${oneLine(args.pattern)}` : "";
    case "grep": {
      const pattern = typeof args.pattern === "string" ? `pattern=${oneLine(args.pattern)}` : "";
      const path = typeof args.path === "string" ? ` path=${oneLine(args.path)}` : "";
      return `${pattern}${path}`.trim();
    }
    default:
      try {
        return clip(JSON.stringify(args), 120);
      } catch {
        return "";
      }
  }
}

function oneLine(text: string): string {
  return clip(normalizeNewlines(text).replace(/\n/g, "\\n"), 120);
}

interface ToolResultSummary {
  failed: boolean;
  denied: boolean;
  body: string;
  more: string;
}

/** 把工具结果折成第一行摘要；固定布局和行式聊天共用同一套失败/拒绝判定。 */
function summarizeToolResult(result: string): ToolResultSummary {
  const lines = result
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0] ?? "(no output)";
  const failed = first.startsWith("ERROR:");
  const denied = first.startsWith("ERROR: permission denied:");
  const body = failed ? first.slice("ERROR:".length).trim() : first;
  const more = lines.length > 1 ? " …" : "";
  return { failed, denied, body, more };
}

/** 固定布局里的工具结果：保留工具名和参数，成功/失败用 ✓/✗ 和颜色区分。 */
function toolResultLine(call: ToolCall, result: string, glyphs: Glyphs): LogLine {
  const summary = summarizeToolResult(result);
  const detail = summary.body === "" ? "" : ` · ${clip(summary.body, 160)}`;
  return {
    text: `  ${summary.failed ? glyphs.error : glyphs.success} ${formatToolCall(call)}${detail}${summary.more}`,
    tone: summary.failed ? "error" : "success",
  };
}

/**
 * 行式聊天/非 TTY 的工具结果：沿用 v0.1 的标记，避免 e2e 断言和管道输出被 UI 改动影响。
 */
function formatToolResult(call: ToolCall, result: string): string {
  const summary = summarizeToolResult(result);
  const label = summary.denied ? "denied" : summary.failed ? "failed" : "ok";
  return `${summary.failed ? "✗" : "✓"} ${call.function.name} [${label}] ${clip(summary.body, 160)}${summary.more}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

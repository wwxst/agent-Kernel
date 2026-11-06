/**
 * 轻量 TUI：Claude Code 风格的聊天式终端界面。
 *
 * v0.3 的目标是「像聊天，而不是调试控制台」：顶部是项目/模型/路径，中间是用户、
 * 模型和工具调用的对话视口，底部是带分隔线的固定输入区，最下面是权限和 Session 统计。
 *
 * 渲染用绝对光标定位 + 差分重绘：传统 Windows conhost 不实现 DECSTBM，靠滚动区域
 * 固定栏位会让回复互相覆盖；只重画变化行，在 conhost / Windows Terminal
 * / xterm 上都能成立。不切 alternate screen、不引 TUI 库、不改 Agent。
 *
 * 非 TTY（管道、CI、e2e）退化成逐行输出：没有颜色和固定位置，但走同一套日志/审批逻辑。
 * 已知边界：固定布局要求终端至少 12 行、30 列；历史保留最近 2000 条逻辑行；
 * 宽度按近似显示宽度（CJK/emoji 按 2 列），不做完整 Unicode 宽度表。
 */
import { createInterface, emitKeypressEvents } from "node:readline";
import type { Interface, Key } from "node:readline";
import { Writable } from "node:stream";
import { APPROVAL_QUESTION, escapeControlCharacters, formatApproval } from "./approval.ts";
import type { AgentSessionStats, AgentStats } from "./agent.ts";
import { approvalGate, isApproved } from "./permission.ts";
import type { PermissionMode, PermissionRequest } from "./permission.ts";
import type { ToolCall } from "./types.ts";

/** 固定布局至少需要：标题/路径/分隔线 + 日志 + 输入框 + 状态行 + 缓冲。 */
const MIN_ROWS = 12;
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
  /** 工具标题与暂态等待各有局部样式，不把整行都染成状态色。 */
  kind?: "tool" | "thinking";
}

interface Glyphs {
  user: string;
  assistant: string;
  running: string;
  success: string;
  error: string;
  denied: string;
  notRun: string;
  divider: string;
  scroll: string;
  boxTopLeft: string;
  boxTopRight: string;
  boxBottomLeft: string;
  boxBottomRight: string;
  boxHorizontal: string;
  boxVertical: string;
}

const UNICODE_GLYPHS: Glyphs = {
  user: "❯",
  assistant: "✻",
  running: "●",
  success: "✓",
  error: "✗",
  denied: "⊘",
  notRun: "–",
  divider: "─",
  scroll: "↑",
  boxTopLeft: "┌",
  boxTopRight: "┐",
  boxBottomLeft: "└",
  boxBottomRight: "┘",
  boxHorizontal: "─",
  boxVertical: "│",
};

/** 传统 conhost 的默认字体不一定有 ❯/✻/✓/框线，宁可退化也不要在屏幕上显示方框。 */
const ASCII_GLYPHS: Glyphs = {
  user: ">",
  assistant: "*",
  running: "o",
  success: "+",
  error: "x",
  denied: "!",
  notRun: "-",
  divider: "-",
  scroll: "^",
  boxTopLeft: "+",
  boxTopRight: "+",
  boxBottomLeft: "+",
  boxBottomRight: "+",
  boxHorizontal: "-",
  boxVertical: "|",
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

  private layout: boolean;

  private readonly fixedLayoutAllowed: boolean;

  private readonly terminalControls: boolean;

  private readonly style: Style;

  private readonly glyphs: Glyphs;

  private columns: number;

  private rows: number;

  private inputRow: number;

  private boxTopRow: number;

  private boxBottomRow: number;

  private statusRow: number;

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

  private thinkingStartedAt = 0;

  private thinkingTimer?: NodeJS.Timeout;

  /** 历史滚动偏移：0 = 跟随最新；正数 = 向上查看旧记录。 */
  private scrollOffset = 0;

  /** 上一帧的换行后总行数；滚动时新输出只增加偏移，不把视口拉回底部。 */
  private lastTotalLines = 0;

  /** 本次 readLine 的原始 prompt；滚动后重绘输入行要用。 */
  private promptText = COMMAND_PROMPT;

  /** 当前输入是否显示 placeholder；审批时关闭，避免把 y/N 输入当成普通聊天。 */
  private promptPlaceholder = true;

  /** 正在等待输入；readline 保留编辑缓存，TUI 独立绘制，不触碰输入法状态。 */
  private promptActive = false;

  /** 横向滚动输入框，不让 readline 自动折行覆盖边框与状态栏。 */
  private inputOffset = 0;

  /** 待审批的原始请求不受日志上限裁剪，resize 时按当前宽度重新排版。 */
  private approvalRequest?: PermissionRequest;

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
    this.terminalControls = process.env.TERM !== "dumb";

    const initialColumns = options.columns !== undefined && options.columns > 0 ? options.columns : 80;
    const initialRows = options.rows !== undefined && options.rows > 0 ? options.rows : 24;
    this.fixedLayoutAllowed =
      options.layout ??
      (options.interactive && isTerminalOutput(options.output) && this.terminalControls);
    this.layout = this.fixedLayoutAllowed && initialColumns >= MIN_COLUMNS && initialRows >= MIN_ROWS;

    this.columns = initialColumns;
    this.rows = initialRows;
    this.inputRow = 0;
    this.boxTopRow = 0;
    this.boxBottomRow = 0;
    this.statusRow = 0;
    this.logHeight = 1;
    this.recomputeGeometry();

    const colorEnabled =
      this.fixedLayoutAllowed &&
      (options.color ??
        (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"));
    this.style = new Style(colorEnabled, prefersRichColor());
    // Windows Terminal / VS Code 终端里用 ❯/✻；传统 conhost 退化成 >/*，避免方框。
    this.glyphs = process.platform !== "win32" || prefersRichColor() ? UNICODE_GLYPHS : ASCII_GLYPHS;

    // readline 仍负责编辑/历史/信号，但它的清屏和自动换行不能写入固定区域。
    // 这是一层输出适配器，不改 readline 的缓存，也不接管键盘或输入法。
    const editorOutput = new Writable({
      write: (chunk, encoding, callback) => {
        if (this.layout) this.scheduleInputChrome();
        else this.output.write(chunk, encoding);
        callback();
      },
    });
    this.rl = createInterface({ input: options.input, output: editorOutput, terminal: options.interactive });

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
      // 等 readline 处理完按键后，读取新的 line/cursor 重画输入。
      this.scheduleInputChrome();
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
    if (this.fixedLayoutAllowed) this.resizeSource.on("resize", this.onResize);

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
    if (!this.fixedLayoutAllowed || this.closed) return;

    const hadLayout = this.layout;
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    this.layout = this.columns >= MIN_COLUMNS && this.rows >= MIN_ROWS;
    if (!this.layout) {
      if (hadLayout) {
        this.output.write("\n");
        if (this.approvalRequest !== undefined) {
          // 降级时仍完整展示审批，不把窄窗口当成截断命令的理由。
          this.output.write(formatApproval(this.approvalRequest, this.workspace));
        }
        if (this.promptActive) {
          this.rl.setPrompt(this.promptText);
          this.rl.prompt(true);
        }
      }
      return;
    }
    this.recomputeGeometry();
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll());

    const wasPrompt = this.promptActive;
    this.promptActive = false;
    this.inputDirty = true;
    this.lastFrame = [];
    this.lastTotalLines = 0;
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
    if (thinking) {
      this.thinking = true;
      this.thinkingStartedAt = Date.now();
      if (this.fixedLayoutAllowed) {
        // 只量测请求等待，不推断模型内部思考，也不虚构 token 数。
        this.thinkingTimer = setInterval(() => {
          if (this.layout) this.renderNow();
        }, 1000);
        this.thinkingTimer.unref?.();
      }
    } else {
      this.stopThinking();
    }

    if (!this.interactive) return;
    if (this.layout) {
      this.renderNow();
      return;
    }

    if (!this.terminalControls) return;
    if (thinking) this.writeRaw(`${this.glyphs.assistant} Thinking...`);
    else this.writeRaw("\r\x1b[2K");
  }

  private stopThinking(): void {
    this.thinking = false;
    if (this.thinkingTimer !== undefined) {
      clearInterval(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
  }

  /**
   * 任务开始：把用户这一轮写进对话，并关掉上一段可能未收尾的模型回复。
   *
   * 固定布局清掉 readline 的输入回显，所以写一条 `❯ task`；行式聊天默认不重复。
   */
  beginTurn(task: string, { show = this.fixedLayoutAllowed || !this.interactive }: { show?: boolean } = {}): void {
    if (this.layout) {
      this.stopThinking();
      this.commitAssistant();
      this.scrollOffset = 0;
      if (show) this.pushTask(task);
      this.renderNow();
      return;
    }

    this.setThinking(false);
    this.finishAssistant();
    if (this.fixedLayoutAllowed && show) this.pushTask(task);
    if (!show) return;
    const lines = splitDisplayLines(task);
    lines.forEach((line, index) => {
      const text = index === 0 ? `you: ${line}` : `${" ".repeat("you: ".length)}${line}`;
      this.writeRaw(`${escapeControlCharacters(text)}${this.newline()}`);
    });
  }

  /** 模型正文增量。固定布局只累积、限频重绘；行式聊天直接写。 */
  assistantDelta(text: string): void {
    if (text === "") return;

    if (this.layout) {
      const first = !this.assistantOpen;
      if (first) this.pushBlank();
      this.stopThinking();
      this.assistantOpen = true;
      this.streamingText += normalizeNewlines(text);
      if (first) this.renderNow();
      else this.scheduleRender();
      return;
    }

    this.setThinking(false);
    if (this.fixedLayoutAllowed) this.streamingText += normalizeNewlines(text);
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
    if (content !== null && content.trim() !== "") this.setThinking(false);
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
    if (this.fixedLayoutAllowed) this.commitAssistant();
    this.assistantOpen = false;
    this.assistantAtLineStart = true;
  }

  /** 工具调用开始：固定布局先写「正在运行」；结果到达时原地替换成 ✓/✗。 */
  toolCall(call: ToolCall): void {
    this.setThinking(false);
    this.finishAssistant();
    if (this.fixedLayoutAllowed) {
      this.pushBlank();
      const line: LogLine = {
        ...this.makeLogLine(`  ${this.glyphs.running} ${formatToolEvent(call)}`, "muted"),
        kind: "tool",
      };
      this.log.push(line);
      this.pendingTools.set(call.id, line);
      this.trimLog();
      if (this.layout) {
        this.renderNow();
        return;
      }
    }

    this.writeRaw(`  → ${escapeControlCharacters(formatToolCall(call))}${this.newline()}`);
  }

  /** 工具结果：成功、失败、权限拒绝都在这里落一行；拒绝原因直接来自 Tool result。 */
  toolResult(call: ToolCall, result: string): void {
    this.setThinking(false);
    this.finishAssistant();
    if (this.fixedLayoutAllowed) {
      const pending = this.pendingTools.get(call.id);
      this.pendingTools.delete(call.id);
      const lines = toolResultLines(call, result, this.glyphs)
        .map((line) => ({ ...line, ...this.makeLogLine(line.text, line.tone) }));
      const index = pending === undefined ? -1 : this.log.indexOf(pending);
      if (index >= 0) this.log.splice(index, 1, ...lines);
      else this.log.push(...lines);
      this.trimLog();
      if (this.layout) {
        this.renderNow();
        return;
      }
    }

    this.writeRaw(`  ${escapeControlCharacters(formatToolResult(call, result))}${this.newline()}`);
  }

  /** 一轮结束：更新统计；固定布局重画页脚，其余布局打一行 [stats]。 */
  finishTurn(run: AgentStats, session: AgentSessionStats, { failed }: { failed: boolean }): void {
    this.stats = session;

    if (this.layout) {
      this.stopThinking();
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
  readLine(
    prompt = COMMAND_PROMPT,
    { placeholder = prompt === COMMAND_PROMPT }: { placeholder?: boolean } = {},
  ): Promise<string | null> {
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
    this.promptPlaceholder = placeholder;
    this.promptActive = true;
    const answer = new Promise<string | null>((resolve) => {
      this.waiting.push((line) => {
        this.promptActive = false;
        this.inputDirty = true;
        resolve(line);
      });
    });

    if (this.layout) {
      this.inputDirty = true;
      this.renderNow();
      this.moveToInput();
      this.rl.setPrompt("");
      this.rl.prompt();
      this.renderNow();
      return answer;
    }

    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return answer;
  }

  /** v0.3 审批面板：完整 workspace 与命令放进可滚动的框，不改写、不截断。 */
  private approvalPanelLines(request: PermissionRequest): LogLine[] {
    const width = this.contentWidth();
    if (width < 12) {
      return formatApproval(request, this.workspace)
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => this.makeLogLine(line, "warning"));
    }

    const rawCommand = typeof request.args.command === "string" ? request.args.command : "";
    const command = rawCommand === "" ? "(empty command)" : rawCommand;
    const commandLines = command
      .split("\n")
      .map((line) => escapeControlCharacters(line));
    const cwd = escapeControlCharacters(this.workspace).replace(/\n/g, "\\u000a");

    const content = [
      `Workspace: ${cwd}`,
      "",
      "Command:",
      ...commandLines.map((line) => `  ${line}`),
      "",
      "Allow this command?",
      "  [Y] Allow once",
      // 中文对照：拒绝（默认）；空输入不授权。
      "  [N] Deny (default)",
    ];
    const textWidth = Math.max(1, width - 4);
    const panel: LogLine[] = [];
    const title = " Shell permission ";
    const fill = width - 3 - displayWidth(title);
    const top = fill >= 0
      ? `${this.glyphs.boxTopLeft}${this.glyphs.boxHorizontal}${title}${this.glyphs.boxHorizontal.repeat(fill)}${this.glyphs.boxTopRight}`
      : `${this.glyphs.boxTopLeft}${this.glyphs.boxHorizontal.repeat(Math.max(0, width - 2))}${this.glyphs.boxTopRight}`;
    panel.push({ text: top, tone: "warning" });

    for (const line of content) {
      for (const part of wrapLine(line, textWidth)) {
        panel.push({
          text: `${this.glyphs.boxVertical} ${padRight(part, textWidth)} ${this.glyphs.boxVertical}`,
          tone: line.startsWith("  [") || line === "Allow this command?" ? "warning" : "assistant",
        });
      }
    }

    panel.push({
      text: `${this.glyphs.boxBottomLeft}${this.glyphs.boxHorizontal.repeat(Math.max(0, width - 2))}${this.glyphs.boxBottomRight}`,
      tone: "warning",
    });
    return panel;
  }

  async approve(request: PermissionRequest): Promise<boolean> {
    const gate = approvalGate(this.controller.signal, this.interactive, this.lines.length > 0);
    if (!gate.ask) throw new Error(`shell approval skipped: ${gate.reason}`);

    this.setThinking(false);
    this.finishAssistant();
    if (this.fixedLayoutAllowed) {
      this.pushBlank();
      this.approvalRequest = request;
      this.scrollOffset = 0;
    }
    let answer: string | null;
    try {
      if (this.layout) {
        this.renderNow();
        // 中文对照：y/N，明确告诉用户空输入默认拒绝。
        answer = await this.readLine("y/N > ", { placeholder: false });
      } else {
        const formatted = formatApproval(request, this.workspace);
        const header = formatted.endsWith(APPROVAL_QUESTION)
          ? formatted.slice(0, -APPROVAL_QUESTION.length)
          : formatted;
        // 固定布局可恢复时只回显，不把整个审批再存一份进有界日志。
        this.writeRaw(`${header.replace(/\n$/, "")}${this.newline()}`);
        answer = await this.readLine(APPROVAL_QUESTION);
      }
    } finally {
      if (this.fixedLayoutAllowed) {
        // 完整审批只在等待期间展开；回答后保留决定和工具结果，避免旧面板看起来仍待授权。
        this.approvalRequest = undefined;
        this.promptText = COMMAND_PROMPT;
        this.promptPlaceholder = true;
        this.trimLog();
        this.renderNow();
      }
    }

    if (answer === null) {
      // EOF/readline 关闭不是「用户拒绝」；让 Permission 折成审批通道错误。
      throw new Error(
        this.controller.signal.aborted
          ? "shell approval skipped: task cancelled"
          : "shell approval skipped: approval prompt closed",
      );
    }

    const approved = isApproved(answer);
    if (this.layout) {
      this.logLine(
        `  ${approved ? this.glyphs.success : this.glyphs.denied} ${approved ? "Allowed once" : "Denied"}`,
        approved ? "success" : "warning",
      );
    } else {
      this.logLine(`approval: ${approved ? "allowed once" : "denied"}`, approved ? "success" : "error");
    }
    return approved;
  }

  /** 结束 TUI：清掉监听器和定时器、提交当前回复、恢复终端。 */
  close(): void {
    if (this.closed) return;
    this.setThinking(false);
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderScheduled = false;

    if (this.layout) {
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
    if (this.fixedLayoutAllowed) this.pushLog(text, tone);
    for (const line of splitDisplayLines(text)) {
      const safe = escapeControlCharacters(line);
      this.writeRaw(`${safe}${this.newline()}`);
    }
  }

  /** 红色错误行；行式聊天里和普通文本一样（颜色只属于固定布局）。 */
  logError(text: string): void {
    this.setThinking(false);
    this.logLine(text, "error");
  }

  // ---- 固定布局 ----

  /** 重画整帧：标题、路径、分隔线、对话视口、输入区、页脚。 */
  private renderNow(): void {
    if (!this.layout || this.closed) return;

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
    const total = lines.length;
    // 用户在翻历史时，新输出只增加偏移，保持当前视口内容不被拉回底部。
    if (this.scrollOffset > 0 && this.lastTotalLines > 0 && total > this.lastTotalLines) {
      this.scrollOffset += total - this.lastTotalLines;
    }
    this.lastTotalLines = total;

    const maxOffset = Math.max(0, total - this.logHeight);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
    const end = total - this.scrollOffset;
    const start = Math.max(0, end - this.logHeight);
    const visible = lines.slice(start, end);
    // v0.3：对话从视口顶部开始，内容不足一屏时空白留在下方，不再贴底。
    for (let index = 0; index < this.logHeight; index++) {
      const line = visible[index];
      rows[LOG_TOP - 1 + index] = line === undefined
        ? ""
        : `  ${this.paintLogLine(line, width)}`;
    }

    rows[this.boxTopRow - 1] = this.boxTopLine(width);
    rows[this.inputRow - 1] = this.inputLine(width);
    rows[this.boxBottomRow - 1] = this.boxBottomLine(width);
    rows[this.statusRow - 1] = this.footerLine(width);

    if (this.lastFrame.length !== this.rows) this.lastFrame = [];
    for (let index = 0; index < rows.length; index++) {
      const forceInput = this.inputDirty && index === this.inputRow - 1;
      if (forceInput || this.lastFrame[index] !== rows[index]) {
        this.writeRow(index + 1, rows[index]);
        this.lastFrame[index] = rows[index];
      }
    }
    this.inputDirty = false;
    this.restoreInputCursor();
  }

  private paintLogLine(line: LogLine, width: number): string {
    const text = clip(line.text, width);
    if (line.tone === "user") return this.style.bold(this.style.paint("user", text));
    if (line.kind === "tool") {
      // 工具标题的四字符前缀是「两格缩进 + 单列符号 + 空格」；只有符号承担状态色。
      return this.style.paint(line.tone, text.slice(0, 4)) +
        this.style.bold(this.style.paint("assistant", text.slice(4)));
    }
    if (line.kind === "thinking") {
      const end = text.indexOf(" · ");
      return this.style.paint("warning", end < 0 ? text : text.slice(0, end)) +
        (end < 0 ? "" : this.style.paint("muted", text.slice(end)));
    }
    return this.style.paint(line.tone, text);
  }

  private scheduleRender(): void {
    if (!this.layout || this.closed || this.renderScheduled) return;
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
    this.renderNow();
  }

  /** resize 后恢复固定输入行，只改变输出 prompt，不重置编辑缓存与光标。 */
  private restorePrompt(): void {
    this.promptActive = true;
    this.rl.setPrompt("");
    this.renderNow();
  }

  /**
   * 只展示光标附近的输入片段，完整文字仍在 readline 里；横向滚动不移动固定栏位。
   */
  private inputLine(width: number): string {
    const prompt = this.promptText === COMMAND_PROMPT ? `${this.glyphs.user} ` : singleLine(this.promptText);
    const room = Math.max(1, width - 4 - displayWidth(prompt));
    const cursor = this.rl.cursor;
    if (cursor < this.inputOffset) this.inputOffset = cursor;
    while (displayWidth(escapeControlCharacters(this.rl.line.slice(this.inputOffset, cursor))) >= room) {
      this.inputOffset += (this.rl.line.codePointAt(this.inputOffset) ?? 0) > 0xffff ? 2 : 1;
    }
    if (this.rl.line === "") this.inputOffset = 0;
    const placeholder = this.promptPlaceholder && this.rl.line === "" && this.promptText === COMMAND_PROMPT;
    const text = placeholder ? ` ${PLACEHOLDER}` : escapeControlCharacters(this.rl.line.slice(this.inputOffset));
    const shown = takeByWidth(text, room);
    return `  ${this.paintInputBorder(this.glyphs.boxVertical)} ${this.style.paint("accent", prompt)}` +
      this.style.paint(placeholder ? "muted" : "plain", padRight(shown, room)) +
      ` ${this.paintInputBorder(this.glyphs.boxVertical)}`;
  }

  /** 不用 ESC 7/8（conhost 上不一定可靠），按 prompt 宽度和已输入内容算回光标列。 */
  private restoreInputCursor(): void {
    const plainPrompt = this.promptText === COMMAND_PROMPT
      ? `  ${this.glyphs.boxVertical} ${this.glyphs.user} `
      : `  ${this.glyphs.boxVertical} ${singleLine(this.promptText)}`;
    const before = escapeControlCharacters(this.rl.line.slice(this.inputOffset, this.rl.cursor));
    const column = 1 + displayWidth(plainPrompt) + displayWidth(before);
    this.output.write(`\x1b[${this.inputRow};${column}H`);
  }

  private scheduleInputChrome(): void {
    if (!this.layout || !this.promptActive || this.closed) return;
    setImmediate(() => {
      if (!this.closed) this.renderNow();
    });
  }

  private commitAssistant(): void {
    if (!this.assistantOpen) return;
    this.pushBlank();
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
    if (this.thinking) {
      const seconds = Math.max(0, Math.floor((Date.now() - this.thinkingStartedAt) / 1000));
      // 中文对照：等待中，已经过 {seconds} 秒；Ctrl-C 取消。
      const detail = this.contentWidth() >= 48 ? ` · ${seconds}s · Ctrl-C to cancel` : ` · ${seconds}s`;
      logical.push({ text: `${this.glyphs.assistant} Thinking...${detail}`, tone: "warning", kind: "thinking" });
    }

    const width = this.contentWidth();
    const wrapped: LogLine[] = [];
    for (const line of logical) {
      const indent = line.text.match(/^\s*/)?.[0] ?? "";
      const continuation = line.kind === "tool" ? "    "
        : line.tone === "assistant" || line.tone === "user" ? "  " : indent;
      const parts = wrapLine(line.text, width, continuation);
      for (const [index, part] of parts.entries()) {
        wrapped.push({ text: part, tone: index > 0 && line.kind === "tool" ? "assistant" : line.tone,
          kind: index === 0 ? line.kind : undefined });
      }
    }
    if (this.approvalRequest !== undefined) {
      const panel = this.approvalPanelLines(this.approvalRequest);
      wrapped.push(...panel);
      if (panel.length > this.logHeight) {
        // 完整命令可翻阅；不用 Unicode 箭头，传统 conhost 也能读懂。
        wrapped.push({ text: "PageUp/PageDown: review full command", tone: "muted" });
      }
    }
    return wrapped;
  }

  private titleLine(width: number): string {
    const rawProject = this.project === "agent-Kernel" ? "agent-Kernel" : `agent-Kernel · ${singleLine(this.project)}`;
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

  private boxTopLine(width: number): string {
    const inner = Math.max(0, width - 2);
    const line = `${this.glyphs.boxTopLeft}${this.glyphs.boxHorizontal.repeat(inner)}${this.glyphs.boxTopRight}`;
    return `  ${this.paintInputBorder(line)}  `;
  }

  private boxBottomLine(width: number): string {
    const inner = Math.max(0, width - 2);
    const line = `${this.glyphs.boxBottomLeft}${this.glyphs.boxHorizontal.repeat(inner)}${this.glyphs.boxBottomRight}`;
    return `  ${this.paintInputBorder(line)}  `;
  }

  /** 日常输入边界退到次要层次；审批时再强调需要用户作出的决定。 */
  private paintInputBorder(text: string): string {
    return this.style.paint(this.approvalRequest === undefined ? "muted" : "warning", text);
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
      right = this.formatSessionStats(false);
      if (this.scrollOffset > 0) left = scrollPrefix;
    }
    if (displayWidth(left) + displayWidth(right) + 1 > width) {
      const requests = formatNumber(this.stats?.requests ?? 0);
      const lower = (this.stats?.usage.unknown ?? 0) > 0 ? ">=" : "";
      right = `${requests}r ${lower}${formatNumber(this.stats?.usage.totalTokens ?? 0)}tok`;
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

  private contentWidth(): number {
    return Math.max(1, this.columns - 4);
  }

  private recomputeGeometry(): void {
    // 输入框（上边框/输入行/下边框）固定在底部，权限与统计在框下方；
    // 最后三行留缓冲，避免传统 conhost 的窗口底边吃掉状态行。
    this.statusRow = this.rows - 3;
    this.boxBottomRow = this.statusRow - 1;
    this.inputRow = this.boxBottomRow - 1;
    this.boxTopRow = this.inputRow - 1;
    this.logHeight = Math.max(1, this.boxTopRow - LOG_TOP);
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
  assistant: "39",
  user: "39",
  muted: "90",
  success: "32",
  error: "31",
  warning: "33",
  info: "39",
  plain: "0",
};

const RICH_PALETTE: Record<Tone, string> = {
  accent: "38;5;215",
  assistant: "39",
  user: "39",
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
function wrapLine(text: string, width: number, continuation = ""): string[] {
  if (text === "") return [""];
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const char of text) {
    const charWidth = codePointWidth(char);
    if (used > 0 && used + charWidth > safeWidth) {
      lines.push(current);
      current = takeByWidth(continuation, Math.max(0, safeWidth - 2));
      used = displayWidth(current);
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

/** 按显示宽度补空格；框线布局里不能直接用 String.padEnd 算中文/emoji。 */
function padRight(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
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
  notRun: boolean;
  body: string;
  more: string;
}

/** 把工具结果折成第一行摘要；固定布局和行式聊天共用同一套失败/拒绝判定。 */
function summarizeToolResult(call: ToolCall, result: string): ToolResultSummary {
  const lines = result
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0] ?? "(no output)";
  const notRun = first.startsWith("ERROR: not run:");
  const denied = first.startsWith("ERROR: permission denied:");
  const error = first.startsWith("ERROR:");
  // Shell 正常返回的文本也可能是非零退出、超时或取消；只按 ERROR 前缀会画成成功。
  // 仅识别 Shell 的状态行，避免把文件正文里的「exit 7」误判成读取失败。
  const shellFailed = call.function.name === "shell" && (
    (/^exit (?:-?\d+|null)$/.test(first) && first !== "exit 0") ||
    /^timeout after \d+ms$/.test(first) ||
    first === "cancelled by signal"
  );
  const failed = error || shellFailed;
  const body = error ? first.slice("ERROR:".length).trim() : first;
  const more = lines.length > 1 ? " …" : "";
  return { failed, denied, notRun, body, more };
}

const TOOL_LABELS: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  ls: "List",
  glob: "Glob",
  grep: "Grep",
  shell: "Shell",
};

/** v0.3 的工具事件：Read README.md / Shell: npm run check，不把参数 JSON 原样刷出来。 */
function formatToolEvent(call: ToolCall): string {
  const name = call.function.name;
  const label = TOOL_LABELS[name] ?? name;
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return `${label} ${clip(normalizeNewlines(call.function.arguments), 120)}`.trim();
  }
  if (!isRecord(args)) return label;

  switch (name) {
    case "shell":
      return typeof args.command === "string" && args.command !== ""
        ? `${label}: ${oneLine(args.command)}`
        : label;
    case "read":
    case "write":
    case "edit":
    case "ls":
      return typeof args.path === "string" && args.path !== ""
        ? `${label} ${oneLine(args.path)}`
        : label;
    case "glob":
      return typeof args.pattern === "string" && args.pattern !== ""
        ? `${label} ${oneLine(args.pattern)}`
        : label;
    case "grep": {
      const pattern = typeof args.pattern === "string" ? oneLine(args.pattern) : "";
      const path = typeof args.path === "string" ? oneLine(args.path) : "";
      if (pattern === "") return label;
      return path === "" ? `${label} ${pattern}` : `${label} ${pattern} in ${path}`;
    }
    default: {
      const detail = toolArgumentSummary(name, call.function.arguments);
      return detail === "" ? label : `${label} ${detail}`;
    }
  }
}

/** 固定布局里的工具结果：失败/拒绝/未执行用不同符号，第一行原因放在下一行。 */
function toolResultLines(call: ToolCall, result: string, glyphs: Glyphs): LogLine[] {
  const summary = summarizeToolResult(call, result);
  const event = formatToolEvent(call);
  if (!summary.failed) {
    const resultLines = result === "" ? [] : splitDisplayLines(result);
    const count = resultLines.length;
    // 中文对照：收到 {count} 行；这是工具实际返回的行数，不声称是文件总行数。
    const detail = call.function.name === "read"
      ? `Received ${formatNumber(count)} ${count === 1 ? "line" : "lines"}`
      : `${clip(summary.body, 160)}${summary.more}`;
    const lines: LogLine[] = [
      { text: `  ${glyphs.success} ${event}`, tone: "success", kind: "tool" },
      { text: `    ${glyphs.boxBottomLeft} ${detail}`, tone: "muted" },
    ];
    const last = resultLines.at(-1);
    // read 的部分成功必须可见，不能只用行数摘要把读取上限藏掉。
    if (call.function.name === "read" && last?.startsWith("… [")) {
      lines.push({ text: `      ${last}`, tone: "warning" });
    }
    return lines;
  }

  const mark = summary.denied ? glyphs.denied : summary.notRun ? glyphs.notRun : glyphs.error;
  const tone: Tone = summary.notRun ? "muted" : summary.denied ? "warning" : "error";
  const lines: LogLine[] = [{ text: `  ${mark} ${event}`, tone, kind: "tool" }];
  // 失败原因不截断：每行都放在工具事件下面，长命令/长错误交给视口换行和 PageUp。
  for (const reason of result.split("\n").map((line) => line.trim()).filter((line) => line !== "")) {
    lines.push({ text: `    ${reason}`, tone });
  }
  return lines;
}

/**
 * 行式聊天/非 TTY 的工具结果：沿用 v0.1 的标记，避免 e2e 断言和管道输出被 UI 改动影响。
 */
function formatToolResult(call: ToolCall, result: string): string {
  const summary = summarizeToolResult(call, result);
  const label = summary.denied ? "denied" : summary.notRun ? "not run" : summary.failed ? "failed" : "ok";
  const mark = summary.failed ? (summary.notRun ? "–" : "✗") : "✓";
  return `${mark} ${call.function.name} [${label}] ${clip(summary.body, 160)}${summary.more}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 轻量 TUI：顶部状态栏、中间运行记录、底部固定输入区。
 *
 * 为什么是「整帧重绘」而不是滚屏：传统 Windows conhost 不支持 DECSTBM 滚动区域，
 * 靠它固定栏位会让回复行互相覆盖。这里改用绝对光标定位 + 每帧重画：
 * 第 1 行状态、第 2 行统计、中间是日志视口、倒数第二行是输入行，最后一行留空缓冲。
 * 所有写入都落在固定行上，不靠换行滚动，所以输入区不会被回复顶走。
 *
 * 这不切 alternate screen、不引 TUI 库、不改 Agent；退出后原来的 shell scrollback
 * 仍在，但 TUI 只保留最后一屏（v0.1 不做完整历史回放）。
 *
 * 非 TTY（管道、CI、e2e）退化成逐行输出：没有光标控制，但走同一套日志/审批逻辑。
 * 已知边界：固定布局要求终端至少 6 行、20 列；resize 后不会重算；宽度按 JS 字符串
 * 长度近似（CJK / emoji 可能提前换行）；长行会被硬换行而不是横向滚动。
 */
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { APPROVAL_QUESTION, escapeControlCharacters, formatApproval } from "./approval.ts";
import type { AgentSessionStats, AgentStats } from "./agent.ts";
import { approvalGate, isApproved } from "./permission.ts";
import type { PermissionMode, PermissionRequest } from "./permission.ts";
import type { ToolCall } from "./types.ts";

/** 固定布局至少需要：状态栏、统计行、两条日志/输入，再加缓冲行。 */
const MIN_ROWS = 6;
/** 太窄时逐行输出更可读，也别把状态栏裁得只剩省略号。 */
const MIN_COLUMNS = 20;

const STATUS_ROW = 1;
const STATS_ROW = 2;
const LOG_TOP = 3;

/** 日志最多保留多少条逻辑行；视口只显示最后 N 行，旧记录丢弃。 */
const MAX_LOG_LINES = 2_000;

/** 流式增量最多每 40ms 重绘一次，避免每个 token 都扫一整屏。 */
const RENDER_INTERVAL_MS = 40;

const ASSISTANT_PREFIX = "model: ";
const ASSISTANT_INDENT = "  ";
const THINKING_TEXT = "thinking...";

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
}

/**
 * TUI 的显示与输入层。
 *
 * 它不认识 Agent：CLI 把 Agent 的回调接到 `assistantDelta` / `toolCall` / `toolResult`，
 * 把 `approve` 交给 Permission。TUI 只负责「怎么看、怎么问」，循环和策略仍在原处。
 */
export class Tui {
  private readonly output: NodeJS.WritableStream;

  private readonly model: string;

  private readonly workspace: string;

  private readonly controller: AbortController;

  private readonly interactive: boolean;

  private readonly layout: boolean;

  private readonly columns: number;

  private readonly rows: number;

  /** 输入行；最后一行留空作缓冲，避免被窗口底边吃掉。 */
  private readonly inputRow: number;

  /** 日志视口能放多少行。 */
  private readonly logHeight: number;

  private readonly rl: Interface;

  private permissionMode: PermissionMode;

  private stats?: AgentSessionStats;

  /** 已经收尾的日志行（已转义、未换行）。 */
  private readonly log: string[] = [];

  /** 当前正在流式输出的模型正文；只用于显示。 */
  private streamingText = "";

  private assistantOpen = false;

  private assistantAtLineStart = true;

  private thinking = false;

  /** 正在等待 readline 输入；此时不要重画输入行，以免打断用户编辑。 */
  private promptActive = false;

  private renderScheduled = false;

  private renderTimer?: NodeJS.Timeout;

  /** 已读到但还没被消费的输入行。审批和任务输入共用同一个队列。 */
  private readonly lines: string[] = [];

  private readonly waiting: Array<(line: string | null) => void> = [];

  private ended = false;

  private closed = false;

  private readonly onAbort: () => void;

  constructor(options: TuiOptions) {
    this.output = options.output;
    this.model = options.model;
    this.workspace = options.workspace;
    this.controller = options.controller;
    this.interactive = options.interactive;
    this.permissionMode = options.permission;
    this.columns = options.columns !== undefined && options.columns > 0 ? options.columns : 80;
    this.rows = options.rows !== undefined && options.rows > 0 ? options.rows : 24;
    this.inputRow = this.rows - 1;
    this.logHeight = this.rows - 4;
    this.layout =
      options.layout ??
      (options.interactive &&
        isTerminalOutput(options.output) &&
        this.columns >= MIN_COLUMNS &&
        this.rows >= MIN_ROWS);

    this.rl = createInterface({ input: options.input, output: options.output, terminal: options.interactive });

    // 一个 line 监听器同时服务任务输入和审批：谁先 await 谁拿下一行。
    this.rl.on("line", (line) => {
      const resolve = this.waiting.shift();
      if (resolve === undefined) this.lines.push(line);
      else resolve(line);
    });
    this.rl.on("close", () => {
      this.ended = true;
      this.promptActive = false;
      for (const resolve of this.waiting.splice(0)) resolve(null);
    });
    // readline 在终端模式下会自己处理 Ctrl-C，进程收不到 SIGINT；这里仍然 abort 同一个 controller。
    this.rl.on("SIGINT", () => {
      this.controller.abort(new Error("received SIGINT"));
      this.rl.close();
    });

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
      // 行式聊天也先打一条紧凑状态头和统计行。
      this.logLine(this.formatStatus());
      this.logLine(this.formatStatsLine());
      return;
    }

    this.logLine(`model: ${singleLine(this.model)}`);
    this.logLine(`workspace: ${singleLine(this.workspace)}`);
    this.logLine(`permission: ${this.permissionMode}`);
  }

  /** 切换权限后刷新状态栏；真正的放行/拒绝仍由 Permission 决定。 */
  setPermission(mode: PermissionMode): void {
    this.permissionMode = mode;
    if (this.layout) this.renderNow();
  }

  /** 更新统计行；非 TTY 在每轮结束时由 finishTurn 打一行。 */
  setStats(stats: AgentSessionStats): void {
    this.stats = stats;
    if (this.layout) this.renderNow();
  }

  /**
   * 模型请求开始/结束时切换 thinking。
   *
   * 固定布局把 thinking 作为日志视口最后一行，第一段正文/工具调用到达时直接重绘掉；
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

    if (thinking) this.writeRaw(THINKING_TEXT);
    else this.writeRaw("\r\x1b[2K");
  }

  /**
   * 任务开始：把用户这一轮写进运行记录，并关掉上一段可能未收尾的模型回复。
   *
   * 固定布局下 readline 的输入回显会被下一帧清掉，所以始终补一条 `you:`；
   * 行式聊天里 readline 已经把输入留在历史中，默认不重复。
   */
  beginTurn(task: string, { show = this.layout || !this.interactive }: { show?: boolean } = {}): void {
    if (this.layout) {
      this.thinking = false;
      this.commitAssistant();
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
      this.writeRaw(ASSISTANT_PREFIX);
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
        this.writeRaw(ASSISTANT_INDENT);
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

  /** 工具调用开始：先写「要跑什么」，审批和长命令执行期间用户都看得见。 */
  toolCall(call: ToolCall): void {
    if (this.layout) {
      this.thinking = false;
      this.commitAssistant();
      this.pushLog(`  → ${formatToolCall(call)}`);
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
      this.pushLog(`  ${formatToolResult(call, result)}`);
      this.renderNow();
      return;
    }

    this.setThinking(false);
    this.finishAssistant();
    this.logLine(`  ${formatToolResult(call, result)}`);
  }

  /** 一轮结束：更新统计；固定布局重画第 2 行，其余布局打一行 [stats]。 */
  finishTurn(run: AgentStats, session: AgentSessionStats, { failed }: { failed: boolean }): void {
    this.stats = session;

    if (this.layout) {
      this.thinking = false;
      this.commitAssistant();
      if (run.tokenBudget.exceeded) {
        this.pushLog(`[budget] exceeded (limit=${run.tokenBudget.limit})`);
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
    this.logLine(
      `[session] runs=${session.runs} requests=${session.requests} tool_calls=${session.toolCalls} ` +
        `tokens=${lower}${session.usage.totalTokens} (prompt=${lower}${session.usage.promptTokens} ` +
        `completion=${lower}${session.usage.completionTokens})`,
    );
  }

  /**
   * 读下一行。返回 null 表示 readline 已关闭（EOF / 取消）。
   *
   * 固定布局先把当前帧画好，再把光标放到输入行；line 到达后由调用方写日志并重绘。
   * 这样输入行始终在底部，回复只在它上方变化。
   */
  readLine(prompt = "> "): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);

    // 先消费已缓冲的行：管道里可能有 /exit 排着，而 readline 已经读到 EOF 并 close。
    // close 之后不能再调 prompt()（Node 会抛 "readline was closed"）。
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(null);

    if (this.layout) {
      this.renderNow();
      this.promptActive = true;
      this.moveToInput();
      this.rl.setPrompt(prompt);
      this.rl.prompt();
      return new Promise((resolve) => {
        this.waiting.push((line) => {
          this.promptActive = false;
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
   * 审批头进入运行记录；问题本身放在固定输入行。前置门（无 TTY、已取消、
   * 已有排队输入）与 REPL 共用 `approvalGate`，拒绝原因也保持同一套文案。
   */
  async approve(request: PermissionRequest): Promise<boolean> {
    const gate = approvalGate(this.controller.signal, this.interactive, this.lines.length > 0);
    if (!gate.ask) throw new Error(`shell approval skipped: ${gate.reason}`);

    const formatted = formatApproval(request, this.workspace);
    const header = formatted.endsWith(APPROVAL_QUESTION)
      ? formatted.slice(0, -APPROVAL_QUESTION.length)
      : formatted;
    this.logLine(header.replace(/\n$/, ""));

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
    this.logLine(`approval: ${approved ? "allowed once" : "denied"}`);
    return approved;
  }

  /** 结束 TUI：清掉定时器、提交当前回复、恢复终端；可重复调用。 */
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
    this.rl.close();

    if (this.layout) {
      // 最后一行在整帧重绘里是缓冲行；从那里换行，shell 提示符会出现在 TUI 下方。
      this.output.write(`\x1b[${this.rows};1H`);
      this.output.write("\r\n");
    }
  }

  /** 写一行运行记录。固定布局进入日志缓冲；行式聊天直接写。 */
  logLine(text: string): void {
    if (this.layout) {
      this.commitAssistant();
      this.pushLog(text);
      this.renderNow();
      return;
    }

    this.finishAssistant();
    for (const line of splitDisplayLines(text)) {
      const safe = escapeControlCharacters(line);
      this.writeRaw(`${safe}${this.newline()}`);
    }
  }

  // ---- 固定布局 ----

  /** 重画整帧：状态、统计、日志视口、输入行。所有写入都是绝对行，不产生滚动。 */
  private renderNow(): void {
    if (!this.layout || this.closed || this.promptActive) return;

    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderScheduled = false;

    this.output.write(`\x1b[${STATUS_ROW};1H\x1b[2K${this.formatStatus()}`);
    this.output.write(`\x1b[${STATS_ROW};1H\x1b[2K${clip(this.formatStatsLine(), this.columns)}`);

    const lines = this.wrappedDisplayLines();
    const tail = lines.length > this.logHeight ? lines.slice(-this.logHeight) : lines;
    for (let index = 0; index < this.logHeight; index++) {
      const row = LOG_TOP + index;
      this.output.write(`\x1b[${row};1H\x1b[2K${clip(tail[index] ?? "", this.columns)}`);
    }

    // 输入行只在没有等待输入时清空；有提示符时由 readline 自己维护。
    this.output.write(`\x1b[${this.inputRow};1H\x1b[2K`);
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

  /** 把正在流式的正文收进日志；只提交一次。 */
  private commitAssistant(): void {
    if (!this.assistantOpen) return;
    for (const line of this.assistantDisplayLines()) this.log.push(line);
    this.streamingText = "";
    this.assistantOpen = false;
    this.trimLog();
  }

  private assistantDisplayLines(): string[] {
    const safe = escapeControlCharacters(normalizeNewlines(this.streamingText));
    const parts = safe.split("\n");
    const lines = [`${ASSISTANT_PREFIX}${parts[0] ?? ""}`];
    for (let index = 1; index < parts.length; index++) {
      lines.push(`${ASSISTANT_INDENT}${parts[index]}`);
    }
    return lines;
  }

  private pushTask(task: string): void {
    const lines = splitDisplayLines(task);
    lines.forEach((line, index) => {
      this.pushLog(index === 0 ? `you: ${line}` : `${" ".repeat("you: ".length)}${line}`);
    });
  }

  private pushLog(text: string): void {
    for (const line of splitDisplayLines(text)) {
      this.log.push(escapeControlCharacters(line));
    }
    this.trimLog();
  }

  private trimLog(): void {
    const overflow = this.log.length - MAX_LOG_LINES;
    if (overflow > 0) this.log.splice(0, overflow);
  }

  private wrappedDisplayLines(): string[] {
    const logical = [...this.log];
    if (this.assistantOpen) logical.push(...this.assistantDisplayLines());
    if (this.thinking) logical.push(THINKING_TEXT);

    const wrapped: string[] = [];
    for (const line of logical) wrapped.push(...wrapLine(line, this.columns));
    return wrapped;
  }

  private moveToInput(): void {
    this.output.write(`\x1b[${this.inputRow};1H`);
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

/** 固定布局只在 stdout 真的是终端时启用；测试里的假输出流可以只开审批、不开布局。 */
function isTerminalOutput(output: NodeJS.WritableStream): boolean {
  return (output as { isTTY?: boolean }).isTTY === true;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 状态栏/Workdir 这种单行字段：换行也转义，避免把固定栏位撑破。 */
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

/** 从尾部保留最多 width 列，用于状态栏里截断很长的 workspace 路径。 */
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

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += codePointWidth(char);
  return width;
}

/**
 * 近似的终端显示宽度：CJK / 全角 / 常见 emoji 算 2，组合字符和零宽字符算 0。
 * 不做完整的 Unicode East Asian Width 表，这是 v0.1 的已知边界。
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

function formatTokens(stats: AgentSessionStats): string {
  return `${stats.usage.unknown > 0 ? "at least " : ""}${stats.usage.totalTokens}`;
}

function formatStats(stats: AgentSessionStats): string {
  const unknown =
    stats.usage.unknown > 0 ? ` · ${stats.usage.unknown} request(s) without usage` : "";
  return `requests=${stats.requests} tool_calls=${stats.toolCalls} tokens=${formatTokens(stats)}${unknown}`;
}

/**
 * 工具调用的一行摘要。`write` / `edit` 只显示路径，不把整个文件内容搬进运行记录；
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

/**
 * 工具结果的一行摘要：`✓` 成功、`✗` 失败，权限拒绝明确标成 `denied`，
 * 让「没跑」「跑失败」「被拒绝」在运行记录里一眼可分。
 */
function formatToolResult(call: ToolCall, result: string): string {
  const lines = result
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0] ?? "(no output)";
  const failed = first.startsWith("ERROR:");
  const denied = first.startsWith("ERROR: permission denied:");
  const body = failed ? first.slice("ERROR:".length).trim() : first;
  const label = denied ? "denied" : failed ? "failed" : "ok";
  const more = lines.length > 1 ? " …" : "";
  return `${failed ? "✗" : "✓"} ${call.function.name} [${label}] ${clip(body, 160)}${more}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

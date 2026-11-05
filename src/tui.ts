/**
 * 轻量 TUI：顶部状态栏、中间运行记录、底部输入区。
 *
 * 为什么不是全屏应用：TUI v0.1 的目标是「让人看清 agent 在干什么」，不是做终端框架。
 * 这里只借用 ANSI 的滚动区域（DECSTBM）：第 1 行固定状态栏，最后一行固定运行统计，
 * 中间照常滚动，输入行在滚动区域底部。不切 alternate screen、不引 TUI 库、不改 Agent。
 * 退出时恢复滚动区域，shell 的 scrollback 还在。
 *
 * 非 TTY（管道、CI、e2e）退化成逐行输出：没有光标控制，但走同一套日志方法。
 * 这样 TUI 的显示逻辑不需要真终端也能测试；审批在没有 TTY 时仍按 Permission 的规则拒绝。
 *
 * 已知边界：固定布局要求终端至少 6 行、20 列；终端 resize 后不会重新计算区域；
 * 宽度按 JS 字符串长度近似，CJK / emoji 的显示宽度可能让长行提前换行。
 */
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { APPROVAL_QUESTION, escapeControlCharacters, formatApproval } from "./approval.ts";
import type { AgentSessionStats, AgentStats } from "./agent.ts";
import { approvalGate, isApproved } from "./permission.ts";
import type { PermissionMode, PermissionRequest } from "./permission.ts";
import type { ToolCall } from "./types.ts";

/** 固定布局至少需要：状态栏、统计行、一行日志/输入，再加两条缓冲。 */
const MIN_ROWS = 6;
/** 太窄时逐行输出更可读，也别把状态栏裁得只剩省略号。 */
const MIN_COLUMNS = 20;
/** 第 2 行固定显示统计；模型思考时 thinking 写在输入行上方，不占固定行。 */
const STATS_ROW = 2;
const ASSISTANT_PREFIX = "model: ";
const ASSISTANT_INDENT = "  ";

export interface TuiOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  model: string;
  workspace: string;
  permission: PermissionMode;
  /** 取消链的起点；TUI 的 Ctrl-C 和 CLI 的 SIGINT 都 abort 同一个 controller。 */
  controller: AbortController;
  /** stdin / stdout 都是 TTY 时才有审批通道；固定布局还要求终端支持滚动区域。 */
  interactive: boolean;
  columns?: number;
  rows?: number;
  /**
   * 是否启用固定栏位布局。生产代码通常不传，由 `terminalSupportsScrollRegion()` 判断；
   * 测试可以显式传 true/false，不依赖当前终端。
   */
  layout?: boolean;
}

/**
 * TUI 的显示与输入层。
 *
 * 它不认识 Agent：CLI 把 Agent 的回调接到这里的 `assistantDelta` / `toolCall` / `toolResult`，
 * 把 `approve` 交给 Permission。这样 TUI 只负责「怎么看、怎么问」，循环和策略仍在原来的位置。
 */
export class Tui {
  private readonly output: NodeJS.WritableStream;

  private readonly model: string;

  private readonly workspace: string;

  private readonly controller: AbortController;

  private readonly interactive: boolean;

  private readonly layout: boolean;

  private readonly columns: number;

  /** 真实终端的总行数；最后一行留作缓冲，防止被窗口边框/横向滚动条吃掉。 */
  private readonly rows: number;

  /** 输入行（滚动区域底边）的位置；最后一行留空，不把窗口底边当成可写行。 */
  private readonly inputRow: number;

  private readonly rl: Interface;

  private permissionMode: PermissionMode;

  private stats?: AgentSessionStats;

  /** 已读到但还没被消费的输入行。审批和任务输入共用同一个队列，谁先 await 谁拿到下一行。 */
  private readonly lines: string[] = [];

  private readonly waiting: Array<(line: string | null) => void> = [];

  private ended = false;

  private closed = false;

  private assistantOpen = false;

  private assistantAtLineStart = true;

  /** 是否有一次模型请求正在等第一个字；true 时输入行上方显示 thinking...。 */
  private thinking = false;

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
    // 输入行固定在倒数第二行；最后一行留空作缓冲，不参与滚动。
    // 有些控制台不接受「滚动区域底边 = 窗口最后一行」，那样会把顶部栏一起滚走。
    this.inputRow = this.rows - 1;
    this.layout =
      options.layout ??
      (options.interactive &&
        isTerminalOutput(options.output) &&
        terminalSupportsScrollRegion() &&
        this.columns >= MIN_COLUMNS &&
        this.rows >= MIN_ROWS);

    this.rl = createInterface({ input: options.input, output: options.output, terminal: options.interactive });

    // 一个 line 监听器同时服务任务输入和审批，顺序才明确：谁先 await 谁拿下一行。
    this.rl.on("line", (line) => {
      const resolve = this.waiting.shift();
      if (resolve === undefined) this.lines.push(line);
      else resolve(line);
    });
    this.rl.on("close", () => {
      this.ended = true;
      // close 之后不会再有 line：所有等输入的人统一拿到 null，循环自然退出。
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

  /** 画初始状态栏。固定布局会清屏，但不会切 alternate screen。 */
  start(): void {
    if (this.layout) {
      // 清掉当前视口，给固定栏位一个干净起点；scrollback 不切走。
      this.output.write("\x1b[2J\x1b[H");
      // 第 1 行状态栏、第 2 行统计固定；滚动区从第 3 行到输入行，输入行就在
      // 回复区底部。最后一行留空，避免把窗口底边当成可写行。
      this.output.write(`\x1b[3;${this.inputRow}r`);
      this.drawBars();
      this.moveToInput();
      return;
    }

    if (this.interactive) {
      // 行式聊天也先打一条紧凑状态头和统计行；它们会随历史滚走，但启动时
      // 看起来仍是一个清楚的头部。
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
    if (this.layout) this.drawBars();
  }

  /** 更新第 2 行统计。TTY 下重画固定行；非 TTY 在每轮结束时由 finishTurn 打一行。 */
  setStats(stats: AgentSessionStats): void {
    this.stats = stats;
    if (this.layout) this.drawBars();
  }

  /**
   * 模型请求开始/结束时切换 thinking 提示。
   *
   * thinking 不占固定行：它写在输入行上方，第一段正文或第一个工具调用到达时
   * 用 `\r\x1b[2K` 原地清掉，再写 `model:` / `→ tool`。这样等待期间有反馈，
   * 回复开始时又不会把一行 `thinking...` 留在记录里。
   */
  setThinking(thinking: boolean): void {
    if (this.thinking === thinking) return;
    this.thinking = thinking;
    if (!this.interactive) return;

    if (this.layout) {
      if (thinking) {
        this.moveToInput();
        this.writeRaw("\r\x1b[2Kthinking...");
      } else {
        // 光标仍在输入行；清掉 thinking 那一行，后面紧接着写正文或工具调用。
        this.writeRaw("\r\x1b[2K");
      }
      return;
    }

    // 行式聊天：输入行已经回车，thinking 写在它的下一行；第一段正文前原地清掉。
    if (thinking) this.writeRaw("thinking...");
    else this.writeRaw("\r\x1b[2K");
  }

  /**
   * 任务开始：把用户这一轮写进运行记录，并关掉上一段可能未收尾的模型回复。
   *
   * TTY 里 readline 已经回显了输入，默认不重复写 `you:`；管道没有回显，
   * 或者初始任务不是用户刚敲的，才用 `show: true` 补一条。
   */
  beginTurn(task: string, { show = true }: { show?: boolean } = {}): void {
    this.setThinking(false);
    this.finishAssistant();
    if (!show) return;
    const lines = splitDisplayLines(task);
    lines.forEach((line, index) => {
      // 续行缩进到 `you: ` 后面，避免多行任务看起来像模型输出。
      this.logLine(index === 0 ? `you: ${line}` : `${" ".repeat("you: ".length)}${line}`);
    });
  }

  /** 模型正文增量。流式时直接写，不缓冲整段回复。 */
  assistantDelta(text: string): void {
    if (text === "") return;
    this.setThinking(false);
    if (!this.assistantOpen) {
      this.writeRaw(ASSISTANT_PREFIX);
      this.assistantOpen = true;
      this.assistantAtLineStart = false;
    }

    // 先把控制字符转义，再按换行写；否则模型输出里的 ESC 能改写整个状态栏。
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
   * 收尾一段模型回复。content 是 Agent 的最终消息：流式已经显示过时只补换行，
   * 没显示过（非流式或增量被漏掉）时整段补打一遍。
   */
  finishAssistant(content: string | null = null): void {
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
    this.setThinking(false);
    this.finishAssistant();
    this.logLine(`  → ${formatToolCall(call)}`);
  }

  /** 工具结果：成功、失败、权限拒绝都在这里落一行；拒绝原因直接来自 Tool result。 */
  toolResult(call: ToolCall, result: string): void {
    this.finishAssistant();
    this.logLine(`  ${formatToolResult(call, result)}`);
  }

  /** 一轮结束：更新统计；非 TTY 打一行 [stats]，TTY 刷新第 2 行（顶穿软预算时另起一行）。 */
  finishTurn(run: AgentStats, session: AgentSessionStats, { failed }: { failed: boolean }): void {
    this.setThinking(false);
    this.finishAssistant();
    this.stats = session;
    if (this.layout) {
      this.drawBars();
      // 成功返回也可能已经顶穿软预算；固定行只放数字，超限单独留一行记录。
      if (run.tokenBudget.exceeded) {
        this.logLine(`[budget] exceeded (limit=${run.tokenBudget.limit})`);
      }
      return;
    }

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
   * 固定布局先把光标放回输入行：日志写在滚动区域底部，正常情况下光标已经在那里，
   * 这里再定位一次，避免上一段输出刚好停在中间列。
   */
  readLine(prompt = "> "): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);

    // 先消费已缓冲的行：管道里可能有 /exit 排着，而 readline 已经读到 EOF 并 close。
    // close 之后不能再调 prompt()（Node 会抛 "readline was closed"）。
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(null);

    if (this.layout) {
      this.moveToInput();
    } else if (this.interactive) {
      // 行式聊天也把输入放到窗口最后一行：否则刚启动时提示符会停在顶部，
      // 下面留一大片空白。最后一行回车会让整屏滚动，但这就是普通聊天的行为。
      this.output.write(`\x1b[${this.rows};1H\x1b[2K`);
    }
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * shell 审批：先完整展示命令和实际 cwd，再读一行 y/N。
   *
   * 审批提示的头部通过运行记录打印，问题本身作为单行输入提示 —— 不把多行提示交给
   * readline 当 prompt，避免在固定布局里算错光标位置。前置门（无 TTY、已取消、
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

  /** 恢复终端滚动区域，把光标放到最后一行下面；可重复调用。 */
  close(): void {
    if (this.closed) return;
    this.setThinking(false);
    this.closed = true;
    this.controller.signal.removeEventListener("abort", this.onAbort);
    this.rl.close();

    if (this.layout) {
      this.output.write("\x1b[r");
      this.output.write(`\x1b[${this.rows};1H`);
      this.output.write("\r\n");
    }
  }

  /** 写一行运行记录。所有动态文本都过 `escapeControlCharacters`，不让输出伪造界面。 */
  logLine(text: string): void {
    this.finishAssistant();
    for (const line of splitDisplayLines(text)) {
      const safe = escapeControlCharacters(line);
      this.writeRaw(`${safe}${this.newline()}`);
    }
  }

  private newline(): string {
    return this.layout ? "\r\n" : "\n";
  }

  private writeRaw(text: string): void {
    if (text !== "") this.output.write(text);
  }

  private moveToInput(): void {
    this.output.write(`\x1b[${this.inputRow};1H`);
  }

  private drawBars(): void {
    const status = this.formatStatus();
    const stats = clip(this.formatStatsLine(), this.columns);
    // 保存/恢复光标：状态栏和统计行重画不能把正在写入的日志位置弄丢。
    this.output.write(`\x1b7\x1b[1;1H\x1b[2K${status}`);
    this.output.write(`\x1b[${STATS_ROW};1H\x1b[2K${stats}\x1b8`);
  }

  private formatStatus(): string {
    const prefix = `model ${clip(singleLine(this.model), 24)} | permission ${this.permissionMode} | workspace `;
    const room = this.columns - prefix.length;
    const workspace = singleLine(this.workspace);
    let shown = "";
    if (room > 0) {
      if (workspace.length <= room) shown = workspace;
      else if (room > 3) shown = `...${workspace.slice(-(room - 3))}`;
    }
    return clip(prefix + shown, this.columns);
  }

  private formatStatsLine(): string {
    if (this.stats === undefined) return "requests=0  tool_calls=0  tokens=0";
    return `requests=${this.stats.requests}  tool_calls=${this.stats.toolCalls}  tokens=${formatTokens(this.stats)}`;
  }
}

/** 固定布局只在 stdout 真的是终端时启用；测试里的假输出流可以只开审批、不开布局。 */
function isTerminalOutput(output: NodeJS.WritableStream): boolean {
  return (output as { isTTY?: boolean }).isTTY === true;
}

/**
 * 传统 Windows conhost 不实现 DECSTBM 滚动区域：用它固定顶部栏会导致回复行互相覆盖。
 * Windows Terminal / VS Code 终端 / 非 Windows 的 xterm 类终端支持；不支持时走行式聊天。
 */
function terminalSupportsScrollRegion(): boolean {
  if (process.platform !== "win32") return true;
  if (process.env.WT_SESSION !== undefined && process.env.WT_SESSION !== "") return true;
  const program = process.env.TERM_PROGRAM;
  return program === "vscode" || program === "WezTerm";
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 状态栏/Workdir 这种单行字段：换行也转义，避免把固定栏位撑破。 */
function singleLine(text: string): string {
  return escapeControlCharacters(normalizeNewlines(text).replace(/\n/g, "\\n"));
}

/** 按行展示；末尾换行不额外制造一条空记录，避免每条日志后面多一个空行。 */
function splitDisplayLines(text: string): string[] {
  const lines = normalizeNewlines(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 按字符近似裁剪；CJK / emoji 的显示宽度没有补偿，这是 v0.1 的已知边界。 */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
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

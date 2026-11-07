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
import { selectMood } from "./tui-mood.ts";
import type { MoodState } from "./tui-mood.ts";
import type { PermissionMode, PermissionRequest } from "./permission.ts";
import type { ToolCall } from "./types.ts";
import { isToolResultFailure } from "./tool-result-status.ts";

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

/** 仅列出 CLI 已实现的 Slash 命令，保持现有 parseSessionCommand 语义。 */
const SLASH_COMMANDS = [
  { command: "/help", en: "Show available commands", zh: "查看可用命令" },
  { command: "/permission", en: "View or switch permission mode", zh: "查看或切换权限模式" },
  { command: "/reset", en: "Clear the current conversation", zh: "重置当前会话" },
  { command: "/exit", en: "Exit agent-Kernel", zh: "退出 agent-Kernel" },
  { command: "/quit", en: "Exit (alias of /exit)", zh: "退出（/exit 的别名）" },
] as const;

export type UiLanguage = "zh" | "en";

/** 只根据用户任务正文选界面语言；忽略代码片段、URL、路径和文件名。 */
export function detectUiLanguage(task: string, previous: UiLanguage = "en"): UiLanguage {
  const prose = task
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[A-Za-z]:[\\/][^\s]+/g, " ")
    .replace(/(?:\.{0,2}[\\/])?[^\s\\/]+(?:[\\/][^\s\\/]+)+/g, " ")
    .replace(/\b[\w.-]+\.(?:md|tsx?|jsx?|json|py|css|html|txt|mjs|cjs)\b/gi, " ");
  const han = [...prose.matchAll(/\p{Script=Han}/gu)].length;
  const englishWords = [...prose.matchAll(/[A-Za-z]{2,}/g)].length;
  if (han === 0 && englishWords === 0) return previous;
  // 英文库名/命令往往出现在中文任务中：按汉字数与英语词数比较，而非比较字节数。
  return han > 0 && han >= englishWords ? "zh" : "en";
}

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
  kind?: "tool" | "thinking" | "activity" | "turn-status" | "activity-error";
  activity?: ActivityGroup;
  turn?: TurnActivity;
}

interface ActivityTool {
  call: ToolCall;
  startedAt: number;
  endedAt?: number;
  result?: string;
}

interface ActivityGroup {
  language: UiLanguage;
  tools: ActivityTool[];
  expanded: boolean;
  finished?: boolean;
}

interface TurnActivity {
  language: UiLanguage;
  startedAt: number;
  endedAt?: number;
  outcome: "preparing" | "running" | "completed" | "failed" | "cancelled";
  groups: ActivityGroup[];
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
  /** Claude Code 风格：短对话时输入框跟随消息，长对话时自动停靠底部。 */
  flowInput?: boolean;
  /** TUI 只发出权限切换意图；CLI 负责更新真实 Permission 和模型提示。 */
  onPermissionChange?: (mode: PermissionMode) => void;
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

  private readonly flowInput: boolean;

  private readonly onPermissionChange?: (mode: PermissionMode) => void;

  /** Shift+Tab 进入 full-access 前需要再按一次确认，误按不会提升权限。 */
  private fullAccessConfirmationPending = false;

  private readonly terminalControls: boolean;

  private readonly style: Style;

  private readonly glyphs: Glyphs;

  /** 最近一次用户任务的主要语言；命令和模型输出不触发语言切换。 */
  private uiLanguage: UiLanguage = "en";

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

  /** 每次真实 AI 阶段说明后的工具形成一个独立组；不编造模型说明。 */
  private readonly activityPending = new Map<string, ActivityTool>();

  private currentTurn?: TurnActivity;

  private activeActivity?: ActivityGroup;

  /** Ctrl+O 的当前浏览位置；各组展开状态彼此独立。 */
  private activityFocus = -1;

  private activityState?: MoodState;

  private moodText = "";

  private moodChangedAt = 0;

  private readonly recentMoods: string[] = [];

  private activityTimer?: NodeJS.Timeout;

  /** 当前正在流式输出的模型正文；只用于显示。 */
  private streamingText = "";

  private assistantOpen = false;

  private assistantAtLineStart = true;

  private thinking = false;

  private thinkingStartedAt = 0;

  private thinkingTimer?: NodeJS.Timeout;

  /** 只量测 UI 中本次 Run 的经过时间，不参与 Kernel 的预算或统计。 */
  private runStartedAt?: number;

  private runToolResults = 0;

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

  /** Slash 菜单只在编辑命令前缀时显示；Esc 关闭后直到文本改变前保持关闭。 */
  private slashDismissed = false;

  private slashSelected = 0;

  private slashDraft = "";

  private slashDraftCursor = 0;

  private cursorStyleChanged = false;

  /** 待审批的原始请求不受日志上限裁剪，resize 时按当前宽度重新排版。 */
  private approvalRequest?: PermissionRequest;

  /** 菜单默认拒绝：空回车不会授权；只影响 TUI，不改 Permission 策略。 */
  private approvalChoice: "allow" | "deny" = "deny";

  /** 仅固定布局启用键盘菜单；普通 REPL/行式审批继续使用 y/N。 */
  private approvalMenuActive = false;

  /** 专用菜单按键结果；与 readline 的任务输入队列完全隔离。 */
  private approvalMenuResolve?: (decision: boolean | null) => void;

  /** 仅审批时隐藏终端原生光标，退出与取消必须恢复。 */
  private approvalCursorHidden = false;

  /** 审批开始后，只有允许执行或收到工具结果，才解除 Running 子行的显示抑制。 */
  private approvalBlocksRunning = false;

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
    this.flowInput = options.flowInput ?? false;
    this.onPermissionChange = options.onPermissionChange;
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
      // 审批不消费文本行；粘贴、数字或旧任务不能成为隐形的授权答案，
      // 也不能在审批结束后进入下一轮任务队列。
      if (this.approvalMenuActive) return;
      // Enter 提交当前高亮命令，避免把不完整的 /per 发给模型。
      const candidates = this.slashMenuCandidates(line);
      const submitted = this.layout && this.promptActive && !this.slashDismissed && candidates.length > 0
        ? candidates[Math.min(this.slashSelected, candidates.length - 1)]!.command
        : line;
      this.slashDismissed = false;
      this.slashSelected = 0;
      this.slashDraft = "";
      this.slashDraftCursor = 0;
      const resolve = this.waiting.shift();
      if (resolve === undefined) {
        this.lines.push(submitted);
        this.inputDirty = true;
      } else {
        resolve(submitted);
      }
    });
    this.rl.on("close", () => {
      this.ended = true;
      this.promptActive = false;
      this.inputDirty = true;
      this.approvalMenuResolve?.(null);
      for (const resolve of this.waiting.splice(0)) resolve(null);
    });
    // readline 在终端模式下会自己处理 Ctrl-C，进程收不到 SIGINT；这里仍然 abort 同一个 controller。
    this.rl.on("SIGINT", () => {
      this.controller.abort(new Error("received SIGINT"));
      this.rl.close();
    });

    // 固定审批直接处理方向键/Enter/Esc，不再创建一条看不见的 readline 输入行。
    // readline 仍负责原有的任务编辑，但审批期间产生的 line 事件被隔离。
    this.onKeypress = (_text, key) => {
      if (this.closed) return;
      const name = key?.name?.toLowerCase();

      if (this.approvalMenuActive) {
        if (name === "up" || name === "down") {
          this.approvalChoice = name === "up" ? "allow" : "deny";
          if (this.rl.line !== "") this.rl.write(null, { ctrl: true, name: "u" });
          if (this.layout) this.renderNow();
          else this.writeRaw(`\n> ${this.approvalChoice === "allow" ? this.uiText("1. Yes, allow once", "1. 是，仅允许本次") : this.uiText("2. No (default)", "2. 否（默认）")}\n`);
          return;
        }
        if (name === "return" || name === "enter") {
          this.approvalMenuResolve?.(this.approvalChoice === "allow");
          return;
        }
        if (name === "escape") {
          this.approvalMenuResolve?.(false);
          return;
        }
        if (name === "pageup" || name === "pagedown") {
          if (this.layout) this.scrollPage(name === "pageup" ? "up" : "down");
          return;
        }
        // 审批只接受菜单按键；误输入的任意文本不改变决定、不写入下一个任务。
        if (this.rl.line !== "") this.rl.write(null, { ctrl: true, name: "u" });
        return;
      }

      // Ctrl+O 依次切换最近、上一段等组的展开状态；已有展开项不会被强制收起。
      // 从已保留的日志锚点收集组，因而上一轮任务的活动也能查看。
      if (key?.ctrl && name === "o" && this.layout && this.currentTurn !== undefined) {
        const groups = this.log.flatMap((line) =>
          line.kind === "activity" && line.activity !== undefined ? [line.activity] : []);
        if (groups.length > 0) {
          this.activityFocus = this.activityFocus <= 0 ? groups.length - 1 : this.activityFocus - 1;
          const group = groups[this.activityFocus]!;
          group.expanded = !group.expanded;
          this.scrollOffset = 0;
          this.renderNow();
        }
        return;
      }

      // 只在等待下一条任务时启用，执行中/审批中不可提权。
      // Windows Terminal / xterm 的 Shift+Tab 通常发送 CSI Z。
      const shiftTab = name === "tab" && key?.shift === true || key?.sequence === "\x1b[Z";
      if (shiftTab && this.promptActive && this.onPermissionChange !== undefined) {
        if (this.fullAccessConfirmationPending) {
          this.fullAccessConfirmationPending = false;
          this.onPermissionChange("full-access");
        } else {
          const next: PermissionMode = this.permissionMode === "read-only" ? "workspace-write"
            : this.permissionMode === "workspace-write" ? "full-access" : "read-only";
          if (next === "full-access") {
            this.fullAccessConfirmationPending = true;
          } else {
            this.onPermissionChange(next);
          }
        }
        if (this.layout) this.renderNow();
        return;
      }
      if (this.fullAccessConfirmationPending) {
        // 任意其他按键撤销提权待确认，Esc 也不会提交一条任务。
        this.fullAccessConfirmationPending = false;
        if (this.layout) this.renderNow();
      }

      if (this.layout && this.promptActive && this.promptText === COMMAND_PROMPT) {
        // 方向键已被 readline 预处理；这里恢复菜单打开前的文本，防止载入输入历史。
        const items = this.slashMenuCandidates(this.slashDraft);
        const active = !this.slashDismissed && items.length > 0;
        if (active && (name === "up" || name === "down")) {
          this.slashSelected = (this.slashSelected + (name === "down" ? 1 : -1) + items.length) % items.length;
          this.setEditorLine(this.slashDraft, this.slashDraftCursor);
          this.renderNow();
          return;
        }
        if (active && name === "tab" && !key?.shift) {
          const chosen = items[Math.min(this.slashSelected, items.length - 1)]!;
          this.setEditorLine(chosen.command);
          this.slashDraft = chosen.command;
          this.slashDraftCursor = chosen.command.length;
          this.slashDismissed = true;
          this.renderNow();
          return;
        }
        if (active && name === "escape") {
          this.setEditorLine(this.slashDraft, this.slashDraftCursor);
          this.slashDismissed = true;
          this.renderNow();
          return;
        }
        if (this.rl.line !== this.slashDraft) {
          this.slashDraft = this.rl.line;
          this.slashDraftCursor = this.rl.cursor;
          this.slashSelected = 0;
          this.slashDismissed = false;
        } else {
          this.slashDraftCursor = this.rl.cursor;
        }
      }

      if (!this.layout) return;
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

  /** Slash 查询不包含空白；/permission read-only 是完整命令，不再弹出补全。 */
  private slashMenuCandidates(line: string): readonly (typeof SLASH_COMMANDS)[number][] {
    if (!/^\/[^\s]*$/.test(line)) return [];
    return SLASH_COMMANDS.filter((item) => item.command.startsWith(line));
  }

  /** 固定布局下至多显示五项；小窗口至少给日志与输入留出一行。 */
  private slashMenuItems(): readonly (typeof SLASH_COMMANDS)[number][] {
    if (!this.layout || !this.promptActive || this.promptText !== COMMAND_PROMPT ||
        this.approvalMenuActive || this.slashDismissed) return [];
    const candidates = this.slashMenuCandidates(this.rl.line);
    return candidates;
  }

  /** 显式恢复 readline 编辑缓存（不创建历史记录）。 */
  private setEditorLine(text: string, cursor = text.length): void {
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.rl.write(text);
    for (let i = 0; i < [...text.slice(cursor)].length; i++) {
      this.rl.write(null, { name: "left" });
    }
    this.inputDirty = true;
  }

  /** 候选菜单的显示宽度按终端字符列计算，选中项使用强调色。 */
  private slashMenuLine(item: (typeof SLASH_COMMANDS)[number], selected: boolean, width: number): string {
    const prefix = selected ? this.glyphs.user : " ";
    const nameWidth = Math.min(18, Math.max(12, width - 1));
    const name = padRight(` ${item.command}`, nameWidth);
    const description = this.uiLanguage === "zh" ? item.zh : item.en;
    const available = Math.max(0, width - displayWidth(prefix) - displayWidth(name));
    const plain = prefix + name + takeByWidth(description, available);
    return selected
      ? this.style.paint("accent", prefix + name) + this.style.paint("assistant", takeByWidth(description, available))
      : this.style.paint("muted", clip(plain, width));
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
          // 缩小窗口时退化为逐行显示，菜单仍只接受方向键/Enter/Esc。
          const prompt = formatApproval(this.approvalRequest, this.workspace);
          const body = prompt.endsWith(APPROVAL_QUESTION)
            ? prompt.slice(0, -APPROVAL_QUESTION.length) : prompt;
          this.output.write(`${body}\n${this.uiText("Do you want to proceed?", "是否允许执行？")}\n  ${this.uiText("1. Yes, allow once", "1. 是，仅允许本次")}\n> ${this.uiText("2. No (default)", "2. 否（默认）")}\n${this.uiText("Esc to cancel · Up/Down · Enter", "Esc 取消 · 上下键选择 · Enter 确认")}\n`);
          this.setApprovalCursor(false);
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
    if (this.approvalMenuActive) this.setApprovalCursor(true);
    this.renderNow();
    if (wasPrompt) {
      this.restorePrompt();
    }
  }

  /** 只翻译 TUI 自己生成的提示；不翻译模型回复、工具参数或错误详情。 */
  uiText(english: string, chinese: string): string {
    return this.uiLanguage === "zh" ? chinese : english;
  }

  /** 用于 CLI 的会话命令提示，语言跟随最近一轮任务。 */
  helpText(permissionModes: string): string {
    return this.uiText(
      `commands: /exit  quit · /reset  clear the transcript and start a new Agent · /help  show this\n          /permission [mode]  show or switch permission (${permissionModes})`,
      `命令：/exit  退出 · /reset  清空会话并重建 Agent · /help  显示帮助\n      /permission [模式]  查看或切换权限（${permissionModes}）`,
    );
  }

  /** 切换权限后刷新页脚；真正的放行/拒绝仍由 Permission 决定。 */
  setPermission(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.fullAccessConfirmationPending = false;
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
      this.setActivityState("thinking");
      this.thinking = true;
      this.thinkingStartedAt = Date.now();
      if (this.fixedLayoutAllowed) {
        // 只量测请求等待，不推断模型内部思考，也不虚构 token 数。
        this.thinkingTimer = setInterval(() => {
          if (this.layout) this.renderNow();
        }, 200);
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
    const wasThinking = this.thinking;
    this.thinking = false;
    // 首段模型正文到达时移除等待态和俏皮短句，不能在日志末尾留下假的 Thinking。
    if (wasThinking && this.activityState === "thinking") {
      this.activityState = undefined;
      this.moodText = "";
    }
    if (this.thinkingTimer !== undefined) {
      clearInterval(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
  }

  /** 从真实事件选择稳定的临时语气；每次变更状态才立即换句。 */
  private setActivityState(state: MoodState): void {
    if (this.activityState === state) return;
    this.activityState = state;
    this.moodChangedAt = Date.now();
    this.chooseMood(state);
    if (this.currentTurn !== undefined && state !== "preparing" && this.currentTurn.endedAt === undefined) {
      this.currentTurn.outcome = "running";
    }
  }

  private chooseMood(state: MoodState): void {
    this.moodText = selectMood(state, this.uiLanguage, this.recentMoods);
    this.recentMoods.push(this.moodText);
    if (this.recentMoods.length > 6) this.recentMoods.shift();
    this.moodChangedAt = Date.now();
  }

  private maybeRotateMood(): void {
    if (this.activityState === undefined) return;
    // 审批和错误不轮播；短工具调用只显示一条，不产生闪烁。
    if (this.activityState === "approval" || this.activityState === "failed" ||
        this.activityState === "completed" || this.activityState === "cancelled") return;
    if (Date.now() - this.moodChangedAt >= 15_000) this.chooseMood(this.activityState);
  }

  private withMood(base: string, width: number): string {
    if (this.moodText === "") return base;
    const extra = ` │ ${this.moodText}`;
    return displayWidth(base) + displayWidth(extra) <= width ? base + extra : base;
  }

  private turnStatusLine(turn: TurnActivity): LogLine {
    const elapsed = Math.max(0, (turn.endedAt ?? Date.now()) - turn.startedAt);
    const duration = formatActivityDuration(elapsed, turn.language);
    const zh = turn.language === "zh";
    if (turn.outcome === "completed") return {
      text: `  ${this.glyphs.success} ${zh ? "已完成" : "Completed"} · ${zh ? "用时" : "in"} ${duration}`,
      tone: "success",
    };
    if (turn.outcome === "failed" || turn.outcome === "cancelled") {
      const outcome = turn.outcome === "failed" ? (zh ? "执行失败" : "Failed") : (zh ? "已取消" : "Cancelled");
      return { text: `  ${turn.outcome === "failed" ? this.glyphs.error : this.glyphs.notRun} ${outcome} · ${zh ? "用时" : "after"} ${duration}`,
        tone: turn.outcome === "failed" ? "error" : "muted" };
    }
    if (turn.outcome === "preparing") return { text: `  ${this.glyphs.running} ${zh ? "准备执行" : "Preparing"}`, tone: "muted" };
    return { text: `  ${this.glyphs.running} ${zh ? "正在执行 · 已用时" : "Working · elapsed"} ${duration}`, tone: "accent" };
  }

  private activitySummary(group: ActivityGroup): string {
    const words: string[] = [];
    for (const item of group.tools) {
      const summary = item.result === undefined ? undefined : summarizeToolResult(item.call, item.result);
      const verb = group.finished && item.result === undefined
        ? group.language === "zh" ? "有操作未返回结果" : "Some operations had no result"
        : activityVerb(item.call, group.language, summary);
      if (!words.includes(verb)) words.push(verb);
    }
    if (words.length === 0) return this.uiText("Working...", "处理中...");
    const count = Math.min(3, words.length);
    return `${words.slice(0, count).join(group.language === "zh" ? "、" : ", ")}${words.length > 3 ? group.language === "zh" ? "等" : ", etc." : ""}`;
  }

  private activityFailureLine(item: ActivityTool, language: UiLanguage): LogLine | undefined {
    if (item.result === undefined) return undefined;
    const summary = summarizeToolResult(item.call, item.result);
    if (!summary.failed) return undefined;
    const event = activityEventName(item.call, language);
    const mark = summary.denied ? this.glyphs.denied : summary.notRun ? this.glyphs.notRun : this.glyphs.error;
    const tone: Tone = summary.notRun ? "muted" : summary.denied ? "warning" : "error";
    const label = language === "zh"
      ? summary.denied ? "已拒绝" : summary.notRun ? "未执行" : "失败"
      : summary.denied ? "denied" : summary.notRun ? "not run" : "failed";
    const reason = activityFailureReason(item.call, item.result, summary);
    return { text: escapeControlCharacters(`    ${mark} ${event} ${label} · ${reason}`), tone, kind: "activity-error" };
  }

  private activityUnfinishedLine(item: ActivityTool, language: UiLanguage): LogLine {
    return { text: escapeControlCharacters(`    ${this.glyphs.notRun} ${activityEventName(item.call, language)} · ${language === "zh" ? "未收到工具结果" : "no tool result received"}`),
      tone: "muted", kind: "activity-error" };
  }

  private activityToolLines(item: ActivityTool, group: ActivityGroup): LogLine[] {
    if (item.result === undefined && group.finished) return [this.activityUnfinishedLine(item, group.language)];
    if (item.result === undefined) {
      const title = this.makeLogLine(`    ${this.glyphs.running} ${formatToolEvent(item.call, group.language)}`, "muted");
      title.kind = "tool";
      const lines = [title];
      if (!this.approvalBlocksRunning) lines.push(this.makeLogLine(
        `      ${this.glyphs.boxBottomLeft} ${this.uiText("Running...", "运行中...")}`, "muted"));
      return lines;
    }
    const failed = this.activityFailureLine(item, group.language);
    if (failed !== undefined) {
      const raw = item.result.split("\n").map((line) => line.trim()).filter(Boolean);
      const lines: LogLine[] = [failed];
      // 摘要中错误原因始终在命令同一行；展开后再展示实际返回的原始内容。
      for (const line of raw.slice(0, 20)) {
        lines.push(this.makeLogLine(`      ${this.glyphs.boxBottomLeft} ${line}`, "muted"));
      }
      if (raw.length > 20) lines.push(this.makeLogLine(`      … ${raw.length - 20} ${this.uiText("more lines in the tool result", "行原始输出未预览")}`, "muted"));
      return lines;
    }
    const result = toolResultLines(item.call, item.result, this.glyphs, group.language);
    return result.map((entry, index) => ({
      ...this.makeLogLine(index === 0
        ? entry.text.replace(/^  /, "    ") + ` · ${formatActivityDuration(Math.max(0, (item.endedAt ?? Date.now()) - item.startedAt), group.language)}`
        : `  ${entry.text}`, entry.tone),
      kind: index === 0 ? entry.kind : undefined,
    }));
  }

  /**
   * 任务开始：把用户这一轮写进对话，并关掉上一段可能未收尾的模型回复。
   *
   * 固定布局清掉 readline 的输入回显，所以写一条 `❯ task`；行式聊天默认不重复。
   */
  beginTurn(task: string, { show = this.fixedLayoutAllowed || !this.interactive }: { show?: boolean } = {}): void {
    this.uiLanguage = detectUiLanguage(task, this.uiLanguage);
    this.runStartedAt = Date.now();
    this.runToolResults = 0;
    this.activeActivity = undefined;
    this.activityFocus = -1;
    this.activityPending.clear();
    if (this.fixedLayoutAllowed) {
      this.currentTurn = { language: this.uiLanguage, startedAt: this.runStartedAt,
        outcome: "preparing", groups: [] };
      // 即使任务后来失败或被取消，旧轮标题也保留独立状态，不受新轮计时影响。
      if (this.layout) {
        this.stopThinking();
        this.commitAssistant();
      }
      if (show) this.pushTask(task);
      this.log.push({ text: "", tone: "muted", kind: "turn-status", turn: this.currentTurn });
      this.trimLog();
      this.setActivityState("preparing");
      if (this.activityTimer !== undefined) clearInterval(this.activityTimer);
      this.activityTimer = setInterval(() => {
        this.maybeRotateMood();
        if (this.layout && this.currentTurn?.endedAt === undefined) this.renderNow();
      }, 1000);
      this.activityTimer.unref?.();
      if (this.layout) {
        this.scrollOffset = 0;
        this.renderNow();
        return;
      }
    } else {
      this.currentTurn = undefined;
      this.setActivityState("preparing");
    }
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
    if (!show) return;
    const lines = splitDisplayLines(task);
    lines.forEach((line, index) => {
      const label = this.uiText("you: ", "用户：");
      const text = index === 0 ? `${label}${line}` : `${" ".repeat(displayWidth(label))}${line}`;
      this.writeRaw(`${escapeControlCharacters(text)}${this.newline()}`);
    });
  }

  /** 模型正文增量。固定布局只累积、限频重绘；行式聊天直接写。 */
  assistantDelta(text: string): void {
    if (text === "") return;

    if (this.layout) {
      const first = !this.assistantOpen;
      if (first) {
        this.pushBlank();
        // 下一段真实的 AI 发言会成为随后工具组的阶段说明；不合并到上一组。
        this.activeActivity = undefined;
      }
      this.stopThinking();
      this.assistantOpen = true;
      this.streamingText += normalizeNewlines(text);
      if (first) this.renderNow();
      else this.scheduleRender();
      return;
    }

    this.setThinking(false);
    this.streamingText += normalizeNewlines(text);
    if (!this.assistantOpen) {
      this.writeRaw(this.uiText("model: ", "模型："));
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
        this.activeActivity = undefined;
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
    this.streamingText = "";
  }

  /**
   * 用已经确认的模型消息校对流式增量。固定布局可原地改正，行式模式无法
   * 撤回已写字节，必须追加明确的更正提示与权威正文，而不是悄悄忽略差异。
   * 与 finishAssistant() 不同：null 表示模型确认没有正文，不是“未知正文”。
   */
  confirmAssistant(content: string | null): void {
    const confirmed = normalizeNewlines(content ?? "");
    if (this.layout) {
      if (this.streamingText !== confirmed || (!this.assistantOpen && confirmed !== "")) {
        if (!this.assistantOpen && confirmed !== "") this.activeActivity = undefined;
        this.streamingText = confirmed;
        this.assistantOpen = confirmed !== "";
      }
      this.finishAssistant();
      return;
    }

    if (this.assistantOpen && this.streamingText !== confirmed) {
      if (!this.assistantAtLineStart) this.writeRaw(this.newline());
      this.writeRaw(`${this.uiText("[stream corrected: confirmed message follows]", "【流式正文已更正：以下为确认消息】")}${this.newline()}`);
      if (confirmed !== "") this.writeRaw(`${this.uiText("model (confirmed): ", "模型（已确认）：")}${escapeControlCharacters(confirmed)}${this.newline()}`);
      this.assistantOpen = false;
      this.assistantAtLineStart = true;
      this.streamingText = "";
      return;
    }
    if (!this.assistantOpen && confirmed !== "") this.assistantDelta(confirmed);
    this.finishAssistant();
  }

  /**
   * 本轮模型请求失败时，流式增量还不是经过最终响应确认的消息。
   * 固定布局可以撤销草稿；行式终端无法收回已输出字节，必须追加明显的失效声明。
   * 已提交的上一阶段说明不受影响，工具活动和 Transcript 也不从展示层修改。
   */
  discardAssistantDraft(): void {
    if (!this.assistantOpen) return;
    const warning = this.uiText(
      "[stream interrupted: unconfirmed text discarded]",
      "【流式响应中断：未确认正文已丢弃】",
    );
    this.streamingText = "";
    this.assistantOpen = false;

    if (this.layout) {
      this.pushLog(warning, "warning");
      this.renderNow();
      return;
    }

    if (!this.assistantAtLineStart) this.writeRaw(this.newline());
    this.writeRaw(`${escapeControlCharacters(warning)}${this.newline()}`);
    this.assistantAtLineStart = true;
  }

  /** 工具调用开始：固定布局先写「正在运行」；结果到达时原地替换成 ✓/✗。 */
  toolCall(call: ToolCall): void {
    this.approvalBlocksRunning = false;
    this.setThinking(false);
    this.finishAssistant();
    this.setActivityState(moodStateForTool(call));
    const turn = this.currentTurn;
    if (this.fixedLayoutAllowed && turn !== undefined && turn.endedAt === undefined) {
      let group = this.activeActivity;
      if (group === undefined) {
        // AI 的说明与其下方的 ↳ 摘要紧邻；通用 commitAssistant 会多留一个空行。
        if (this.log.at(-1)?.text === "" && this.log.at(-2)?.tone === "assistant") this.log.pop();
        group = { language: this.uiLanguage, tools: [], expanded: true };
        turn.groups.push(group);
        this.activeActivity = group;
        // 非空锚点让下一段 AI 发言自动与本阶段之间留一行。
        this.log.push({ text: "↳", tone: "muted", kind: "activity", activity: group });
      }
      const item: ActivityTool = { call, startedAt: Date.now() };
      group.tools.push(item);
      this.activityPending.set(call.id, item);
      this.trimLog();
      if (this.layout) {
        this.renderNow();
        return;
      }
    } else if (this.fixedLayoutAllowed) {
      // 没有任务容器的测试/兼容调用仍按原来的逐行格式处理。
      this.pushBlank();
      const line: LogLine = {
        ...this.makeLogLine(`  ${this.glyphs.running} ${formatToolEvent(call, this.uiLanguage)}`, "muted"),
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
    this.approvalBlocksRunning = false;
    this.runToolResults++;
    this.setThinking(false);
    this.finishAssistant();
    const activeTool = this.activityPending.get(call.id);
    if (activeTool !== undefined) {
      activeTool.result = result;
      activeTool.endedAt = Date.now();
      this.activityPending.delete(call.id);
      this.setActivityState(this.activityPending.size > 0 ? "running" : "working");
      if (this.layout) {
        this.renderNow();
        return;
      }
    }
    if (this.fixedLayoutAllowed && activeTool === undefined) {
      const pending = this.pendingTools.get(call.id);
      this.pendingTools.delete(call.id);
      const lines = toolResultLines(call, result, this.glyphs, this.uiLanguage)
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

    this.writeRaw(`  ${escapeControlCharacters(formatToolResult(call, result, this.uiLanguage))}${this.newline()}`);
  }

  /** 一轮结束：更新统计；固定布局重画页脚，其余布局打一行 [stats]。 */
  finishTurn(run: AgentStats, session: AgentSessionStats, { failed, cancelled = false }: { failed: boolean; cancelled?: boolean }): void {
    this.stats = session;
    this.runStartedAt = undefined;

    if (this.currentTurn !== undefined && this.currentTurn.endedAt === undefined) {
      this.currentTurn.endedAt = Date.now();
      this.currentTurn.outcome = cancelled ? "cancelled" : failed ? "failed" : "completed";
      // 完成后只折叠工具明细，AI 的真实阶段说明和每一段摘要仍常驻。
      for (const group of this.currentTurn.groups) {
        group.expanded = false;
        group.finished = true;
      }
      this.activityFocus = -1;
      this.activeActivity = undefined;
      this.activityPending.clear();
    }
    this.activityState = undefined;
    this.moodText = "";
    if (this.activityTimer !== undefined) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
    if (this.layout) {
      this.stopThinking();
      this.commitAssistant();
      if (run.tokenBudget.exceeded) {
        this.pushLog(this.uiText(`[budget] exceeded (limit=${run.tokenBudget.limit})`, `[预算] 已超出限制（上限=${run.tokenBudget.limit}）`), "warning");
      }
      this.renderNow();
      return;
    }

    this.setThinking(false);
    this.finishAssistant();
    const overBudget = run.tokenBudget.exceeded
      ? this.uiText(` · budget exceeded (limit=${run.tokenBudget.limit})`, ` · 预算超限（上限=${run.tokenBudget.limit}）`) : "";
    const outcome = failed ? this.uiText(" · task failed", " · 任务失败") : "";
    this.logLine(`${this.uiText("[stats]", "[统计]")} ${formatStats(session, this.uiLanguage)}${overBudget}${outcome}`);
  }

  /** 进程级总账：跨 Run 累计，和每轮的 [stats] 是两个口径。 */
  sessionSummary(session: AgentSessionStats): void {
    const lower = session.usage.unknown > 0 ? this.uiText("at least ", "至少 ") : "";
    const text = this.uiLanguage === "zh"
      ? `[会话] ${session.runs} 轮 · ${session.requests} 次请求 · ${session.toolCalls} 次工具调用 · tokens=${lower}${session.usage.totalTokens} (prompt=${lower}${session.usage.promptTokens} completion=${lower}${session.usage.completionTokens})`
      : `[session] runs=${session.runs} requests=${session.requests} tool_calls=${session.toolCalls} ` +
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

  /** 完整、安全的命令展示 + 两项菜单。菜单只修改显示与输入映射，不修改权限判定。 */
  private approvalPanelLines(request: PermissionRequest): LogLine[] {
    const width = this.contentWidth();
    const rawCommand = typeof request.args.command === "string" ? request.args.command : "";
    const command = rawCommand === "" ? this.uiText("(empty command)", "（空命令）") : rawCommand;
    const commandLines = command.split("\n").map((line) => escapeControlCharacters(line));
    const cwd = escapeControlCharacters(this.workspace).replace(/\n/g, "\\u000a");
    const select = this.glyphs.user;

    const entries: Array<{ text: string; tone: Tone }> = [
      { text: this.uiText("Shell permission", "Shell 权限审批"), tone: "warning" },
      { text: `${this.uiText("Workspace:", "工作目录：")} ${cwd}`, tone: "muted" },
      { text: "", tone: "plain" },
      { text: this.uiText("Command:", "命令："), tone: "assistant" },
      ...commandLines.map((line) => ({ text: `  | ${line}`, tone: "assistant" as Tone })),
      { text: "", tone: "plain" },
      { text: this.uiText("Do you want to proceed?", "是否允许执行？"), tone: "assistant" },
      { text: `${this.approvalChoice === "allow" ? select : " "} ${this.uiText("1. Yes, allow once", "1. 是，仅允许本次")}`,
        tone: this.approvalChoice === "allow" ? "accent" : "muted" },
      { text: `${this.approvalChoice === "deny" ? select : " "} ${this.uiText("2. No (default)", "2. 否（默认）")}`,
        tone: this.approvalChoice === "deny" ? "accent" : "muted" },
      { text: "", tone: "plain" },
      { text: this.uiText("Esc to cancel", "Esc 取消"), tone: "muted" },
    ];

    const separator: LogLine = {
      text: this.glyphs.divider.repeat(Math.max(1, width)),
      tone: "muted",
    };
    const panel: LogLine[] = [{ ...separator }];
    for (const entry of entries) {
      for (const part of wrapLine(entry.text, width)) {
        panel.push({ text: part, tone: entry.tone });
      }
    }
    // Claude Code 风格：Esc 提示下方不再追加收尾分隔线。
    return panel;
  }

  async approve(request: PermissionRequest): Promise<boolean> {
    const gate = approvalGate(this.controller.signal, this.interactive, this.lines.length > 0);
    if (!gate.ask) throw new Error(`shell approval skipped: ${gate.reason}`);

    this.setThinking(false);
    this.finishAssistant();
    this.setActivityState("approval");
    if (this.fixedLayoutAllowed) {
      this.pushBlank();
      this.approvalBlocksRunning = true;
      this.approvalRequest = request;
      this.approvalChoice = "deny";
      this.approvalMenuActive = this.layout;
      this.scrollOffset = 0;
    }
    let approved: boolean;
    try {
      if (this.layout) {
        this.setApprovalCursor(true);
        this.renderNow();
        // 菜单仅处理导航按键，默认 No。没有隐形文本输入和自动记住授权。
        const decision = await new Promise<boolean | null>((resolve) => {
          this.approvalMenuResolve = resolve;
          if (this.ended || this.controller.signal.aborted) resolve(null);
        });
        if (decision === null) {
          throw new Error(
            this.controller.signal.aborted
              ? "shell approval skipped: task cancelled"
              : "shell approval skipped: approval prompt closed",
          );
        }
        approved = decision;
      } else {
        const formatted = formatApproval(request, this.workspace);
        const header = formatted.endsWith(APPROVAL_QUESTION)
          ? formatted.slice(0, -APPROVAL_QUESTION.length)
          : formatted;
        this.writeRaw(`${header.replace(/\n$/, "")}${this.newline()}`);
        const answer = await this.readLine(APPROVAL_QUESTION);
        if (answer === null) {
          throw new Error(
            this.controller.signal.aborted
              ? "shell approval skipped: task cancelled"
              : "shell approval skipped: approval prompt closed",
          );
        }
        approved = isApproved(answer);
      }
    } finally {
      this.approvalMenuResolve = undefined;
      if (this.fixedLayoutAllowed) {
        this.approvalMenuActive = false;
        this.approvalRequest = undefined;
        // 清理 readline 对方向键、误输入和回车的内部缓冲，禁止污染下一轮任务。
        if (!this.ended && this.rl.line !== "") this.rl.write(null, { ctrl: true, name: "u" });
        this.setApprovalCursor(false);
        this.promptText = COMMAND_PROMPT;
        this.promptPlaceholder = true;
        this.trimLog();
        this.renderNow();
      }
    }

    if (approved) this.approvalBlocksRunning = false;
    this.setActivityState(approved ? "running" : "working");
    if (this.layout) {
      this.logLine(
        `  ${approved ? this.glyphs.success : this.glyphs.denied} ${approved ? this.uiText("Allowed once", "已允许本次执行") : this.uiText("Denied", "已拒绝")}`,
        approved ? "success" : "warning",
      );
    } else {
      this.logLine(`${this.uiText("approval:", "审批：")} ${approved ? this.uiText("allowed once", "已允许本次执行") : this.uiText("denied", "已拒绝")}`, approved ? "success" : "error");
    }
    return approved;
  }

  /** 结束 TUI：清掉监听器和定时器、提交当前回复、恢复终端。 */
  close(): void {
    if (this.closed) return;
    this.setThinking(false);
    if (this.activityTimer !== undefined) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
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
    this.setApprovalCursor(false);

    if (this.cursorStyleChanged) this.output.write("\x1b[0 q");
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

    if (!this.cursorStyleChanged && prefersRichColor()) {
      // DECSCUSR 也覆盖窄窗口放大后首次进入布局；退出时恢复默认，不改持久配置。
      this.output.write("\x1b[2 q");
      this.cursorStyleChanged = true;
    }

    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderScheduled = false;

    // 短对话下让输入框紧跟内容；当日志变长或用户翻看历史时，再固定到底部。
    // 每帧先恢复最大视口，再用当前逻辑行数计算输入框位置，避免累积位移。
    const slashCandidates = this.slashMenuItems();
    const menuRows = Math.min(slashCandidates.length, Math.max(0, this.rows - 11), 5);
    this.recomputeGeometry(menuRows);
    const width = this.contentWidth();
    const lines = this.wrappedDisplayLines();
    if (this.approvalMenuActive) {
      // 审批独占可视区域：不再为隐藏的聊天输入框与状态栏保留四行。
      this.logHeight = Math.max(1, this.rows - LOG_TOP);
    } else if (this.flowInput && this.scrollOffset === 0) {
      // 审批是需要就地操作的焦点面板：只为命令面板与最近两行上下文预留高度。
      // 长会话此前的日志仍留在滚动历史，不把 y/N 输入推离审批面板。
      const focusedLength = this.approvalRequest === undefined
        ? lines.length
        : Math.min(lines.length, this.approvalPanelLines(this.approvalRequest).length + 2);
      const gap = this.approvalRequest === undefined ? 1 : 0;
      this.logHeight = Math.min(this.logHeight, Math.max(2, focusedLength + gap));
      this.boxTopRow = LOG_TOP + this.logHeight;
      this.inputRow = this.boxTopRow + 1;
      this.boxBottomRow = this.inputRow + 1;
      this.statusRow = this.boxBottomRow + menuRows + 1;
    }

    const rows: string[] = new Array(this.rows).fill("");
    rows[TITLE_ROW - 1] = this.titleLine(width);
    rows[PATH_ROW - 1] = this.style.paint("muted", fitPath(singleLine(this.workspace), width));
    const divider = this.dividerLine(width);
    rows[TOP_DIVIDER_ROW - 1] = divider;
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
        : this.paintLogLine(line, width);
    }

    // 审批菜单的 Esc 提示下方也不画聊天输入区的上边线；
    // 否则虽然删除面板收尾线，依然会看到另一条横线。
    if (!this.approvalMenuActive) {
      rows[this.boxTopRow - 1] = divider;
      rows[this.inputRow - 1] = this.inputLine(width);
      rows[this.boxBottomRow - 1] = divider;
      if (menuRows > 0) {
        const first = Math.min(Math.max(0, this.slashSelected - menuRows + 1),
          Math.max(0, slashCandidates.length - menuRows));
        for (let i = 0; i < menuRows; i++) {
          const index = first + i;
          rows[this.boxBottomRow + i] = this.slashMenuLine(
            slashCandidates[index]!, index === this.slashSelected, width);
        }
      }
      rows[this.statusRow - 1] = this.footerLine(width);
    }

    if (this.lastFrame.length !== this.rows) this.lastFrame = [];
    for (let index = 0; index < rows.length; index++) {
      const forceInput = this.inputDirty && index === this.inputRow - 1;
      if (forceInput || this.lastFrame[index] !== rows[index]) {
        this.writeRow(index + 1, rows[index]);
        this.lastFrame[index] = rows[index];
      }
    }
    this.inputDirty = false;
    if (!this.approvalMenuActive) this.restoreInputCursor();
  }

  /** 确保审批结束、取消或 resize 后不会把终端光标留在隐藏状态。 */
  private setApprovalCursor(hidden: boolean): void {
    if (!this.terminalControls || this.approvalCursorHidden === hidden) return;
    this.output.write(hidden ? "\x1b[?25l" : "\x1b[?25h");
    this.approvalCursorHidden = hidden;
  }

  private paintLogLine(line: LogLine, width: number): string {
    const text = clip(line.text, width);
    if (line.tone === "user") return this.style.userMessage(padRight(text, width));
    if (line.tone === "assistant" && text.startsWith(`${this.glyphs.assistant} `)) {
      return this.style.paint("accent", this.glyphs.assistant) +
        this.style.paint("assistant", text.slice(this.glyphs.assistant.length));
    }
    if (line.kind === "tool") {
      // 工具标题的缩进和符号仅承担状态色，其余文字保持中性。
      const prefix = text.startsWith("    ") ? 6 : 4;
      return this.style.paint(line.tone, text.slice(0, prefix)) +
        this.style.bold(this.style.paint("assistant", text.slice(prefix)));
    }
    if (line.kind === "thinking") {
      const end = text.indexOf(" (");
      return this.style.paint("accent", end < 0 ? text : text.slice(0, end)) +
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
    const room = Math.max(1, width - displayWidth(prompt));
    const cursor = this.rl.cursor;
    if (cursor < this.inputOffset) this.inputOffset = cursor;
    while (displayWidth(escapeControlCharacters(this.rl.line.slice(this.inputOffset, cursor))) >= room) {
      this.inputOffset += (this.rl.line.codePointAt(this.inputOffset) ?? 0) > 0xffff ? 2 : 1;
    }
    if (this.rl.line === "") this.inputOffset = 0;
    const placeholder = this.promptPlaceholder && this.rl.line === "" && this.promptText === COMMAND_PROMPT && this.log.length === 0;
    const text = placeholder ? ` ${this.uiText(PLACEHOLDER, "输入任务，或输入 /help...")}` : escapeControlCharacters(this.rl.line.slice(this.inputOffset));
    const shown = takeByWidth(text, room);
    return this.style.paint("muted", prompt) +
      this.style.paint(placeholder ? "muted" : "plain", padRight(shown, room));
  }

  /** 不用 ESC 7/8（conhost 上不一定可靠），按 prompt 宽度和已输入内容算回光标列。 */
  private restoreInputCursor(): void {
    const plainPrompt = this.promptText === COMMAND_PROMPT
      ? `${this.glyphs.user} `
      : singleLine(this.promptText);
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
    // 新一轮与上轮耗时/错误之间留一行；空会话和已有空行由 pushBlank 去重。
    this.pushBlank();
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
    const logical: LogLine[] = [];
    const pendingLines = new Set(this.pendingTools.values());
    for (const line of this.log) {
      if (line.kind === "turn-status" && line.turn !== undefined) {
        logical.push(this.turnStatusLine(line.turn));
        logical.push({ text: this.glyphs.divider.repeat(this.contentWidth()), tone: "muted" });
        continue;
      }
      if (line.kind === "activity" && line.activity !== undefined) {
        const group = line.activity;
        logical.push({ text: escapeControlCharacters(`  ${this.glyphs === UNICODE_GLYPHS ? "↳" : "+"} ${this.activitySummary(group)}`),
          tone: "muted", kind: "activity" });
        if (group.expanded) {
          for (const item of group.tools) logical.push(...this.activityToolLines(item, group));
        } else {
          // 收起后异常仍然可见；不能把拒绝、错误藏进成功摘要。
          for (const item of group.tools) {
            const failure = this.activityFailureLine(item, group.language);
            if (failure !== undefined) logical.push(failure);
            else if (group.finished && item.result === undefined) logical.push(this.activityUnfinishedLine(item, group.language));
          }
        }
        continue;
      }
      logical.push(line);
      // 兼容没有 beginTurn 的旧调用；正常任务的 Running 从 ActivityGroup 派生。
      if (pendingLines.has(line) && !this.approvalBlocksRunning) {
        logical.push({ text: `    ${this.glyphs.boxBottomLeft} ${this.uiText("Running...", "运行中...")}`, tone: "muted" });
      }
    }
    if (this.assistantOpen) {
      for (const line of this.assistantDisplayLines()) {
        logical.push({ text: line, tone: "assistant" });
      }
    }
    if (this.thinking) {
      const elapsed = Math.max(0, Date.now() - this.thinkingStartedAt);
      // 不用带 Emoji 属性的星号（如 U+2733）：Windows 会回退成绿色方块，破坏颜色与列宽。
      const frames = this.glyphs === UNICODE_GLYPHS ? ["✻", "✶", "✢", "✦"] : ["*", "+", "-", "+"];
      const spinner = frames[Math.floor(elapsed / 200) % frames.length];
      // 只展示已收到的工具结果数，不猜测端点尚未返回的流式 token。
      const results = this.runToolResults > 0 && this.contentWidth() >= 48
        ? ` · ${formatNumber(this.runToolResults)} ${this.uiText(this.runToolResults === 1 ? "tool result" : "tool results", "个工具结果")}` : "";
      // 中文对照：等待中，已经过 {seconds} 秒，以及已收到的工具结果数。
      this.maybeRotateMood();
      const waiting = `${spinner} Thinking... (${Math.floor(elapsed / 1000)}s${results})`;
      logical.push({ text: this.withMood(waiting, this.contentWidth()), tone: "accent", kind: "thinking" });
      // 中文对照：Ctrl-C 取消。
      logical.push({ text: `  ${this.glyphs.boxBottomLeft} ${this.uiText("Ctrl-C to cancel", "Ctrl-C 取消")}`, tone: "muted" });
    } else if (this.currentTurn?.endedAt === undefined && this.activityState !== undefined &&
               this.activityState !== "preparing" && !this.assistantOpen && !this.approvalMenuActive) {
      // 临时语气不进入 Transcript；下一次事件取代它，而非新增日志行。
      this.maybeRotateMood();
      const status = formatActivityStateLabel(this.activityState, this.uiLanguage);
      if (status !== "") logical.push({ text: this.withMood(
        `  ${this.glyphs.running} ${status}`, this.contentWidth()), tone: "muted" });
    }

    const width = this.contentWidth();
    const wrapped: LogLine[] = [];
    for (const line of logical) {
      const indent = line.text.match(/^\s*/)?.[0] ?? "";
      const continuation = line.kind === "tool" ? "    "
        : line.tone === "assistant" || line.tone === "user" ? "  " : indent;
      const parts = line.kind === "activity-error" || line.kind === "activity"
        ? [clip(line.text, width)]
        : wrapLine(line.text, width, continuation);
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
        wrapped.push({ text: this.uiText("PageUp/PageDown: review full command", "PageUp/PageDown：查看完整命令"), tone: "muted" });
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
      this.style.bold(this.style.paint("accent", project)) +
      `${" ".repeat(gap)}${this.style.paint("assistant", model)}`
    );
  }

  private dividerLine(width: number): string {
    const line = this.glyphs.divider.repeat(Math.max(0, width));
    return this.style.paint("muted", line);
  }

  private footerLine(width: number): string {
    const permissionTone: Tone =
      this.permissionMode === "full-access"
        ? "error"
        : this.permissionMode === "read-only"
          ? "assistant"
          : "warning";
    const scrollPrefix = `${this.glyphs.scroll} ${this.scrollOffset} ${this.uiText("lines", "行")}`;
    const baseLabel = this.scrollOffset > 0
      ? `${scrollPrefix} · ${this.permissionMode}`
      : this.permissionMode;
    const shortcut = this.onPermissionChange !== undefined && this.interactive
      ? this.uiText(" (shift-tab to cycle)", "（Shift+Tab 切换）") : "";
    let left = this.fullAccessConfirmationPending
      ? this.uiText("Confirm full-access: Shift+Tab again · Esc cancel", "确认 full-access：再次按 Shift+Tab · Esc 取消")
      : baseLabel + shortcut;
    let right = this.formatSessionStats(width >= 60);

    // 优先保留快捷键提示和完整统计，空间不足时再逐级缩短。
    if (displayWidth(left) + displayWidth(right) + 1 > width) {
      right = this.formatSessionStats(false);
    }
    if (displayWidth(left) + displayWidth(right) + 1 > width && !this.fullAccessConfirmationPending) {
      left = baseLabel;
      if (this.scrollOffset > 0 && displayWidth(left) + displayWidth(right) + 1 > width) left = scrollPrefix;
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
      this.style.paint(this.fullAccessConfirmationPending || this.scrollOffset > 0 ? "warning" : permissionTone, leftText) +
      `${" ".repeat(gap)}${this.style.paint("muted", rightText)}`
    );
  }

  private formatSessionStats(full: boolean): string {
    const stats = this.stats;
    if (stats === undefined) return full ? this.uiText("0 requests · 0 tokens", "0 次请求 · 0 tokens") : this.uiText("0 req · 0 tok", "0 请求 · 0 tok");
    const requests = formatNumber(stats.requests);
    const tools = formatNumber(stats.toolCalls);
    const lower = stats.usage.unknown > 0 ? this.uiText("at least ", "至少 ") : "";
    const tokens = `${lower}${formatNumber(stats.usage.totalTokens)}`;

    if (full) {
      const parts = [`${requests} ${this.uiText(stats.requests === 1 ? "request" : "requests", "次请求")}`];
      if (stats.toolCalls > 0) {
        parts.push(`${tools} ${this.uiText(stats.toolCalls === 1 ? "tool call" : "tool calls", "次工具调用")}`);
      }
      parts.push(`${tokens} tokens`);
      return parts.join(" · ");
    }

    const parts = [`${requests} ${this.uiText("req", "请求")}`];
    if (stats.toolCalls > 0) parts.push(`${tools} ${this.uiText("tools", "工具")}`);
    parts.push(`${tokens} tok`);
    return parts.join(" · ");
  }

  private contentWidth(): number {
    // 只留最右一列，防止写满末列触发终端自动折行；其余边距交给终端配置。
    return Math.max(1, this.columns - 1);
  }

  private recomputeGeometry(menuRows = 0): void {
    // 菜单占用输入框下方的位置；它不进入会话日志和统计状态。
    // 最后三行留缓冲，避免传统 conhost 的窗口底边吃掉状态行。
    this.statusRow = this.rows - 3;
    this.boxBottomRow = this.statusRow - menuRows - 1;
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
    const prefix = `${this.uiText("model", "模型")} ${clip(singleLine(this.model), 24)} | ${this.uiText("permission", "权限")} ${this.permissionMode} | ${this.uiText("workspace", "工作目录")} `;
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
    if (this.stats === undefined) return this.uiText("requests=0  tool_calls=0  tokens=0", "请求=0  工具调用=0  tokens=0");
    return this.uiLanguage === "zh"
      ? `请求=${this.stats.requests}  工具调用=${this.stats.toolCalls}  tokens=${formatTokens(this.stats)}`
      : `requests=${this.stats.requests}  tool_calls=${this.stats.toolCalls}  tokens=${formatTokens(this.stats)}`;
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

  private readonly rich: boolean;

  private readonly palette: Record<Tone, string>;

  constructor(enabled: boolean, rich: boolean) {
    this.enabled = enabled;
    this.rich = rich;
    this.palette = rich ? RICH_PALETTE : BASIC_PALETTE;
  }

  /** 用户整行使用轻微底色，向 Claude Code 的任务条靠拢；16 色终端只加粗。 */
  userMessage(text: string): string {
    if (!this.enabled) return text;
    if (!this.rich) return `\x1b[1;39m${text}\x1b[0m`;
    return `\x1b[1;38;5;255;48;5;237m${text}\x1b[0m`;
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

function formatStats(stats: AgentSessionStats, language: UiLanguage = "en"): string {
  if (language === "zh") {
    const unknown = stats.usage.unknown > 0 ? ` · ${stats.usage.unknown} 次请求缺少用量数据` : "";
    return `请求=${stats.requests} 工具调用=${stats.toolCalls} tokens=${formatTokens(stats)}${unknown}`;
  }
  const unknown = stats.usage.unknown > 0 ? ` · ${stats.usage.unknown} request(s) without usage` : "";
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


/** 真实操作类型映射为自然语言；仅根据工具名及结果分类，不虚构工作进展。 */
function activityVerb(call: ToolCall, lang: UiLanguage, summary?: ToolResultSummary): string {
  const zh = lang === "zh";
  const pending = summary === undefined;
  const failed = summary?.failed === true;
  const labels: Record<string, [string, string, string]> = {
    read: [zh ? "已读取文件" : "Read files", zh ? "正在读取文件" : "Reading files", zh ? "尝试读取文件" : "Tried reading files"],
    grep: [zh ? "已搜索代码" : "Searched code", zh ? "正在搜索代码" : "Searching code", zh ? "尝试搜索代码" : "Tried searching code"],
    glob: [zh ? "已匹配文件" : "Matched files", zh ? "正在匹配文件" : "Matching files", zh ? "尝试匹配文件" : "Tried matching files"],
    ls: [zh ? "已列出文件" : "Listed files", zh ? "正在列出文件" : "Listing files", zh ? "尝试列出文件" : "Tried listing files"],
    write: [zh ? "已写入文件" : "Wrote files", zh ? "正在写入文件" : "Writing files", zh ? "尝试写入文件" : "Tried writing files"],
    edit: [zh ? "已修改代码" : "Edited code", zh ? "正在修改代码" : "Editing code", zh ? "尝试修改代码" : "Tried editing code"],
    shell: [zh ? "已执行命令" : "Ran commands", zh ? "正在执行命令" : "Running commands", zh ? "尝试执行命令" : "Tried running commands"],
  };
  if (call.function.name === "shell" && summary?.denied) return zh ? "请求了命令授权" : "Requested command approval";
  if (call.function.name === "shell" && summary?.notRun) return zh ? "命令未执行" : "Command not run";
  const words = labels[call.function.name] ?? [zh ? "已使用工具" : "Used tools",
    zh ? "正在调用工具" : "Calling tools", zh ? "尝试调用工具" : "Tried using tools"];
  return words[pending ? 1 : failed ? 2 : 0]!;
}

/** Shell 报错用实际命令名称，其他工具用固定标签，避免在 UI 中显示参数 JSON。 */
function activityEventName(call: ToolCall, lang: UiLanguage): string {
  const formatted = formatToolEvent(call, lang);
  return call.function.name === "shell" ? formatted.replace(/^Shell: /, "") : formatted;
}

/** 只取工具实际返回的错误内容。Shell 的 exit N 优先附上其下一条输出。 */
function activityFailureReason(call: ToolCall, result: string, summary: ToolResultSummary): string {
  const lines = result.split("\n").map((line) => line.trim()).filter(Boolean);
  const exitStatus = call.function.name === "shell" &&
    (/^exit (?:-?\d+|null)$/.test(lines[0] ?? "") || /^timeout after \d+ms$/.test(lines[0] ?? ""));
  const reason = exitStatus && lines.length > 1 ? `${summary.body} · ${lines[1]}` : summary.body;
  return clip(reason.replace(/\s+/g, " "), 180);
}

function moodStateForTool(call: ToolCall): MoodState {
  switch (call.function.name) {
    case "read": case "ls": return "reading";
    case "grep": case "glob": return "searching";
    case "write": return "writing";
    case "edit": return "editing";
    case "shell": return "running";
    default: return "working";
  }
}

function formatActivityStateLabel(state: MoodState, lang: UiLanguage): string {
  const labels: Record<MoodState, [string, string]> = {
    preparing: ["Preparing...", "准备中..."],
    thinking: ["Thinking...", "Thinking..."],
    reading: ["Reading...", "读取中..."],
    searching: ["Searching...", "搜索中..."],
    editing: ["Editing...", "修改中..."],
    writing: ["Writing...", "写入中..."],
    running: ["Running...", "运行中..."],
    working: ["Working...", "处理中..."],
    approval: ["Awaiting approval", "等待授权"],
    failed: ["Failed", "失败"],
    completed: ["Completed", "已完成"],
    cancelled: ["Cancelled", "已取消"],
  };
  return labels[state][lang === "zh" ? 1 : 0];
}

function formatActivityDuration(milliseconds: number, lang: UiLanguage): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (lang === "zh") return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
  // CLI 与 TUI 共用一次事实判断；拒绝 / 未执行仍保留各自的展示标记。
  const failed = isToolResultFailure(call, result);
  const body = error ? first.slice("ERROR:".length).trim() : first;
  const more = lines.length > 1 ? " …" : "";
  return { failed, denied, notRun, body, more };
}

const TOOL_LABELS: Record<UiLanguage, Record<string, string>> = {
  en: { read: "Read", write: "Write", edit: "Edit", ls: "List", glob: "Glob", grep: "Grep", shell: "Shell" },
  zh: { read: "读取", write: "写入", edit: "编辑", ls: "列出", glob: "匹配文件", grep: "搜索", shell: "Shell" },
};

/** v0.3 的工具事件：Read README.md / Shell: npm run check，不把参数 JSON 原样刷出来。 */
function formatToolEvent(call: ToolCall, language: UiLanguage = "en"): string {
  const name = call.function.name;
  const label = TOOL_LABELS[language][name] ?? name;
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
      return path === "" ? `${label} ${pattern}` : `${label} ${pattern} ${language === "zh" ? "于" : "in"} ${path}`;
    }
    default: {
      const detail = toolArgumentSummary(name, call.function.arguments);
      return detail === "" ? label : `${label} ${detail}`;
    }
  }
}

/** 固定布局里的工具结果：失败/拒绝/未执行用不同符号，第一行原因放在下一行。 */
function toolResultLines(call: ToolCall, result: string, glyphs: Glyphs, language: UiLanguage = "en"): LogLine[] {
  const summary = summarizeToolResult(call, result);
  const event = formatToolEvent(call, language);
  if (!summary.failed) {
    const resultLines = result === "" ? [] : splitDisplayLines(result);
    const count = resultLines.length;
    // 中文对照：收到 {count} 行；这是工具实际返回的行数，不声称是文件总行数。
    const detail = call.function.name === "read"
      ? language === "zh"
        ? `收到 ${formatNumber(count)} 行`
        : `Received ${formatNumber(count)} ${count === 1 ? "line" : "lines"}`
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
function formatToolResult(call: ToolCall, result: string, language: UiLanguage = "en"): string {
  const summary = summarizeToolResult(call, result);
  const label = language === "zh"
    ? summary.denied ? "已拒绝" : summary.notRun ? "未运行" : summary.failed ? "失败" : "成功"
    : summary.denied ? "denied" : summary.notRun ? "not run" : summary.failed ? "failed" : "ok";
  const mark = summary.failed ? (summary.notRun ? "–" : "✗") : "✓";
  return `${mark} ${call.function.name} [${label}] ${clip(summary.body, 160)}${summary.more}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

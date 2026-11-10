/**
 * 轻量 TUI：Claude Code 风格的聊天式终端界面。
 *
 * v0.3 的目标是「像聊天，而不是调试控制台」：顶部是项目/模型/路径，中间是用户、
 * 模型和工具调用的对话视口，底部是带分隔线的固定输入区，最下面是权限和 Session 统计。
 *
 * 渲染用绝对光标定位 + 差分重绘：可确认兼容的终端进入备用屏幕，缩放合并后重排；
 * 传统 Windows conhost 等能力不明的终端用行式聊天，不向 Shell 历史重复写入固定画面。
 * 不引 TUI 库、不改 Agent。
 *
 * 非 TTY（管道、CI、e2e）也退化成逐行输出：没有固定位置，但走同一套日志/审批逻辑。
 * 已知边界：固定布局要求终端至少 12 行、30 列；历史保留最近 2000 条逻辑行；
 * 宽度按近似显示宽度（CJK/emoji 按 2 列），不做完整 Unicode 宽度表。
 */
import { createInterface, emitKeypressEvents } from "node:readline";
import type { Interface, Key } from "node:readline";
import { Transform, Writable } from "node:stream";
import { APPROVAL_QUESTION, escapeControlCharacters, formatApproval } from "./approval.ts";
import type { AgentSessionStats, AgentStats } from "./agent.ts";
import { approvalGate, isApproved } from "./permission.ts";
import { selectMood } from "./tui-mood.ts";
import { previewImage } from "./tui-image.ts";
import type { ImagePreview } from "./tui-image.ts";
import type { MoodState } from "./tui-mood.ts";
import type { PermissionMode, PermissionRequest } from "./permission.ts";
import type { ToolCall } from "./types.ts";
import { isToolResultFailure } from "./tool-result-status.ts";

/** 固定布局至少需要：标题/路径/分隔线 + 日志 + 输入框 + 状态行 + 缓冲。 */
const MIN_ROWS = 12;
/** 太窄时不画完整布局：备用屏幕保留提示，旧版内联布局退回行式聊天。 */
const MIN_COLUMNS = 30;

const TITLE_ROW = 1;
const PATH_ROW = 2;
const TOP_DIVIDER_ROW = 3;
const LOG_TOP = 4;

/** 日志最多保留多少条逻辑行；视口只显示最后 N 行，旧记录丢弃。 */
const MAX_LOG_LINES = 2_000;

/** 流式增量最多每 40ms 重绘一次，避免每个 token 都扫一整屏。 */
const RENDER_INTERVAL_MS = 40;

/** 右对齐的模型名和统计与窗口右边缘之间留的呼吸空间，避免文字贴边难读。 */
const RIGHT_MARGIN = 2;

/** 拖动窗口时先记录最终尺寸，安静 75ms 后再重排，避免每个中间宽度都清屏。 */
const RESIZE_DEBOUNCE_MS = 75;

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

/** 交互式 TUI 启动时按系统 locale 定初始语言：中文系统用中文，其余用英文。 */
export function uiLanguageFromLocale(locale: string): UiLanguage {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
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
  kind?: "tool" | "thinking" | "activity" | "turn-status" | "activity-error" | "final-reply";
  activity?: ActivityGroup;
  tool?: ActivityTool;
  turn?: TurnActivity;
  /** 仅展示层使用；持久日志项的身份不随换行和活动展开改变。 */
  id?: number;
  /** 当前屏幕行在所属日志项内部的字符偏移；不会发送给模型。 */
  charOffset?: number;
}

interface ActivityTool {
  call: ToolCall;
  startedAt: number;
  endedAt?: number;
  result?: string;
  /** 第四层只改变真实工具输入/返回的显示，不改变 Tool result。 */
  detailsExpanded?: boolean;
  /** 来自 Workspace 成功提交前后的真实全文，只保留有界统一补丁，不复制原文件。 */
  diff?: { lines: string[]; truncated: boolean; unavailable?: boolean };
  /** 仅保留经过签名校验后的缩略图网格，不保存原始二进制到日志。 */
  image?: ImagePreview;
}

interface ActivityGroup {
  language: UiLanguage;
  tools: ActivityTool[];
  expanded: boolean;
  /** 模型没有阶段说明时，按真实工具事件生成一条事实性概述，不冒充模型原文。 */
  fallbackOverview?: boolean;
  finished?: boolean;
}

interface TurnActivity {
  language: UiLanguage;
  startedAt: number;
  endedAt?: number;
  /** 运行时展开，结束后自动收起；旧轮次可以由键盘独立展开。 */
  expanded: boolean;
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

/** auto 优先独立屏幕；always 强制独立屏幕；never 使用兼容行式聊天。 */
export type TuiScreenMode = "auto" | "always" | "never";

/** 环境变量的错误必须显式报告，不能悄悄回到另一种终端行为。 */
export function parseTuiScreenMode(value: string | undefined): TuiScreenMode {
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "always" || value === "never") return value;
  throw new Error(`invalid AGENT_TUI_SCREEN "${value}" (expected: auto, always, never)`);
}

/** mono 只保留用户消息任务条的颜色；full 恢复状态与提示的层次配色。 */
export type TuiColorMode = "full" | "mono";

/** 默认 mono：其余文字保持终端默认色，只有用户消息任务条上色。 */
export function parseTuiColorMode(value: string | undefined): TuiColorMode {
  if (value === undefined || value === "" || value === "mono") return "mono";
  if (value === "full") return value;
  throw new Error(`invalid AGENT_TUI_COLOR "${value}" (expected: full, mono)`);
}

/**
 * auto 只在有明确终端能力线索时启用备用屏幕；TERM=linux/vt100/ansi 等
 * 虽然不是 dumb，也不能据此推断实现了 1049 备用屏幕。
 * Windows 只信任现代宿主标记，不把通用的 TERM=xterm 当作能力证明。
 */
function supportsAlternateScreen(): boolean {
  const term = process.env.TERM?.toLowerCase() ?? "";
  const knownTerm = /^(?:xterm|screen|tmux|rxvt|alacritty|wezterm|kitty|foot|st|konsole)(?:-|$)/.test(term);
  // TERM 显式声明了未知或低能力终端时，即使 WT_SESSION 被上层 Shell 继承也不要猜测。
  if (term !== "" && !knownTerm) return false;
  if (process.platform === "win32") {
    return Boolean(process.env.WT_SESSION?.trim()) ||
      process.env.TERM_PROGRAM === "vscode" ||
      process.env.TERM_PROGRAM === "WezTerm";
  }
  // 普通 POSIX TTY 的 TERM 未知时宁可行式输出；always 是用户明确的强制覆盖。
  return knownTerm;
}

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
  /** auto 只为识别出的兼容终端启用备用屏幕；能力不明时退回行式输出。 */
  screenMode?: TuiScreenMode;
  /** 层次配色开关；默认 mono，只保留用户消息任务条的颜色，其余文字纯白。 */
  colorMode?: TuiColorMode;
  /** 测试可以显式关掉颜色；生产代码不传，按终端能力自动判断。 */
  color?: boolean;
  /** 初始界面语言；缺省英文，交互式 CLI 按系统 locale 传入；之后仍按任务正文切换。 */
  language?: UiLanguage;
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

  /** auto 无法确认备用屏幕能力时，只在启动时向交互式终端告知一次。 */
  private readonly compatibilityNotice: boolean;

  /** 独立屏幕由 TUI 独占：缩放不会把中间帧写入 Shell 滚动历史。 */
  private readonly ownedScreen: boolean;

  private altScreenActive = false;

  /** 未进入 start 的对象只能释放资源，不能发出任何终端控制序列。 */
  private started = false;

  /** 全屏清理和差分行必须在同一同步帧中输出。 */
  private clearBeforeNextFrame = false;

  private resizeTimer?: NodeJS.Timeout;

  private readonly flowInput: boolean;

  private readonly onPermissionChange?: (mode: PermissionMode) => void;

  /** Shift+Tab 进入 full-access 前需要再按一次确认，误按不会提升权限。 */
  private fullAccessConfirmationPending = false;

  private readonly terminalControls: boolean;

  private readonly style: Style;

  private readonly glyphs: Glyphs;

  /** 最近一次用户任务的主要语言；命令和模型输出不触发语言切换。启动值由 CLI 按系统 locale 传入。 */
  private uiLanguage: UiLanguage;

  private columns: number;

  private rows: number;

  private inputRow: number;

  private boxTopRow: number;

  private boxBottomRow: number;

  private statusRow: number;

  private logHeight: number;

  private readonly rl: Interface;

  /** Alternate-screen SGR 鼠标事件在进入 readline 前必须过滤，否则坐标会污染输入框。 */
  private readonly mouseInput?: Transform;

  private mousePartial = "";

  /** 允许 ESC、ESC[ 被拆包，同时不让单独按下的 Esc 永久卡住。 */
  private mousePartialTimer?: NodeJS.Timeout;

  /** 每次渲染确定屏幕箭头所在的实际单元格，鼠标点击不猜测文本位置。 */
  private readonly mouseTargets = new Map<number, { column: number; turn?: TurnActivity; group?: ActivityGroup; tool?: ActivityTool }>();

  private permissionMode: PermissionMode;

  private stats?: AgentSessionStats;

  /** 已经收尾的日志行（已转义的单行文本 + 语义色）；ID 只存在于本次 TUI。 */
  private readonly log: LogLine[] = [];

  private nextLogId = 1;

  /** 正在运行的工具调用行：结果到达时原地替换，而不是再追一行。 */
  private readonly pendingTools = new Map<string, LogLine>();

  /** 每次真实 AI 阶段说明后的工具形成一个独立组；不编造模型说明。 */
  private readonly activityPending = new Map<string, ActivityTool>();

  private currentTurn?: TurnActivity;

  private activeActivity?: ActivityGroup;

  /** Ctrl+E / Ctrl+O / Ctrl+I 分别控制轮次、阶段和工具详情。 */
  private turnFocus = -1;

  private activityFocus = -1;

  private toolFocus = -1;

  /** 仅标注 CLI 已确认的最终回复，折叠执行过程时仍独立展示。 */
  private finalResponsePending = false;

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

  /** 与 Thinking 共用一个状态位；不会新增历史日志或第二层错误描述。 */
  private retryStatus?: { attempt: number; maxRetries: number };

  private thinkingStartedAt = 0;

  private thinkingTimer?: NodeJS.Timeout;

  /** 只量测 UI 中本次 Run 的经过时间，不参与 Kernel 的预算或统计。 */
  private runStartedAt?: number;

  private runToolResults = 0;

  /** 历史滚动偏移：0 = 跟随最新；正数 = 向上查看旧记录。 */
  private scrollOffset = 0;

  /** 上一帧的换行后总行数；滚动时新输出只增加偏移，不把视口拉回底部。 */
  private lastTotalLines = 0;

  /** 缩放前视口顶端的稳定日志 ID + 内容偏移，不受前面的展开或裁剪影响。 */
  private resizeAnchor?: { entryId: number; charOffset: number };

  /** 当锚点对应的日志被裁剪时，状态栏提示一次，而不是默默跳到新回复。 */
  private historyTrimmedNotice = false;

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
    this.uiLanguage = options.language ?? "en";
    this.flowInput = options.flowInput ?? false;
    this.onPermissionChange = options.onPermissionChange;
    this.terminalControls = process.env.TERM !== "dumb";

    const initialColumns = options.columns !== undefined && options.columns > 0 ? options.columns : 80;
    const initialRows = options.rows !== undefined && options.rows > 0 ? options.rows : 24;
    const screenMode = options.screenMode ?? "auto";
    const tty = options.interactive && isTerminalOutput(options.output);
    const canDraw = tty && this.terminalControls;
    this.ownedScreen = options.layout !== false && canDraw &&
      (screenMode === "always" || (screenMode === "auto" && supportsAlternateScreen()));
    this.compatibilityNotice = screenMode === "auto" && tty && !this.ownedScreen && options.layout === undefined;
    // 生产环境不支持独立屏幕时直接使用行式模式；显式 layout 仅供旧版渲染回归测试。
    this.fixedLayoutAllowed = options.layout ?? this.ownedScreen;
    this.layout = this.fixedLayoutAllowed &&
      (this.ownedScreen || (initialColumns >= MIN_COLUMNS && initialRows >= MIN_ROWS));

    this.columns = initialColumns;
    this.rows = initialRows;
    this.inputRow = 0;
    this.boxTopRow = 0;
    this.boxBottomRow = 0;
    this.statusRow = 0;
    this.logHeight = 1;
    this.recomputeGeometry();

    const colorMode = options.colorMode ?? "mono";
    const colorEnabled =
      this.fixedLayoutAllowed &&
      (options.color ??
        (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"));
    this.style = new Style(colorEnabled, prefersRichColor(), colorMode === "mono");
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
    // readline 不认识 SGR 1006：若让鼠标报告直接进入它，坐标会被插入用户的任务输入。
    // 只为拥有备用屏幕的终端启用输入过滤，其余终端保持原始输入流不变。
    if (this.ownedScreen) {
      this.mouseInput = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          try { done(null, this.filterMouseInput(chunk)); } catch (error) { done(error as Error); }
        },
      });
      const input = this.mouseInput as Transform & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void };
      const source = options.input as NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void };
      input.isTTY = source.isTTY;
      if (typeof source.setRawMode === "function") input.setRawMode = (enabled) => source.setRawMode!(enabled);
      options.input.pipe(this.mouseInput);
    }
    this.rl = createInterface({ input: this.mouseInput ?? options.input, output: editorOutput, terminal: options.interactive });

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

      // Ctrl+E 翻阅任务节点：终端没有可点击箭头，键盘直接展开/收起最近轮次。
      if (key?.ctrl && name === "e" && this.layout) {
        const turns = this.log.flatMap((line) =>
          line.kind === "turn-status" && line.turn !== undefined ? [line.turn] : []);
        if (turns.length > 0) {
          this.turnFocus = this.turnFocus <= 0 ? turns.length - 1 : this.turnFocus - 1;
          this.captureHistoryAnchor();
          turns[this.turnFocus]!.expanded = !turns[this.turnFocus]!.expanded;
          this.renderNow();
        }
        return;
      }

      // Ctrl+G 展开具体工具的真实调用和结果；每按一次定位上一条工具。
      if (key?.ctrl && name === "g" && this.layout) {
        const tools = this.log.flatMap((line) =>
          line.kind === "activity" && line.activity !== undefined
            ? line.activity.tools.map((tool) => ({ tool, group: line.activity!, turn: line.turn }))
            : []);
        if (tools.length > 0) {
          this.toolFocus = this.toolFocus <= 0 ? tools.length - 1 : this.toolFocus - 1;
          this.captureHistoryAnchor();
          const chosen = tools[this.toolFocus]!;
          chosen.tool.detailsExpanded = !chosen.tool.detailsExpanded;
          chosen.group.expanded = true;
          if (chosen.turn !== undefined) chosen.turn.expanded = true;
          this.renderNow();
        }
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
          // 浏览旧记录时展开详情也不能把视口跳到最新消息。
          this.captureHistoryAnchor();
          group.expanded = !group.expanded;
          const owner = this.log.find((line) => line.kind === "activity" && line.activity === group)?.turn;
          if (owner !== undefined) owner.expanded = true;
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
      const editorInput = this.mouseInput ?? options.input;
      emitKeypressEvents(editorInput);
      (editorInput as NodeJS.EventEmitter).on("keypress", this.onKeypress);
      // 测试夹具会显式向原始 input 发送键事件；生产运行只由 editorInput 解析字节。
      if (this.mouseInput) (options.input as NodeJS.EventEmitter).on("keypress", this.onKeypress);
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

  /**
   * 从原始终端字节中取走 SGR 鼠标报告，不能让 readline 将“0;20;9M”加入任务。
   * 用 latin1 往返只为保留 UTF-8 原始字节；残缺鼠标序列只暂存有限字符。
   */
  private filterMouseInput(chunk: Buffer): Buffer {
    if (this.mousePartialTimer !== undefined) {
      clearTimeout(this.mousePartialTimer);
      this.mousePartialTimer = undefined;
    }
    const data = this.mousePartial + chunk.toString("latin1");
    this.mousePartial = "";
    let output = "";
    let cursor = 0;
    const prefix = "\x1b[<";
    const pattern = /^\x1b\[<(\d{1,3});(\d{1,4});(\d{1,4})([Mm])/;
    while (cursor < data.length) {
      const at = data.indexOf("\x1b", cursor);
      if (at < 0) {
        output += data.slice(cursor);
        break;
      }
      output += data.slice(cursor, at);
      const remainder = data.slice(at);
      // 终端可能在 ESC 或 ESC[ 处分片；不能提前把这些鼠标前缀交给 readline。
      if (prefix.startsWith(remainder) && remainder.length < prefix.length) {
        this.mousePartial = remainder;
        break;
      }
      if (remainder.startsWith(prefix)) {
        const match = pattern.exec(remainder);
        if (match !== null) {
          this.handleMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4] === "M");
          cursor = at + match[0].length;
          continue;
        }
        if (remainder.length <= 40 && /^\x1b\[<[0-9;]*$/.test(remainder)) {
          this.mousePartial = remainder;
          break;
        }
        // 畸形或超长鼠标报告不应变成用户任务；跳过直到消息终止符。
        const end = remainder.search(/[Mm]/);
        if (end >= 0 && end < 256) {
          cursor = at + end + 1;
          continue;
        }
        if (remainder.length <= 40) {
          this.mousePartial = remainder;
          break;
        }
        cursor = at + Math.min(remainder.length, 256);
        continue;
      }
      // 非鼠标的 ANSI/普通 Esc 保持原样，交由 readline 处理键盘。
      output += "\x1b";
      cursor = at + 1;
    }
    if (this.mousePartial !== "") {
      this.mousePartialTimer = setTimeout(() => {
        const pending = this.mousePartial;
        this.mousePartial = "";
        this.mousePartialTimer = undefined;
        // 孤立 ESC 仍应保留键盘语义；不完整鼠标坐标则直接丢弃。
        if (!this.closed && pending !== "" && !pending.startsWith(prefix)) {
          this.mouseInput?.push(Buffer.from(pending, "latin1"));
        }
      }, 80);
      this.mousePartialTimer.unref();
    }
    return Buffer.from(output, "latin1");
  }

  private handleMouse(button: number, column: number, row: number, pressed: boolean): void {
    if (!this.layout || !this.started || this.closed) return;
    if ((button & 64) !== 0 && pressed) {
      if ((button & 3) === 0 || (button & 3) === 1) {
        this.scrollWheel((button & 3) === 0 ? "up" : "down");
      }
      return;
    }
    // 鼠标绝不替代权限审批：审批时只有菜单键盘能够作出授权决定。
    if (this.approvalMenuActive || !pressed || button !== 0) return;
    const target = this.mouseTargets.get(row);
    if (target === undefined || target.column !== column) return;
    this.captureHistoryAnchor();
    if (target.tool !== undefined) {
      target.tool.detailsExpanded = !target.tool.detailsExpanded;
    } else if (target.group !== undefined) {
      target.group.expanded = !target.group.expanded;
    } else if (target.turn !== undefined) {
      target.turn.expanded = !target.turn.expanded;
    }
    this.renderNow();
  }

  /** 鼠标滚轮一次翻三行，比 PageUp 整屏跳转更容易定位上下文。 */
  private scrollWheel(direction: "up" | "down"): void {
    this.scrollOffset = Math.max(0, Math.min(this.maxScroll(),
      this.scrollOffset + (direction === "up" ? 3 : -3)));
    this.redrawKeepingInput();
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

  /** 画第一帧；支持备用屏幕的终端在关闭时会完整恢复原有 Shell。 */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    if (this.ownedScreen) {
      // 独立的备用屏幕隔离应用帧与 Shell 历史；退出时一定执行对应的 Leave。
      // X10 按钮/滚轮事件 + SGR 1006 坐标；不启用运动跟踪，避免高频重绘。
      this.output.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
      this.altScreenActive = true;
    }
    if (this.layout) {
      this.clearBeforeNextFrame = true;
      this.renderNow();
      if (!this.ownedScreen && this.columns >= MIN_COLUMNS && this.rows >= MIN_ROWS) this.moveToInput();
      return;
    }

    if (this.interactive) {
      if (this.compatibilityNotice) {
        this.logLine("Terminal compatibility mode / 终端兼容模式：line-by-line output");
      }
      this.logLine(this.formatStatus());
      this.logLine(this.formatStatsLine());
      return;
    }

    this.logLine(`model: ${singleLine(this.model)}`);
    this.logLine(`workspace: ${singleLine(this.workspace)}`);
    this.logLine(`permission: ${this.permissionMode}`);
  }

  /** 将当前视口顶端绑定到稳定的展示日志 ID；展开活动和 resize 共用同一规则。 */
  private captureHistoryAnchor(): void {
    if (!this.ownedScreen || this.resizeAnchor !== undefined || this.scrollOffset === 0) return;
    const oldLines = this.wrappedDisplayLines();
    const first = oldLines[Math.max(0, oldLines.length - this.logHeight - this.scrollOffset)];
    if (first?.id !== undefined) {
      this.resizeAnchor = { entryId: first.id, charOffset: first.charOffset ?? 0 };
      // 锚点已决定目标位置，后续不能再按新增行数累加 scrollOffset。
      this.lastTotalLines = 0;
    }
  }

  /** 终端尺寸变化后重新排版；保持当前输入行和滚动位置。 */
  private resize(columns: number, rows: number): void {
    if (!this.started || !this.fixedLayoutAllowed || this.closed) return;

    const hadLayout = this.layout;
    // 只捕获本轮 resize 的第一帧；后续拖动和流式事件都沿用同一个锚点。
    if (this.resizeTimer === undefined) this.captureHistoryAnchor();
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    if (this.ownedScreen) {
      // 只记录尺寸变化，流式文本和工具状态继续进内存日志，不向终端写中间宽度的帧。
      if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = undefined;
        if (this.closed) return;
        // 个别终端在最后一个 resize 事件之后才稳定 columns/rows，最终绘制前再采样。
        const stream = this.output as NodeJS.WriteStream;
        if (typeof stream.columns === "number") this.columns = Math.max(1, stream.columns);
        if (typeof stream.rows === "number") this.rows = Math.max(1, stream.rows);
        this.inputDirty = true;
        this.lastFrame = [];
        this.lastTotalLines = 0;
        this.clearBeforeNextFrame = true;
        this.renderNow();
      }, RESIZE_DEBOUNCE_MS);
      this.resizeTimer.unref?.();
      return;
    }
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
    this.clearBeforeNextFrame = true;
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

  /** 权限值是策略标识，只有 UI 标签按最近一次用户任务的语言翻译，不影响命令和实际授权。 */
  permissionLabel(mode: PermissionMode): string {
    switch (mode) {
      case "read-only": return this.uiText(mode, "只读模式");
      case "workspace-write": return this.uiText(mode, "工作区读写");
      case "full-access": return this.uiText(mode, "完全访问");
    }
  }

  /** 用于 CLI 的会话命令提示，语言跟随最近一轮任务。 */
  helpText(permissionModes: string): string {
    const commands = this.uiText(
      `commands: /exit  quit · /reset  clear the transcript and start a new Agent · /help  show this\n          /permission [mode]  show or switch permission (${permissionModes})`,
      `命令：/exit  退出 · /reset  清空会话并重建 Agent · /help  显示帮助\n      /permission [模式]  查看或切换权限（${permissionModes}）`,
    );
    // 折叠箭头是终端字符，不是可点击组件；只有固定布局支持这些快捷键。
    const shortcut = this.uiText(
      "timeline: Ctrl+E turns · Ctrl+O activity groups · Ctrl+G tool details · PageUp/PageDown scroll",
      "时间线：Ctrl+E 任务 · Ctrl+O 活动组 · Ctrl+G 工具详情 · PageUp/PageDown 浏览",
    );
    const mouse = this.ownedScreen ? `\n${this.uiText(
      "mouse: click trailing arrows to fold/unfold · wheel scrolls three lines",
      "鼠标：点击文字末尾箭头展开/收起 · 滚轮每次滚动三行",
    )}` : "";
    return this.layout ? `${commands}\n${shortcut}${mouse}` : commands;
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

  /** 只有真实发生网络重试时才会调用，次数来自 Agent，而不是 UI 猜测。 */
  setRetrying(attempt: number, maxRetries: number): void {
    if (!this.thinking) return;
    this.retryStatus = { attempt, maxRetries };
    const status = this.uiText(
      `Reconnecting... ${attempt}/${maxRetries}`,
      `正在重新连接 ${attempt}/${maxRetries}`,
    );
    if (this.layout) this.renderNow();
    else if (this.interactive && this.terminalControls) this.writeRaw(`\r\x1b[2K${status}`);
    else this.logLine(status, "warning");
  }

  private stopThinking(): void {
    const wasThinking = this.thinking;
    this.thinking = false;
    this.retryStatus = undefined;
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
    const arrow = this.foldArrow(turn.expanded);
    if (turn.outcome === "completed") return {
      text: `  ${this.glyphs.success} ${zh ? "已完成" : "Completed"} · ${zh ? "用时" : "in"} ${duration}  ${arrow}`,
      tone: "success",
    };
    if (turn.outcome === "failed" || turn.outcome === "cancelled") {
      const outcome = turn.outcome === "failed" ? (zh ? "执行失败" : "Failed") : (zh ? "已取消" : "Cancelled");
      return { text: `  ${turn.outcome === "failed" ? this.glyphs.error : this.glyphs.notRun} ${outcome} · ${zh ? "用时" : "after"} ${duration}  ${arrow}`,
        tone: turn.outcome === "failed" ? "error" : "muted" };
    }
    if (turn.outcome === "preparing") return { text: `  ${this.glyphs.running} ${zh ? "准备执行" : "Preparing"}  ${arrow}`, tone: "muted" };
    return { text: `  ${this.glyphs.running} ${zh ? "正在执行 · 已用时" : "Working · elapsed"} ${duration}  ${arrow}`, tone: "accent" };
  }

  /** 只在显示层拼接折叠指示符，始终位于对应文字后面。 */
  private foldArrow(expanded: boolean): string {
    return this.glyphs === UNICODE_GLYPHS ? (expanded ? "▾" : "▸") : (expanded ? "v" : ">");
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
    const ended = item.result !== undefined;
    const failure = ended ? this.activityFailureLine(item, group.language) : undefined;
    const unfinished = !ended && group.finished ? this.activityUnfinishedLine(item, group.language) : undefined;
    const result = ended ? toolResultLines(item.call, item.result!, this.glyphs, group.language) : [];
    const title = failure ?? unfinished ?? (!ended
      ? this.makeLogLine(`    ${this.glyphs.running} ${formatToolEvent(item.call, group.language)}`, "muted")
      : this.makeLogLine(result[0]!.text.replace(/^  /, "    ") +
        ` · ${formatActivityDuration(Math.max(0, (item.endedAt ?? Date.now()) - item.startedAt), group.language)}`,
        result[0]!.tone));
    title.kind = failure?.kind ?? unfinished?.kind ?? "tool";
    title.text += `  ${this.foldArrow(item.detailsExpanded === true)}`;
    title.tool = item;
    const lines: LogLine[] = [title];
    // 摘要始终保留成功/失败事实；详情层才展开原始结果。
    if (ended && failure === undefined && result[1] !== undefined) {
      lines.push(this.makeLogLine(`  ${result[1].text}`, result[1].tone));
      // read 的截断警告由 toolResultLines 根据真实尾注生成，不能在活动层漏掉。
      // 即使工具原始输出默认收起，用户也必须知道读取结果并不完整。
      for (const warning of result.slice(2)) {
        lines.push(this.makeLogLine(`  ${warning.text}`, warning.tone));
      }
      if (item.diff?.unavailable === true) {
        lines.push(this.makeLogLine(`      ${this.uiText(
          "Diff preview unavailable: write succeeded, but the file exceeds 2 MiB or the previous snapshot could not be read.",
          "Diff 预览已降级：写入成功，但文件超过 2 MiB 或旧内容无法安全读取。")}`, "warning"));
      }
    }
    if (!ended && !group.finished && !this.approvalBlocksRunning) {
      const awaitingResult = item.call.function.name === "shell" ||
        item.call.function.name === "write" || item.call.function.name === "edit";
      lines.push(this.makeLogLine(`      ${this.glyphs.boxBottomLeft} ${awaitingResult
        ? this.uiText("Awaiting tool result...", "等待工具结果...")
        : this.uiText("Running...", "运行中...")}`, "muted"));
    }
    if (!item.detailsExpanded) return lines;
    const raw = ended ? item.result! : "";
    // 真实参数和返回来自 ToolCall/ToolResult；不从编辑路径猜测 Diff 或图片预览。
    lines.push(this.makeLogLine(`      ${this.uiText("Call:", "调用：")} ${formatToolCall(item.call)}`, "muted"));
    // 第四层明确提供真实参数摘录；上面的 Call 只是简短标题，不是完整参数。
    // 输入可能包含大块文件内容，限制解析/展示规模，避免每帧重排拖慢终端。
    const rawArguments = item.call.function.arguments || "{}";
    let argumentText = rawArguments.slice(0, 12_000);
    if (rawArguments.length <= 12_000) {
      try { argumentText = JSON.stringify(JSON.parse(rawArguments), null, 2); } catch {
        // 不合法的参数仍展示实际收到的文字，不伪造结构。
      }
    }
    const argumentLines = splitDisplayLines(argumentText);
    lines.push(this.makeLogLine(`      ${this.uiText("Arguments (excerpt):", "原始参数（摘录）：")}`, "muted"));
    for (const line of argumentLines.slice(0, 12)) {
      lines.push(this.makeLogLine(`      ${this.glyphs.boxBottomLeft} ${clip(line, 160)}`, "muted"));
    }
    if (argumentLines.length > 12 || rawArguments.length > 12_000) {
      lines.push(this.makeLogLine(
        `      … ${this.uiText("arguments truncated for display", "参数过长，展示已截断")}`, "muted"));
    }
    if (ended && failure === undefined && item.image !== undefined) {
      const image = item.image;
      const size = image.width !== undefined && image.height !== undefined
        ? ` · ${image.width} × ${image.height}` : "";
      lines.push(this.makeLogLine(
        `      ${this.uiText("Actual image preview:", "真实图片预览：")} ${image.format}${size}`, "muted"));
      if (image.rows.length === 0) {
        lines.push(this.makeLogLine(`      ${this.uiText(
          "Image bytes verified; terminal thumbnail decoding is not supported for this format.",
          "已确认真实图片字节；此格式暂不支持终端文字缩略图解码。")}`, "warning"));
      } else {
        for (const row of image.rows) {
          lines.push(this.makeLogLine(`      │ ${row}`, "assistant"));
        }
      }
    }
    if (ended && failure === undefined && item.diff !== undefined && !item.diff.unavailable) {
      lines.push(this.makeLogLine(`      ${this.uiText("Committed unified diff:", "实际提交的 Unified Diff：")}`, "muted"));
      for (const text of item.diff.lines) {
        lines.push(this.makeLogLine(`      ${text}`,
          text.startsWith("+") && !text.startsWith("+++") ? "success"
            : text.startsWith("-") && !text.startsWith("---") ? "error" : "muted"));
      }
      if (item.diff.truncated) {
        lines.push(this.makeLogLine(`      … ${this.uiText("diff too large to display in full", "Diff 过大，终端预览已截断")}`, "warning"));
      }
    } else if (ended && failure === undefined && item.call.function.name === "edit") {
      // 未收到 Workspace 的提交快照时，仅展示真实请求片段，不冒充带行号的文件 Diff。
      try {
        const args: unknown = JSON.parse(item.call.function.arguments);
        if (isRecord(args) && typeof args.old_string === "string" && typeof args.new_string === "string") {
          lines.push(this.makeLogLine(`      ${this.uiText("Replacement fragments (not a full diff):", "替换片段（非完整 Diff）：")}`, "muted"));
          for (const line of splitDisplayLines(args.old_string).slice(0, 8)) {
            lines.push(this.makeLogLine(`      - ${clip(line, 180)}`, "error"));
          }
          for (const line of splitDisplayLines(args.new_string).slice(0, 8)) {
            lines.push(this.makeLogLine(`      + ${clip(line, 180)}`, "success"));
          }
        }
      } catch {
        // 参数格式不合法时保持工具原始结果，不为了装饰界面猜测编辑内容。
      }
    }
    for (const line of splitDisplayLines(raw).slice(0, 20)) {
      lines.push(this.makeLogLine(`      ${this.glyphs.boxBottomLeft} ${line}`, failure === undefined ? "muted" : "error"));
    }
    const count = splitDisplayLines(raw).length;
    if (count > 20) lines.push(this.makeLogLine(
      `      … ${count - 20} ${this.uiText("additional result lines", "行结果未展示")}`, "muted"));
    return lines;
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
    this.toolFocus = -1;
    this.turnFocus = -1;
    this.activityPending.clear();
    if (this.fixedLayoutAllowed) {
      // 上轮已折叠时，其结尾空行也被隐藏；补一条轮次外间距，避免新问题紧贴最终回复。
      if (this.currentTurn?.endedAt !== undefined && !this.currentTurn.expanded) {
        this.appendLog({ text: "", tone: "plain" });
      }
      this.currentTurn = { language: this.uiLanguage, startedAt: this.runStartedAt,
        expanded: true, outcome: "preparing", groups: [] };
      // 即使任务后来失败或被取消，旧轮标题也保留独立状态，不受新轮计时影响。
      if (this.layout) {
        this.stopThinking();
        this.commitAssistant();
      }
      if (show) this.pushTask(task);
      this.appendLog({ text: "", tone: "muted", kind: "turn-status", turn: this.currentTurn });
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

  /**
   * 每次模型请求开始时划清阶段边界。模型没有输出可见文字，也不能把下一次
   * 请求里的工具继续记进上一组；否则整轮过程会失去真实的执行顺序。
   * 同一次模型回复里的多个工具仍按原顺序归入同组。
   */
  beginModelRequest(): void {
    if (this.currentTurn?.endedAt === undefined && this.activeActivity?.tools.length) {
      this.activeActivity = undefined;
    }
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
  confirmAssistant(content: string | null, final = false): void {
    const confirmed = normalizeNewlines(content ?? "");
    if (final && this.layout && confirmed !== "") this.finalResponsePending = true;
    if (this.layout) {
      if (this.streamingText !== confirmed || (!this.assistantOpen && confirmed !== "")) {
        if (!this.assistantOpen && confirmed !== "") this.activeActivity = undefined;
        this.streamingText = confirmed;
        this.assistantOpen = confirmed !== "";
      }
      // 确认无正文时也要重画，否则屏幕最后一帧仍保留已丢弃的草稿。
      if (!this.assistantOpen) {
        this.renderNow();
        return;
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
  discardAssistantDraft(announce = true): void {
    if (!this.assistantOpen) return;
    const warning = this.uiText(
      "[stream interrupted: unconfirmed text discarded]",
      "【流式响应中断：未确认正文已丢弃】",
    );
    this.streamingText = "";
    this.assistantOpen = false;

    if (this.layout) {
      // 已分类的模型错误会显示一次明确原因；不要再叠加泛化的流式警告。
      if (announce) this.pushLog(warning, "warning");
      this.renderNow();
      return;
    }

    if (!this.assistantAtLineStart) this.writeRaw(this.newline());
    if (announce) this.writeRaw(`${escapeControlCharacters(warning)}${this.newline()}`);
    this.assistantAtLineStart = true;
  }

  /** 本阶段有模型可见说明时优先使用原文，不再用工具行为重复解释。 */
  private hasVisibleStageNarration(turn: TurnActivity): boolean {
    for (let index = this.log.length - 1; index >= 0; index--) {
      const line = this.log[index]!;
      if (line.turn !== turn || line.kind === "activity" || line.kind === "turn-status") break;
      if (line.tone === "assistant" && line.kind !== "final-reply" && line.text.trim() !== "") return true;
    }
    return false;
  }

  /**
   * 仅在 Workspace.edit 原子提交成功后才收到这份快照；全量对照算出真实行号。
   * UI 只保存有界补丁，不能把项目源代码另存到 Transcript 或用户历史任务。
   */
  recordEditDiff(callId: string, path: string, before: string | undefined, after: string | undefined, created = false): void {
    const item = this.activityPending.get(callId);
    if (item === undefined || (item.call.function.name !== "edit" && item.call.function.name !== "write")) return;
    item.diff = before === undefined || after === undefined
      ? { lines: [], truncated: false, unavailable: true }
      : committedEditDiff(path, before, after, created, item.call.function.name === "write");
    if (this.layout) this.renderNow();
  }

  /** 仅由获准 Workspace.read 提供原始字节；失败或未知格式不会生成虚假预览。 */
  recordImagePreview(callId: string, _path: string, bytes: Buffer): void {
    const item = this.activityPending.get(callId);
    if (item?.call.function.name !== "read") return;
    const preview = previewImage(bytes);
    if (preview === undefined) return;
    item.image = preview;
    if (this.layout) this.renderNow();
  }

  /** 工具调用开始：固定布局先写「正在运行」；结果到达时原地替换成 ✓/✗。 */
  toolCall(call: ToolCall): void {
    this.approvalBlocksRunning = false;
    this.setThinking(false);
    this.finishAssistant();
    // Shell/write/edit 的 ToolCall 发生在 Permission 检查之前，不能提前声称执行中。
    const needsPermission = ["shell", "write", "edit"].includes(call.function.name);
    this.setActivityState(needsPermission ? "working" : moodStateForTool(call));
    const turn = this.currentTurn;
    if (this.fixedLayoutAllowed && turn !== undefined && turn.endedAt === undefined) {
      let group = this.activeActivity;
      if (group === undefined) {
        // AI 的说明与其下方的 ↳ 摘要紧邻；通用 commitAssistant 会多留一个空行。
        if (this.log.at(-1)?.text === "" && this.log.at(-2)?.tone === "assistant") this.log.pop();
        group = { language: this.uiLanguage, tools: [], expanded: true,
          fallbackOverview: !this.hasVisibleStageNarration(turn) };
        turn.groups.push(group);
        this.activeActivity = group;
        // 非空锚点让下一段 AI 发言自动与本阶段之间留一行。
        this.appendLog({ text: "↳", tone: "muted", kind: "activity", activity: group });
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
      this.appendLog(line);
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
      for (const [position, line] of lines.entries()) {
        // 运行中的同一工具原地变为结果时，首行沿用原 ID，历史锚点无需跳转。
        line.id = index >= 0 && position === 0 ? pending?.id : this.nextLogId++;
      }
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
    // 先收尾可见正文，再决定折叠；没有通过 CLI 显式标记时也识别末尾的正式回复。
    if (this.layout) this.commitAssistant();
    // 失败与取消时尾部文字可能只是上一条阶段说明，不能冒充成功后的最终答复。
    if (!failed && !cancelled && this.currentTurn?.endedAt === undefined) this.markTrailingReply();
    this.stats = session;
    this.runStartedAt = undefined;
    this.retryStatus = undefined;

    if (this.currentTurn !== undefined && this.currentTurn.endedAt === undefined) {
      this.currentTurn.endedAt = Date.now();
      this.currentTurn.outcome = cancelled ? "cancelled" : failed ? "failed" : "completed";
      this.currentTurn.expanded = false;
      // 结束后自动收起整轮时间线；原始事件保留在 TUI 的内存日志中。
      for (const group of this.currentTurn.groups) {
        group.expanded = false;
        group.finished = true;
      }
      this.activityFocus = -1;
      this.toolFocus = -1;
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
    if (this.started) this.setThinking(false);
    if (this.activityTimer !== undefined) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.resizeTimer !== undefined) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }
    this.renderScheduled = false;

    if (this.started) {
      if (this.layout) {
        this.commitAssistant();
        this.renderNow();
      } else {
        this.setThinking(false);
      }
    }

    this.closed = true;
    this.resizeAnchor = undefined;
    this.historyTrimmedNotice = false;
    this.controller.signal.removeEventListener("abort", this.onAbort);
    (this.input as NodeJS.EventEmitter).removeListener("keypress", this.onKeypress);
    this.mouseInput?.removeListener("keypress", this.onKeypress);
    if (this.mousePartialTimer !== undefined) {
      clearTimeout(this.mousePartialTimer);
      this.mousePartialTimer = undefined;
    }
    this.mousePartial = "";
    this.input.unpipe?.(this.mouseInput);
    this.mouseInput?.destroy();
    this.mouseTargets.clear();
    this.resizeSource?.removeListener("resize", this.onResize);
    this.rl.close();
    if (!this.started) return;
    this.setApprovalCursor(false);

    if (this.cursorStyleChanged) this.output.write("\x1b[0 q");
    if (this.altScreenActive) {
      // Leave 恢复终端原来的 Shell 画面；这里不额外向主屏幕输出聊天帧。
      this.output.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
      this.altScreenActive = false;
    } else if (this.layout) {
      // 旧版内联固定布局仅用于显式兼容测试。
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
    if (!this.started || !this.layout || this.closed || (this.ownedScreen && this.resizeTimer !== undefined)) return;

    if (this.ownedScreen && (this.columns < MIN_COLUMNS || this.rows < MIN_ROWS)) {
      // 小窗口保持在独立屏幕里，仅显示提示；不要退回逐行打印而制造重复历史。
      const message = clip(this.uiText("Terminal too small; resize to continue", "窗口太小，放大后继续"),
        Math.max(1, this.columns - 1));
      if (this.lastFrame.length === 1 && this.lastFrame[0] === message && !this.clearBeforeNextFrame) return;
      this.lastFrame = [message];
      this.clearBeforeNextFrame = false;
      // 极窄提示也是完整帧：清屏位于同步更新内，且避免中间帧残留。
      this.output.write(`\x1b[?2026h\x1b[?25l\x1b[2J\x1b[H${message}\x1b[?2026l`);
      return;
    }

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

    if (this.resizeAnchor !== undefined) {
      const { entryId, charOffset } = this.resizeAnchor;
      // 优先恢复相同日志项中最接近原文本位置的行，而不是原来的屏幕行号。
      let top = lines.findLastIndex((line) => line.id === entryId && (line.charOffset ?? 0) <= charOffset);
      if (top < 0) top = lines.findIndex((line) => line.id === entryId);
      if (top < 0) {
        // 原 ID 已被 2000 行裁剪：退到最靠近的存活项，给用户明确提示。
        top = lines.findIndex((line) => line.id !== undefined && line.id > entryId);
        if (top < 0) top = lines.findLastIndex((line) => line.id !== undefined);
        // 若只是手动收起了该日志所在的任务，并非真的被裁剪，不显示误导性警告。
        if (!this.log.some((entry) => entry.id === entryId)) this.historyTrimmedNotice = true;
      }
      if (top >= 0) this.scrollOffset = Math.max(0, lines.length - this.logHeight - top);
      this.resizeAnchor = undefined;
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
    this.mouseTargets.clear();
    // v0.3：对话从视口顶部开始，内容不足一屏时空白留在下方，不再贴底。
    for (let index = 0; index < this.logHeight; index++) {
      const line = visible[index];
      if (line !== undefined && /  [▸▾>v]$/.test(line.text) &&
          (line.kind === "turn-status" || line.kind === "activity" || line.tool !== undefined)) {
        this.mouseTargets.set(LOG_TOP + index, {
          column: displayWidth(line.text), turn: line.turn, group: line.activity, tool: line.tool,
        });
      }
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
    let frame = this.clearBeforeNextFrame ? "\x1b[2J\x1b[H" : "";
    this.clearBeforeNextFrame = false;
    for (let index = 0; index < rows.length; index++) {
      const forceInput = this.inputDirty && index === this.inputRow - 1;
      if (forceInput || this.lastFrame[index] !== rows[index]) {
        frame += `\x1b[${index + 1};1H\x1b[2K${rows[index]}`;
        this.lastFrame[index] = rows[index];
      }
    }
    this.inputDirty = false;
    if (!this.approvalMenuActive) frame += this.inputCursorSequence();
    // 同一帧通过一次输出写入，避免 Windows Terminal 在多次 write 之间露出半张画面。
    if (frame !== "") this.output.write(this.ownedScreen
      ? `\x1b[?2026h\x1b[?25l${frame}${this.approvalMenuActive ? "" : "\x1b[?25h"}\x1b[?2026l`
      : frame);
  }

  /** 确保审批结束、取消或 resize 后不会把终端光标留在隐藏状态。 */
  private setApprovalCursor(hidden: boolean): void {
    if (!this.terminalControls || this.approvalCursorHidden === hidden) return;
    this.output.write(hidden ? "\x1b[?25l" : "\x1b[?25h");
    this.approvalCursorHidden = hidden;
  }

  private paintLogLine(line: LogLine, width: number): string {
    const text = clip(line.text, width);
    if (line.tone === "user") return this.style.userMessage(padRight(text, width), `${this.glyphs.user} `);
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
    this.historyTrimmedNotice = false;
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
    // 提示符用默认色（mono 下就是普通白），只有占位提示保留灰色，避免和已输入内容混淆。
    return this.style.inputPrompt(prompt) +
      (placeholder ? this.style.inputHint(padRight(shown, room)) : padRight(shown, room));
  }

  /** 不用 ESC 7/8（conhost 上不一定可靠），按 prompt 宽度和已输入内容算回光标列。 */
  private inputCursorSequence(): string {
    const plainPrompt = this.promptText === COMMAND_PROMPT
      ? `${this.glyphs.user} `
      : singleLine(this.promptText);
    const before = escapeControlCharacters(this.rl.line.slice(this.inputOffset, this.rl.cursor));
    const column = Math.min(this.columns, 1 + displayWidth(plainPrompt) + displayWidth(before));
    return `\x1b[${this.inputRow};${column}H`;
  }

  private scheduleInputChrome(): void {
    if (!this.layout || !this.promptActive || this.closed) return;
    setImmediate(() => {
      if (!this.closed) this.renderNow();
    });
  }

  /** 没有工具跟在后面的末尾模型正文属于正式答复，不能被完成后的折叠隐藏。 */
  private markTrailingReply(): void {
    const turn = this.currentTurn;
    if (turn === undefined) return;
    let end = this.log.length - 1;
    while (end >= 0 && this.log[end]?.text === "" && this.log[end]?.turn === turn) end--;
    let start = end;
    while (start >= 0 && this.log[start]?.tone === "assistant" && this.log[start]?.turn === turn) start--;
    for (let index = start + 1; index <= end; index++) {
      const line = this.log[index];
      if (line !== undefined) line.kind = "final-reply";
    }
  }

  private commitAssistant(): void {
    if (!this.assistantOpen) return;
    this.pushBlank();
    for (const line of this.assistantDisplayLines()) {
      this.appendLog({ text: line, tone: "assistant",
        kind: this.finalResponsePending ? "final-reply" : undefined });
    }
    this.finalResponsePending = false;
    this.streamingText = "";
    this.assistantOpen = false;
    this.pushBlank();
    this.trimLog();
  }

  /**
   * 固定布局把 Markdown 代码块围栏（``` 或 ```lang）隐藏起来，块内正文缩进并用
   * 一条竖线标出；行式兼容模式仍按原文输出（已经写出的字节无法撤回）。
   * 只改展示：Transcript、模型请求和工具结果都不受影响。
   */
  private assistantDisplayLines(): string[] {
    const safe = escapeControlCharacters(normalizeNewlines(this.streamingText));
    const parts = safe.split("\n");
    const display: string[] = [];
    let inCodeBlock = false;
    for (const part of parts) {
      if (part.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      display.push(inCodeBlock ? `${this.glyphs.boxVertical} ${part}` : part);
    }
    // 整条回复只有围栏时不能显示成空消息：退回原文，免得让人以为模型什么都没说。
    if (display.length === 0 && safe.trim() !== "") display.push(...parts);
    return display.map((line, index) =>
      index === 0 ? `${this.glyphs.assistant} ${line}` : `  ${line}`);
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
      this.appendLog(this.makeLogLine(line, tone));
    }
    this.trimLog();
  }

  /** 每条持久展示日志只分配一次 ID；动态台词不占号，也不影响 Agent Transcript。 */
  private appendLog(line: LogLine): void {
    line.id = this.nextLogId++;
    // 用户问题属于对话正文，不随过程折叠；其余事件归属于当前 Run。
    if (line.tone !== "user" && this.currentTurn?.endedAt === undefined) line.turn = this.currentTurn;
    this.log.push(line);
  }

  /** 所有进入固定布局日志的文本都在这里转义，避免工具/模型输出改写光标或颜色。 */
  private makeLogLine(text: string, tone: Tone): LogLine {
    return { text: escapeControlCharacters(text), tone };
  }

  private pushBlank(): void {
    if (this.log.length === 0) return;
    const last = this.log[this.log.length - 1];
    if (last.text !== "") this.appendLog({ text: "", tone: "plain" });
  }

  private trimLog(): void {
    const overflow = this.log.length - MAX_LOG_LINES;
    if (overflow > 0) this.log.splice(0, overflow);
  }

  private wrappedDisplayLines(): LogLine[] {
    const logical: LogLine[] = [];
    const pendingLines = new Set(this.pendingTools.values());
    // 一个持久 ID 可以展开成多条逻辑行；偏移累计的是本次展示内容，不是换行后的行号。
    const append = (entry: LogLine, children: LogLine[]): void => {
      let offset = 0;
      for (const line of children) {
        logical.push({ ...line, id: entry.id, charOffset: offset });
        offset += line.text.length + 1;
      }
    };
    for (const line of this.log) {
      if (line.kind === "turn-status" && line.turn !== undefined) {
        // 展开中的标题下保留旧布局的节奏；折叠后只占一行。
        const status = { ...this.turnStatusLine(line.turn), kind: "turn-status" as const, turn: line.turn };
        append(line, line.turn.expanded
          ? [status, { text: this.glyphs.divider.repeat(this.contentWidth()), tone: "muted" }]
          : [status]);
        continue;
      }
      // 完成后只隐藏这轮的过程，不折叠用户提问、最终正式回复和轮次外的错误。
      if (line.turn !== undefined && !line.turn.expanded && line.kind !== "final-reply") continue;
      if (line.kind === "activity" && line.activity !== undefined) {
        const group = line.activity;
        const children: LogLine[] = [];
        // 同一个阶段只有一条事实性概述；根据最近的实际操作原地更新，不向历史刷重复日志。
        if (group.fallbackOverview && group.tools.length > 0) {
          const current = [...group.tools].reverse().find((tool) => tool.result === undefined) ?? group.tools.at(-1)!;
          children.push({ text: escapeControlCharacters(`  ${this.glyphs.running} ${toolProgressOverview(
            current.call, current.result, group.language, group.finished === true,
            this.approvalMenuActive && current.call.function.name === "shell",
          )}`),
            tone: "info" });
        }
        children.push(
          { text: escapeControlCharacters(`  ${this.glyphs === UNICODE_GLYPHS ? "↳" : "+"} ${this.activitySummary(group)}  ${this.foldArrow(group.expanded)}`),
            tone: "muted", kind: "activity", activity: group },
        );
        if (group.expanded) {
          for (const item of group.tools) children.push(...this.activityToolLines(item, group));
        } else {
          // 收起后异常仍然可见；不能把拒绝、错误藏进成功摘要。
          for (const item of group.tools) {
            const failure = this.activityFailureLine(item, group.language);
            if (failure !== undefined) children.push(failure);
            else if (group.finished && item.result === undefined) children.push(this.activityUnfinishedLine(item, group.language));
          }
        }
        append(line, children);
        continue;
      }
      const children = [line];
      // 兼容没有 beginTurn 的旧调用；正常任务的 Running 从 ActivityGroup 派生。
      if (pendingLines.has(line) && !this.approvalBlocksRunning) {
        children.push({ text: `    ${this.glyphs.boxBottomLeft} ${this.uiText("Running...", "运行中...")}`, tone: "muted" });
      }
      append(line, children);
    }
    if (this.assistantOpen && this.currentTurn?.expanded !== false) {
      for (const line of this.assistantDisplayLines()) {
        logical.push({ text: line, tone: "assistant" });
      }
    }
    if (this.thinking && this.currentTurn?.expanded !== false) {
      if (this.retryStatus !== undefined) {
        const { attempt, maxRetries } = this.retryStatus;
        logical.push({ text: `  ${this.glyphs.running} ${this.uiText(
          `Reconnecting... ${attempt}/${maxRetries}`,
          `正在重新连接 ${attempt}/${maxRetries}`,
        )}`, tone: "warning" });
      } else {
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
      }
    } else if (this.currentTurn?.endedAt === undefined && this.currentTurn?.expanded !== false &&
               this.activityState !== undefined && this.activityState !== "preparing" &&
               !this.assistantOpen && !this.approvalMenuActive) {
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
      // 单行活动过长时保留末尾折叠箭头，不能因为裁剪而失去操作入口。
      const foldable = line.kind === "turn-status" || line.kind === "activity" || line.tool !== undefined;
      const arrow = foldable ? line.text.match(/  [▸▾>v]$/)?.[0] : undefined;
      const parts = foldable
        ? [arrow === undefined ? clip(line.text, width)
          : clip(line.text.slice(0, -arrow.length), width - displayWidth(arrow)) + arrow]
        : wrapLine(line.text, width, continuation);
      let offset = line.charOffset ?? 0;
      for (const [index, part] of parts.entries()) {
        wrapped.push({ text: part, tone: index > 0 && line.kind === "tool" ? "assistant" : line.tone,
          kind: index === 0 ? line.kind : undefined, id: line.id, charOffset: offset,
          turn: line.turn, activity: line.activity, tool: index === 0 ? line.tool : undefined });
        // 续行的缩进只是展示前缀，不属于源文本。偏移因此不会随终端宽度漂移。
        const prefix = index === 0 ? "" : takeByWidth(continuation, Math.max(0, width - 2));
        offset += Math.max(0, part.length - prefix.length);
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
    const innerWidth = Math.max(1, width - RIGHT_MARGIN);
    const rawProject = this.project === "agent-Kernel" ? "agent-Kernel" : `agent-Kernel · ${singleLine(this.project)}`;
    const maxProject = Math.max(1, innerWidth - 2);
    const project = clip(rawProject, maxProject);
    const modelRoom = Math.max(0, innerWidth - displayWidth(project) - 1);
    const model = modelRoom > 0 ? clip(singleLine(this.model), modelRoom) : "";
    const gap = Math.max(1, innerWidth - displayWidth(project) - displayWidth(model));
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
    const historyWarning = this.historyTrimmedNotice
      ? this.uiText(" [history truncated]", "【历史已截断】") : "";
    const permissionLabel = this.permissionLabel(this.permissionMode);
    const baseLabel = (this.scrollOffset > 0
      ? `${scrollPrefix} · ${permissionLabel}`
      : permissionLabel) + historyWarning;
    const shortcut = this.onPermissionChange !== undefined && this.interactive
      ? this.uiText(" (shift-tab to cycle)", "（Shift+Tab 切换）") : "";
    let left = this.fullAccessConfirmationPending
      ? this.uiText("Confirm full-access: Shift+Tab again · Esc cancel", "确认完全访问：再次按 Shift+Tab · Esc 取消")
      : baseLabel + shortcut;
    const innerWidth = Math.max(1, width - RIGHT_MARGIN);
    let right = this.formatSessionStats(innerWidth >= 60);

    // 优先保留快捷键提示和完整统计，空间不足时再逐级缩短。
    if (displayWidth(left) + displayWidth(right) + 1 > innerWidth) {
      right = this.formatSessionStats(false);
    }
    if (displayWidth(left) + displayWidth(right) + 1 > innerWidth && !this.fullAccessConfirmationPending) {
      left = baseLabel;
      if (this.scrollOffset > 0 && displayWidth(left) + displayWidth(right) + 1 > innerWidth) left = scrollPrefix;
    }
    if (displayWidth(left) + displayWidth(right) + 1 > innerWidth) {
      const requests = formatNumber(this.stats?.requests ?? 0);
      const lower = (this.stats?.usage.unknown ?? 0) > 0 ? ">=" : "";
      right = `${requests}r ${lower}${formatNumber(this.stats?.usage.totalTokens ?? 0)}tok`;
    }

    const rightText = clip(right, Math.max(1, innerWidth));
    const leftText = clip(left, Math.max(1, innerWidth - displayWidth(rightText) - 1));
    const gap = Math.max(1, innerWidth - displayWidth(leftText) - displayWidth(rightText));
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

  private formatStatus(): string {
    const prefix = `${this.uiText("model", "模型")} ${clip(singleLine(this.model), 24)} | ${this.uiText("permission", "权限")} ${this.permissionLabel(this.permissionMode)} | ${this.uiText("workspace", "工作目录")} `;
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

/** 16 色或 256 色的极简样式；mono 或无声终端只返回原文（用户消息任务条除外）。 */
class Style {
  private readonly enabled: boolean;

  private readonly rich: boolean;

  private readonly mono: boolean;

  private readonly palette: Record<Tone, string>;

  constructor(enabled: boolean, rich: boolean, mono = false) {
    this.enabled = enabled;
    this.rich = rich;
    this.mono = mono;
    this.palette = rich ? RICH_PALETTE : BASIC_PALETTE;
  }

  /**
   * 用户消息整行：Claude Code 风格任务条——深灰底色、灰色前缀、白色粗体正文。
   * 先叠一层 16 色退化（亮黑底 + 亮白粗体），能认 256 色的终端再用精确颜色覆盖；
   * 这样传统 conhost 和 Windows Terminal 都能一眼看出「这一行是用户发的」。
   */
  userMessage(text: string, marker = ""): string {
    if (!this.enabled || text === "") return text;
    const markerPaint = "\x1b[37;100m\x1b[38;5;246;48;5;237m";
    const bodyPaint = "\x1b[1;97;100m\x1b[38;5;255;48;5;237m";
    if (marker !== "" && text.startsWith(marker)) {
      return `${markerPaint}${marker}${bodyPaint}${text.slice(marker.length)}\x1b[0m`;
    }
    return `${bodyPaint}${text}\x1b[0m`;
  }

  paint(tone: Tone, text: string): string {
    if (!this.enabled || this.mono || text === "" || tone === "plain") return text;
    return `\x1b[${this.palette[tone]}m${text}\x1b[0m`;
  }

  /**
   * 输入行提示符：mono 模式用终端默认色（普通白），full 模式才用灰色强调。
   * 颜色关掉的终端直接返回原文。
   */
  inputPrompt(text: string): string {
    if (!this.enabled || this.mono || text === "") return text;
    return `\x1b[${this.palette.muted}m${text}\x1b[0m`;
  }

  /**
   * 输入行的占位提示：mono 模式也保留灰色，维持「这里可以输入」的层次。
   * 已经输入的正文仍用终端默认色，避免和占位提示混在一起。
   */
  inputHint(text: string): string {
    if (!this.enabled || text === "") return text;
    return `\x1b[${this.palette.muted}m${text}\x1b[0m`;
  }

  bold(text: string): string {
    if (!this.enabled || this.mono || text === "") return text;
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


/** 工具事实兜底：只说明“正在/已做什么”，不猜测原因、发现或下一步计划。 */
function toolProgressOverview(
  call: ToolCall, result: string | undefined, language: UiLanguage,
  finished = false, awaitingApproval = false,
): string {
  const zh = language === "zh";
  let args: unknown;
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* 不猜测非法参数 */ }
  const params: Record<string, unknown> = isRecord(args) ? args : {};
  const name = call.function.name;
  const rawTarget = name === "shell" ? params.command
    : name === "grep" || name === "glob" ? params.pattern : params.path;
  const target = typeof rawTarget === "string" && rawTarget.trim() !== ""
    ? ` ${clip(oneLine(rawTarget), 54)}` : "";
  if (result === undefined && finished) {
    return zh ? `未收到${target || ` ${name}`}的操作结果，执行状态未知。`
      : `No result received for${target || ` ${name}`}; execution status unknown.`;
  }
  if (result === undefined && awaitingApproval) {
    return zh ? `正在等待命令${target}的执行授权。` : `Awaiting approval to run command${target}.`;
  }
  // ToolCall 先于 Permission 的判定到达 TUI；缺少 ToolResult 时不能宣称 Shell 已运行。
  if (result === undefined && name === "shell") {
    return zh ? `正在处理命令请求${target}。` : `Handling command request${target}.`;
  }
  if (result === undefined && (name === "write" || name === "edit")) {
    return zh ? `正在处理文件${name === "write" ? "写入" : "编辑"}请求${target}。`
      : `Handling file ${name === "write" ? "write" : "edit"} request${target}.`;
  }
  const status = result === undefined ? "running" : (() => {
    const summary = summarizeToolResult(call, result);
    return summary.denied ? "denied" : summary.notRun ? "not-run" : summary.failed ? "failed" : "done";
  })();
  if (status === "denied") return zh ? `未获授权，无法执行${target || ` ${name}`}。`
    : `Permission denied for${target || ` ${name}`}.`;
  if (status === "not-run") return zh ? `未执行${target || ` ${name}`}。`
    : `Did not run${target || ` ${name}`}.`;
  const verbs: Record<string, [string, string, string, string, string, string]> = {
    read: ["正在查看文件", "已读取文件", "读取文件失败", "Reading file", "Read file", "Could not read file"],
    grep: ["正在搜索代码", "已搜索代码", "搜索代码失败", "Searching code", "Searched code", "Code search failed"],
    glob: ["正在匹配文件", "已完成文件匹配", "匹配文件失败", "Matching files", "Matched files", "File matching failed"],
    ls: ["正在列出目录", "已列出目录", "列出目录失败", "Listing directory", "Listed directory", "Directory listing failed"],
    write: ["正在写入文件", "已写入文件", "写入文件失败", "Writing file", "Wrote file", "Could not write file"],
    edit: ["正在修改文件", "已修改文件", "修改文件失败", "Editing file", "Edited file", "Could not edit file"],
    shell: ["正在执行命令", "命令执行结束", "命令执行失败", "Running command", "Command finished", "Command failed"],
  };
  const forms = verbs[name] ?? ["正在调用工具", "工具调用已返回", "工具调用失败",
    "Calling tool", "Tool call returned", "Tool call failed"];
  const offset = zh ? 0 : 3;
  const position = status === "running" ? 0 : status === "failed" ? 2 : 1;
  const suffix = target || (verbs[name] === undefined ? ` ${clip(name, 40)}` : "");
  return `${forms[offset + position]}${suffix}${zh ? "。" : "."}`;
}

/** 记录每一行是否真实以换行结尾，避免丢失文件末尾的换行变化。 */
function unifiedFileLines(content: string): Array<{ text: string; ended: boolean }> {
  if (content === "") return [];
  const lines = content.split("\n");
  const ended = content.endsWith("\n");
  if (ended) lines.pop();
  return lines.map((text, index) => ({ text, ended: ended || index < lines.length - 1 }));
}

/** EOF 无换行的真实文件须附标准补丁标记。 */
function unifiedDiffBody(prefix: " " | "-" | "+", line: { text: string; ended: boolean }): string[] {
  return line.ended ? [`${prefix}${line.text}`] : [`${prefix}${line.text}`, "\\ No newline at end of file"];
}
/** 一次 edit 只有一个连续替换区域，因此可用共同前后缀准确产生完整统一补丁。 */
function committedEditDiff(
  path: string, before: string, after: string, created = false, multiHunk = false,
): { lines: string[]; truncated: boolean } {
  // 限制单个可视化的分配成本；不读取额外磁盘数据，也不保留原始文件全文。
  const MAX_SOURCE_CHARS = 320_000;
  const MAX_PREVIEW_LINES = 800;
  const MAX_PREVIEW_LINE_CHARS = 240;
  if (before.length > MAX_SOURCE_CHARS || after.length > MAX_SOURCE_CHARS) {
    return { lines: ["File change exceeds the bounded terminal diff preview limit."], truncated: true };
  }
  const oldLines = unifiedFileLines(before);
  const newLines = unifiedFileLines(after);
  if (before === after && !created) return { lines: [], truncated: false };
  const name = oneLine(path);
  const lines: string[] = [];
  let truncated = false;
  const append = (line: string): void => {
    if (line.length > MAX_PREVIEW_LINE_CHARS) {
      line = `${line.slice(0, MAX_PREVIEW_LINE_CHARS)} … [line truncated]`;
      truncated = true;
    }
    if (lines.length < MAX_PREVIEW_LINES) lines.push(line);
    else truncated = true;
  };
  const appendRange = (prefix: " " | "-" | "+", body: Array<{ text: string; ended: boolean }>): void => {
    for (const line of body) {
      if (lines.length >= MAX_PREVIEW_LINES) { truncated = true; break; }
      for (const item of unifiedDiffBody(prefix, line)) append(item);
    }
  };
  if (created) {
    append("--- /dev/null");
    append(`+++ b/${name}`);
    append(`@@ -0,0 +1,${newLines.length} @@`);
    appendRange("+", newLines);
    return { lines, truncated };
  }
  const same = (a: { text: string; ended: boolean }, b: { text: string; ended: boolean }): boolean =>
    a.text === b.text && a.ended === b.ended;
  // write 可能一次覆盖多个不连续的位置：基于有界 LCS 产生真实的多个 hunk，
  // 而不是用首尾公共片段把中间大量未改变的行全部画成删除再新增。
  if (multiHunk) {
    const oldCount = oldLines.length;
    const newCount = newLines.length;
    if (oldCount + newCount <= 2_400 && oldCount * newCount <= 800_000) {
      const table = Array.from({ length: oldCount + 1 }, () => new Uint32Array(newCount + 1));
      for (let i = oldCount - 1; i >= 0; i--) {
        for (let j = newCount - 1; j >= 0; j--) {
          table[i]![j] = same(oldLines[i]!, newLines[j]!) ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
        }
      }
      const operations: Array<{ mark: " " | "-" | "+"; line: { text: string; ended: boolean } }> = [];
      let i = 0;
      let j = 0;
      while (i < oldCount || j < newCount) {
        if (i < oldCount && j < newCount && same(oldLines[i]!, newLines[j]!)) {
          operations.push({ mark: " ", line: oldLines[i++]! });
          j++;
        } else if (i < oldCount && (j === newCount || table[i + 1]![j]! >= table[i]![j + 1]!)) {
          operations.push({ mark: "-", line: oldLines[i++]! });
        } else {
          operations.push({ mark: "+", line: newLines[j++]! });
        }
      }
      const ranges: Array<{ start: number; end: number }> = [];
      for (let index = 0; index < operations.length; index++) {
        if (operations[index]!.mark === " ") continue;
        const start = Math.max(0, index - 3);
        const end = Math.min(operations.length, index + 4);
        const last = ranges.at(-1);
        if (last !== undefined && start <= last.end) last.end = Math.max(end, last.end);
        else ranges.push({ start, end });
      }
      const oldPositions = [0];
      const newPositions = [0];
      for (const op of operations) {
        oldPositions.push(oldPositions.at(-1)! + (op.mark === "+" ? 0 : 1));
        newPositions.push(newPositions.at(-1)! + (op.mark === "-" ? 0 : 1));
      }
      append(`--- a/${name}`);
      append(`+++ b/${name}`);
      for (const range of ranges) {
        const oldSize = oldPositions[range.end]! - oldPositions[range.start]!;
        const newSize = newPositions[range.end]! - newPositions[range.start]!;
        const oldStart = oldPositions[range.start]! + (oldSize === 0 ? 0 : 1);
        const newStart = newPositions[range.start]! + (newSize === 0 ? 0 : 1);
        append(`@@ -${oldStart},${oldSize} +${newStart},${newSize} @@`);
        for (const op of operations.slice(range.start, range.end)) {
          for (const line of unifiedDiffBody(op.mark, op.line)) append(line);
        }
      }
      return { lines, truncated };
    }
    // 对极端长的写入避免 O(N*M) 的比较开销；退化为现有真实单 hunk 预览，
    // 显示明确提示，不能声称这就是完整的多处编辑差异。
    append("Diff preview simplified: multi-hunk comparison exceeded the bounded line budget.");
    truncated = true;
  }
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && same(oldLines[prefix]!, newLines[prefix]!)) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    same(oldLines[oldLines.length - suffix - 1]!, newLines[newLines.length - suffix - 1]!)) suffix++;
  const leading = Math.min(prefix, 3);
  const trailing = Math.min(suffix, 3);
  const oldStart = prefix - leading;
  const oldEnd = oldLines.length - suffix + trailing;
  const newEnd = newLines.length - suffix + trailing;
  append(`--- a/${name}`);
  append(`+++ b/${name}`);
  append(`@@ -${oldStart + 1},${oldEnd - oldStart} +${oldStart + 1},${newEnd - oldStart} @@`);
  appendRange(" ", oldLines.slice(oldStart, prefix));
  appendRange("-", oldLines.slice(prefix, oldLines.length - suffix));
  appendRange("+", newLines.slice(prefix, newLines.length - suffix));
  appendRange(" ", newLines.slice(newLines.length - suffix, newEnd));
  return { lines, truncated };
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
  if (pending && call.function.name === "shell") return zh ? "正在处理命令请求" : "Handling command request";
  if (pending && call.function.name === "write") return zh ? "正在处理文件写入请求" : "Handling file write request";
  if (pending && call.function.name === "edit") return zh ? "正在处理文件编辑请求" : "Handling file edit request";
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
    // read 的 8 KiB 输出截断与 32 KiB 读取截断是两种不同上限。
    // 尾部可能同时含两个警告；都保留，不让行数摘要误导用户。
    if (call.function.name === "read") {
      for (const warning of resultLines.slice(-2)) {
        if (/^… \[(?:truncated \d+ chars|stopped after \d+ bytes)\]$/.test(warning)) {
          lines.push({ text: `      ${warning}`, tone: "warning" });
        }
      }
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

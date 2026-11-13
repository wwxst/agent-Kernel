/**
 * 文件目的：全屏交互界面 —— 上面看对话，下面打字。
 *
 * 只负责显示，不参与思考和执行；换掉它，程序照样能跑。
 *
 * 一条有意为之的规矩：内容只在原地往下追加，不另开一块屏幕接管终端。
 * 这样程序退出后，之前滚过的内容还留在终端里，可以往回翻。
 * 想看完整历史，按 Ctrl+T 切到单独的历史视图。
 *
 * 文件职责：负责绘制、键盘输入、`@` 补全、`/` 命令提示、工具活动的分层展示、状态栏统计。
 * 不负责 Agent 循环、不负责执行工具、不写 Transcript —— 它只消费事件。
 *
 * 内容目录：
 *   - `Tui`：界面本体。生命周期 `start` / `beginTurn` / `finishTurn` / `close`；
 *     模型事件 `beginModelRequest` / `assistantDelta` / `finishAssistant` / `confirmAssistant`；
 *     工具事件 `toolCall` / `toolResult` / `recordEditDiff` / `recordImagePreview`；
 *     输入 `readLine`；状态 `setStats` / `setThinking` / `setRetrying`；日志 `logLine` / `logError`。
 *   - `TuiOptions`：输出流、工作区路径、语言、配色、初始任务等构造参数。
 *   - `Style` 与四套调色板（深色/浅色 × 全彩/基础），`Glyphs`（unicode / ascii 两套字符）。
 *   - 显示宽度工具：`displayWidth` / `wrapLine` / `clip` / `padRight` / `takeByWidth`，
 *     CJK 与 emoji 按 2 列算，否则中文回复会折行破帧。
 *   - 内容格式化：`formatToolEvent` / `toolResultLines` / `committedEditDiff`（真实提交的 diff）/
 *     `summarizeToolResult` / `activityVerb`。
 *   - 配置解析：`parseTuiColorMode` / `parseTuiTheme` / `uiLanguageFromLocale` / `detectUiLanguage`。
 *
 * 模块关系：依赖 `protocol/`（错误与工具调用类型）、`core/`（统计类型、工具失败判断），
 * 以及同目录的 `text.ts`（转义）、`file-index.ts`（`@` 补全）、`prompt-history.ts`（历史）、
 * `tui-mood.ts`（台词）、`tui-image.ts`（读图预览）。由 `cli.ts` 创建并作为观察者挂到 `Agent` 上。
 *
 * 已知限制：终端窗口少于 12 行或 30 列会显示不下。
 */
import { createInterface, emitKeypressEvents } from "node:readline";
import { listWorkspaceFiles, matchFiles } from "./file-index.ts";
import { appendHistory, loadHistory } from "./prompt-history.ts";
import type { Interface, Key } from "node:readline";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { escapeControlCharacters } from "./text.ts";
import { describeError } from "../protocol/errors.ts";
import type { AgentSessionStats, AgentStats } from "../core/agent.ts";
import { selectMood } from "./tui-mood.ts";
import { previewImage } from "./tui-image.ts";
import type { ImagePreview } from "./tui-image.ts";
import type { MoodState } from "./tui-mood.ts";
import type { ToolCall } from "../protocol/types.ts";
import { isToolResultFailure } from "../core/tool-result-status.ts";

/** 固定布局至少需要：标题/路径/分隔线 + 日志 + 输入框 + 状态行 + 缓冲。 */
const MIN_ROWS = 12;
/** 窗口太窄时在备用屏幕里保留提示，不改变渲染模式。 */
const MIN_COLUMNS = 30;

const TITLE_ROW = 1;
const PATH_ROW = 2;
const TOP_DIVIDER_ROW = 3;
const LOG_TOP = 4;

/** 日志最多保留多少条逻辑行；视口只显示最后 N 行，旧记录丢弃。 */
const MAX_LOG_LINES = 2_000;

/** Node 22.18+ readline 的撤销 / 重做栈最多保留 2048 个编辑快照。 */
const READLINE_UNDO_STACK_CAPACITY = 2_048;

/** 流式增量最多每 40ms 重绘一次，避免每个 token 都扫一整屏。 */
const RENDER_INTERVAL_MS = 40;

/** Ctrl+J 换行在输入行里的占位符：readline 见到它不会当成回车。 */
const NEWLINE_MARK = "\u240A";


/** 右对齐的模型名和统计与窗口右边缘之间留的呼吸空间，避免文字贴边难读。 */
const RIGHT_MARGIN = 2;

/** 拖动窗口时先记录最终尺寸，安静 75ms 后再重排，避免每个中间宽度都清屏。 */
const RESIZE_DEBOUNCE_MS = 75;

const PLACEHOLDER = "Ask anything, or type /help...";
const COMMAND_PROMPT = "> ";

/** 仅列出 CLI 已实现的 Slash 命令，保持现有 parseSessionCommand 语义。 */
const SLASH_COMMANDS = [
  { command: "/help", en: "Show available commands", zh: "查看可用命令" },
  { command: "/reset", en: "Clear the current conversation", zh: "重置当前会话" },
  { command: "/exit", en: "Exit agent-Kernel", zh: "退出 agent-Kernel" },
  { command: "/quit", en: "Exit (alias of /exit)", zh: "退出（/exit 的别名）" },
] as const;

/** 补全菜单的一项：斜杠命令和 @ 文件共用同一套渲染。 */
export interface MenuItem {
  readonly command: string;
  readonly en: string;
  readonly zh: string;
}

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

/** mono 只保留用户消息任务条的颜色；full 恢复状态与提示的层次配色。 */
export type TuiColorMode = "full" | "mono";

/** 默认 mono：其余文字保持终端默认色，只有用户消息任务条上色。 */
export function parseTuiColorMode(value: string | undefined): TuiColorMode {
  if (value === undefined || value === "" || value === "mono") return "mono";
  if (value === "full") return value;
  throw new Error(`invalid AGENT_TUI_COLOR "${value}" (expected: full, mono)`);
}

/**
 * 配色方案。和 `TuiColorMode` 是**两件事**，不要合并：
 *
 *   - `colorMode` 管「上不上色」（mono 只给用户消息条上色）；
 *   - `theme` 管「用哪套色」（同一处文字在深色和浅色终端里该是什么颜色）。
 *
 * 之前的实现把两者混成了一个开关，结果只有「深色背景 + 有层次」和「深色背景 + 没层次」两种，
 * 浅色终端上 `info` 的 250 号浅灰几乎看不见。参照 Claude Code 的 `/theme`（dark / light / ANSI）。
 */
export type TuiTheme = "dark" | "light" | "ansi";

/** 默认 dark；`ansi` 强制走 16 色，老终端和「就要终端自己那套配色」的场景用得上。 */
export function parseTuiTheme(value: string | undefined): TuiTheme {
  if (value === undefined || value === "" || value === "dark") return "dark";
  if (value === "light" || value === "ansi") return value;
  throw new Error(`invalid AGENT_TUI_THEME "${value}" (expected: dark, light, ansi)`);
}

export interface TuiOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  model: string;
  workspace: string;
  /** 取消链的起点；TUI 的 Ctrl-C 和 CLI 的 SIGINT 都 abort 同一个 controller。 */
  controller: AbortController;
  /** stdin / stdout 都是 TTY 时才有固定布局。 */
  interactive: boolean;
  columns?: number;
  rows?: number;
  /** 层次配色开关；默认 mono，只保留用户消息任务条的颜色，其余文字纯白。 */
  colorMode?: TuiColorMode;
  /** 配色方案；默认 dark。和 colorMode 正交：先定用哪套色，再定上不上色。 */
  theme?: TuiTheme;
  /** 测试可以显式关掉颜色；生产代码不传，按终端能力自动判断。 */
  color?: boolean;
  /** 初始界面语言；缺省英文，交互式 CLI 按系统 locale 传入；之后仍按任务正文切换。 */
  language?: UiLanguage;
  /** Claude Code 风格：短对话时输入框跟随消息，长对话时自动停靠底部。 */
  flowInput?: boolean;
}

/**
 * TUI 的显示与输入层。
 *
 * 它不认识 Agent：CLI 把 Agent 的回调接到 `assistantDelta` / `toolCall` / `toolResult`。
 * TUI 只负责「怎么看」，循环与工具执行仍在原处。
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

  /** 独立屏幕由 TUI 独占：缩放不会把中间帧写入 Shell 滚动历史。 */
  private readonly ownedScreen: boolean;

  private altScreenActive = false;

  /** 全屏 transcript 视图：临时进备用屏回看/展开历史，退出后主屏原样还回来。 */
  private transcriptMode = false;

  /** 主视图里已经打印进 scrollback 的行数；打印过的行不再重绘。 */
  private printedLines = 0;

  /** 上一帧光标上方属于活动区的行数；下一帧靠它回到活动区顶端。 */
  private lastRowsAboveInput = 0;

  /** 未进入 start 的对象只能释放资源，不能发出任何终端控制序列。 */
  private started = false;

  /** 全屏清理和差分行必须在同一同步帧中输出。 */
  private clearBeforeNextFrame = false;

  private resizeTimer?: NodeJS.Timeout;

  private readonly flowInput: boolean;

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

  /** 只量测 UI 中本次 Run 的经过时间，不参与 Core 的预算或统计。 */
  private runStartedAt?: number;

  private runToolResults = 0;

  /** 历史滚动偏移：0 = 跟随最新；正数 = 向上查看旧记录。 */
  private scrollOffset = 0;

  /** 用户往上翻历史时冻结活动区重绘，避免每帧把视口拉回底部。 */
  private outputPaused = false;

  /** 外部编辑器占用终端期间，不渲染、不接收按键。 */
  private editorRunning = false;

  /** Ctrl+X 前缀的按下时间：超过两秒就不再认后面的 Ctrl+E。 */
  private ctrlXPendingAt = 0;

  /** 每段多行粘贴各用一个占位提示，插入与普通文字共用 readline 的光标语义。 */
  private readonly pastes = new Map<string, string>();

  /** 被 readline 撤销 / 重做历史引用的提示；值是最近一次移除时的编辑序号。 */
  private readonly undoablePastes = new Map<string, number>();

  private editGeneration = 0;

  /** 上一次 readline keypress 处理后的编辑内容，用来识别 kill 命令。 */
  private lastEditorLine = "";

  /** 只增不减，消费部分提示后也不会复用仍在编辑中的身份。 */
  private nextPasteId = 1;

  /** 关闭时恢复输入流，不能让已关闭的界面继续拦截后续消费者的数据。 */
  private readonly restoreInput: () => void;

  /** 上一帧的换行后总行数；滚动时新输出只增加偏移，不把视口拉回底部。 */
  private lastTotalLines = 0;

  /** 缩放前视口顶端的稳定日志 ID + 内容偏移，不受前面的展开或裁剪影响。 */
  private resizeAnchor?: { entryId: number; charOffset: number };

  /** 当锚点对应的日志被裁剪时，状态栏提示一次，而不是默默跳到新回复。 */
  private historyTrimmedNotice = false;

  /** 本次 readLine 的原始 prompt；滚动后重绘输入行要用。 */
  private promptText = COMMAND_PROMPT;

  /** 当前输入是否显示 placeholder；有固定 prompt 时关闭。 */
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

  /** 上一帧每行的原始内容；只写变化的行，减少流式输出时的整屏闪烁。 */
  private lastFrame: string[] = [];

  /** 输入行被 readline 写过；下一帧必须强制清掉。 */
  private inputDirty = true;

  private renderScheduled = false;

  private renderTimer?: NodeJS.Timeout;

  /** 已读到但还没被消费的输入行。 */
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
    this.uiLanguage = options.language ?? "en";
    this.flowInput = options.flowInput ?? false;
    this.terminalControls = process.env.TERM !== "dumb";

    const initialColumns = options.columns !== undefined && options.columns > 0 ? options.columns : 80;
    const initialRows = options.rows !== undefined && options.rows > 0 ? options.rows : 24;
    const tty = options.interactive && isTerminalOutput(options.output);
    // 交互终端不再默默退回行式聊天；无法控制屏幕时明确报告配置问题。
    if (tty && !this.terminalControls) {
      throw new Error("full TUI requires an ANSI-capable terminal (TERM=dumb)");
    }
    this.ownedScreen = tty;
    this.layout = this.ownedScreen;

    this.columns = initialColumns;
    this.rows = initialRows;
    this.inputRow = 0;
    this.boxTopRow = 0;
    this.boxBottomRow = 0;
    this.statusRow = 0;
    this.logHeight = 1;
    // 粘贴归一化：开启括号粘贴后，终端把整段粘贴包在 ESC[200~ ... ESC[201~ 之间。
    // 里面的换行不是「发送」。多行粘贴整段收下、输入框只显示一行占位提示
    // （Claude Code 的 [Pasted text +N lines]），提交时再把原文交给模型——
    // 否则一段多行文本会被当成多次回车，一行一行发出去。
    const pasteSource = options.input as NodeJS.ReadableStream & {
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    const savedEmit = pasteSource.emit;
    const originalEmit = savedEmit.bind(pasteSource);
    const inputDecoder = new StringDecoder("utf8");
    let pasting = false;
    let pasteBuffer = "";
    let partial = "";
    let partialTimer: NodeJS.Timeout | undefined;
    let pasteReadline: Interface | undefined;
    const pasteEmit = (event: string, ...args: unknown[]): boolean => {
      if (event === "data" && args[0] !== undefined) {
        if (partialTimer !== undefined) clearTimeout(partialTimer);
        partialTimer = undefined;
        let data = partial + (Buffer.isBuffer(args[0]) ? inputDecoder.write(args[0]) : String(args[0]));
        partial = "";
        // UTF-8 字符与粘贴标记都可能跨块；只暂存最多五个字符的标记前缀。
        for (let length = Math.min(5, data.length); length > 0; length--) {
          const suffix = data.slice(-length);
          if ("\x1b[200~".startsWith(suffix) || "\x1b[201~".startsWith(suffix)) {
            partial = suffix;
            data = data.slice(0, -length);
            break;
          }
        }
        // 必须按顺序处理：同一块数据里可能同时有开始和结束标记，
        // 先统一替换标记会把状态弄反（结束标记先把 pasting 置回 false）。
        const parts = data.split(/(\x1b\[20[01]~)/);
        let out = "";
        for (const part of parts) {
          if (part === "\x1b[200~") {
            pasting = true;
            pasteBuffer = "";
            continue;
          }
          if (part === "\x1b[201~") {
            pasting = false;
            const text = pasteBuffer.replace(/\r\n?/g, "\n");
            pasteBuffer = "";
            if (text.includes("\n")) {
              const base = this.pastePlaceholder(text);
              const id = this.nextPasteId++;
              const placeholder = this.pastes.size === 0 ? base : `${base.slice(0, -1)} #${id}]`;
              this.pastes.set(placeholder, text);
              out += placeholder;
            } else {
              out += text;
            }
            continue;
          }
          if (pasting) pasteBuffer += part;
          else out += part;
        }
        // 单独的 Esc 仍须交给键盘处理；粘贴中则保留残缺标记等下一块补齐。
        if (partial !== "" && !pasting) {
          partialTimer = setTimeout(() => {
            const pending = partial;
            partial = "";
            partialTimer = undefined;
            if (!this.closed) originalEmit("data", pending);
          }, 80);
        }
        // 换行的三条来源，统一换成占位符（readline 见到它不会当成回车）：
        //   1. Shift+Enter 的 CSI-u 编码：ESC [ 13 ; 2 u
        //   2. 老终端把 Shift+Enter 发成 ESC + CR
        //   3. Ctrl+J 就是裸 \n（Claude Code 也把它当兜底）
        // 只在交互式主视图这么做：管道 / 脚本里的换行是「一行一个命令」，不能合并。
        if (this.layout && this.interactive) {
          out = out
            .replace(/\x1b\[13;2u/g, NEWLINE_MARK)
            .replace(/\x1b\r/g, NEWLINE_MARK)
            .replace(/\r\n/g, "\r")
            .replace(/\n/g, NEWLINE_MARK);
        }
        args[0] = out;
      }
      const emitted = originalEmit(event, ...args);
      // Readline has now consumed this whole data chunk, including any text after an Enter.
      // Keep only paste bodies whose placeholders are still in the editable buffer.
      if (event === "data" && pasteReadline !== undefined) this.prunePastes(pasteReadline.line);
      return emitted;
    };
    pasteSource.emit = pasteEmit;
    this.restoreInput = () => {
      if (partialTimer !== undefined) clearTimeout(partialTimer);
      if (pasteSource.emit === pasteEmit) pasteSource.emit = savedEmit;
      this.pastes.clear();
      this.undoablePastes.clear();
    };

    this.recomputeGeometry();

    const colorMode = options.colorMode ?? "mono";
    const theme = options.theme ?? "dark";
    const colorEnabled =
      this.ownedScreen &&
      (options.color ??
        (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"));
    this.style = new Style(colorEnabled, prefersRichColor(), colorMode === "mono", theme);
    // 现代终端用 ❯/✻，有限字形环境退回 ASCII，但不降级布局。
    // 显式开关优先：老 conhost 配上 UTF-8 代码页其实能显示 Unicode，可环境变量探测不出来，
    // 所以留一个 AGENT_TUI_GLYPHS=unicode|ascii 的逃生口（Claude Code / Codex 都是直接用 Unicode，
    // 不提供降级；我们保守一点，默认仍然探测）。
    const glyphMode = process.env.AGENT_TUI_GLYPHS;
    this.glyphs = glyphMode === "unicode" ? UNICODE_GLYPHS
      : glyphMode === "ascii" ? ASCII_GLYPHS
      : process.platform !== "win32" || prefersRichColor() ? UNICODE_GLYPHS : ASCII_GLYPHS;

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
    // 完整 TUI 进入备用屏幕时过滤鼠标事件；非 TTY 保持原始输入。
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
    pasteReadline = this.rl;
    this.lastEditorLine = this.rl.line;
    // 跨进程历史：readline 的 history 是「最近的在前」，读回来要反转。
    // 读不到或文件损坏都只是「没有历史」，不影响启动。
    (this.rl as Interface & { history: string[] }).history = loadHistory().reverse();

    // 一个 line 监听器服务任务输入：谁先 await 谁拿下一行。
    // 兜底：不支持括号粘贴的终端（老 conhost）会把粘贴里的每个换行都变成一个 line 事件。
    // 这些事件在同一个事件循环里连续到达，而人工按键做不到——所以同一批里的多行
    // 合并成一条消息，换行保留。
    this.rl.on("line", (rawLine) => {
      this.submitLine(rawLine);
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

    this.onKeypress = (_text, key) => {
      if (this.closed) return;
      const name = key?.name?.toLowerCase();
      const previousLine = this.lastEditorLine;
      const currentLine = this.rl.line;
      this.trackEditorChange(previousLine, currentLine);
      this.lastEditorLine = currentLine;

      // transcript 视图里 Esc 先退出视图；它不是取消任务，不该走取消链。
      if (this.transcriptMode && name === "escape") {
        this.exitTranscript();
        return;
      }

      // Ctrl+T 切 transcript 视图：主视图的历史不可改，回看和展开历史都在这里做。
      // 和 Codex 的 Ctrl+T / Claude Code 的 Ctrl+O 是同一个设计。
      if (key?.ctrl && name === "t" && this.layout) {
        this.toggleTranscript();
        return;
      }

      // Ctrl+X 是前缀键（readline/bash 习惯）：Ctrl+X Ctrl+E 打开外部编辑器。
      // 不用 Ctrl+G——它在这里已经有「定位工具详情」的含义，5 条测试依赖它。
      if (key?.ctrl && name === "x" && this.layout) {
        this.ctrlXPendingAt = Date.now();
        return;
      }
      if (key?.ctrl && name === "e" && this.layout && this.ctrlXPendingAt !== 0 &&
          Date.now() - this.ctrlXPendingAt < 2_000 && !this.transcriptMode) {
        this.ctrlXPendingAt = 0;
        this.openExternalEditor();
        return;
      }

      // Ctrl+E 翻阅任务节点：终端没有可点击箭头，键盘直接展开/收起最近轮次。
      if (key?.ctrl && name === "e" && this.layout) {
        const turns = this.log.flatMap((line) =>
          line.kind === "turn-status" && line.turn !== undefined ? [line.turn] : []);
        if (turns.length > 0) {
          this.turnFocus = this.turnFocus <= 0 ? turns.length - 1 : this.turnFocus - 1;
          const target = turns[this.turnFocus]!;
          if (this.isPrintedTurn(target)) {
            this.historyHint();
            return;
          }
          this.captureHistoryAnchor();
          target.expanded = !target.expanded;
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
          const chosen = tools[this.toolFocus]!;
          if (chosen.turn !== undefined && this.isPrintedTurn(chosen.turn)) {
            this.historyHint();
            return;
          }
          this.captureHistoryAnchor();
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
          const owner = this.log.find((line) => line.kind === "activity" && line.activity === group)?.turn;
          if (owner !== undefined && this.isPrintedTurn(owner)) {
            this.historyHint();
            return;
          }
          this.captureHistoryAnchor();
          group.expanded = !group.expanded;
          if (owner !== undefined) owner.expanded = true;
          this.renderNow();
        }
        return;
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
      if (this.transcriptMode) {
        if (name === "pageup") this.scrollPage("up");
        else if (name === "pagedown") this.scrollPage("down");
      } else if (name === "pageup") this.pauseOutput();
      else if (name === "pagedown" || name === "escape") this.resumeOutput();
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
    if (this.ownedScreen) this.resizeSource.on("resize", this.onResize);

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
      // 孤立 Esc 仍是用户操作：计时器必须保持事件循环。
      // 对不完整鼠标序列，80ms 后放弃等待新字节。
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
    if (!pressed || button !== 0) return;
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

  /** Slash 查询不包含空白；带空白的输入是完整命令，不再弹出补全。 */
  private slashMenuCandidates(line: string): readonly MenuItem[] {
    if (!/^\/[^\s]*$/.test(line)) return [];
    return SLASH_COMMANDS.filter((item) => item.command.startsWith(line));
  }

  /**
   * 补全候选：`/` 给命令，`@` 给工作区文件。
   *
   * 两者的接受方式不同——命令替换整行，文件只替换末尾片段——所以候选里带着
   * 最终要插入的文本（`@path`），由 submitLine 决定怎么拼。
   */
  private completionCandidates(line: string): readonly MenuItem[] {
    if (line.startsWith("/")) return this.slashMenuCandidates(line);
    const tail = /@([^\s@]*)$/.exec(line);
    if (tail === null) return [];
    return matchFiles(listWorkspaceFiles(this.workspace), tail[1]!, 6)
      .map((file) => ({ command: `@${file}`, en: "", zh: "" }));
  }

  /** 固定布局下至多显示五项；小窗口至少给日志与输入留出一行。 */
  private slashMenuItems(): readonly MenuItem[] {
    if (!this.layout || !this.promptActive || this.promptText !== COMMAND_PROMPT ||
        this.slashDismissed) return [];
    return this.completionCandidates(this.rl.line);
  }

  /** 显式恢复 readline 编辑缓存（不创建历史记录）。 */
  private setEditorLine(text: string, cursor = text.length): void {
    const previousLine = this.rl.line;
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.rl.write(text);
    for (let i = 0; i < [...text.slice(cursor)].length; i++) {
      this.rl.write(null, { name: "left" });
    }
    this.trackEditorChange(previousLine, this.rl.line);
    this.lastEditorLine = this.rl.line;
    this.inputDirty = true;
  }

  /** 候选菜单的显示宽度按终端字符列计算，选中项使用强调色。 */
  private slashMenuLine(item: MenuItem, selected: boolean, width: number): string {
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

  /** 界面方法 start（画第一帧）：主视图不切备用屏，定稿的行直接打印进终端滚动历史。 */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    if (this.layout) {
      // 光标在活动区里由 TUI 自己摆；不捕获鼠标，滚轮和选中复制保持终端原生行为。
      this.output.write("\x1b[?25l");
      // 开启括号粘贴：终端会把整段粘贴包在 ESC[200~ ... ESC[201~ 里，
      // 我们才分得清「粘贴里的换行」和「用户按了回车」。
      this.output.write("\x1b[?2004h");
      this.printHeader();
      this.clearBeforeNextFrame = true;
      this.renderNow();
      return;
    }

    if (this.interactive) {
      this.logLine(this.formatStatus());
      this.logLine(this.formatStatsLine());
      return;
    }

    this.logLine(`model: ${singleLine(this.model)}`);
    this.logLine(`workspace: ${singleLine(this.workspace)}`);
    this.logLine("access: full-access");
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

  /** 终端尺寸变化后重新排版；保留历史锚点，合并 75ms 内的连续变化。 */
  private resize(columns: number, rows: number): void {
    if (!this.started || !this.ownedScreen || this.closed) return;

    if (this.resizeTimer === undefined) this.captureHistoryAnchor();
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    // 只更新内存中的最终尺寸，等待稳定后在独立屏幕里重绘一帧。
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      if (this.closed) return;
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
  }

  /** 只翻译 TUI 自己生成的提示；不翻译模型回复、工具参数或错误详情。 */
  uiText(english: string, chinese: string): string {
    return this.uiLanguage === "zh" ? chinese : english;
  }

  /** 权限固定为完全访问：只有这一个标签，没有可切换的模式。 */
  accessLabel(): string {
    return this.uiText("access: full-access", "权限：完全访问");
  }

  /** 用于 CLI 的会话命令提示，语言跟随最近一轮任务。 */
  helpText(): string {
    const commands = this.uiText(
      "commands: /exit  quit · /reset  clear the transcript and start a new Agent · /help  show this",
      "命令：/exit  退出 · /reset  清空会话并重建 Agent · /help  显示帮助",
    );
    if (!this.layout) return commands;
    // 按键表：规范要求「写进 README，并在 /help 里可见」，用户不该靠读源码发现快捷键。
    const keys = this.uiText(
      "input:  Enter send · Shift+Enter or Ctrl+J newline · @ completes a file path · Ctrl+X Ctrl+E opens $EDITOR · Ctrl+C cancel the run",
      "输入：Enter 发送 · Shift+Enter 或 Ctrl+J 换行 · @ 补全文件路径 · Ctrl+X Ctrl+E 用 $EDITOR 编辑 · Ctrl+C 取消本轮",
    );
    const view = this.uiText(
      "view:   Ctrl+E history · PgUp pause live output · PgDn or Esc resume",
      "视图：Ctrl+E 历史 · PgUp 暂停刷新 · PgDn 或 Esc 恢复",
    );
    return `${commands}\n${keys}\n${view}`;
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
      if (this.ownedScreen) {
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
    // 错误和收尾状态不轮播；短工具调用只显示一条，不产生闪烁。
    if (this.activityState === "failed" ||
        this.activityState === "completed" || this.activityState === "cancelled") return;
    if (Date.now() - this.moodChangedAt >= 15_000) this.chooseMood(this.activityState);
  }

  private withMood(base: string, width: number): string {
    if (this.moodText === "") return base;
    const extra = ` │ ${this.moodText}`;
    return displayWidth(base) + displayWidth(extra) <= width ? base + extra : base;
  }

  private turnStatusLine(turn: TurnActivity, flat = false): LogLine {
    const elapsed = Math.max(0, (turn.endedAt ?? Date.now()) - turn.startedAt);
    const duration = formatActivityDuration(elapsed, turn.language);
    const zh = turn.language === "zh";
    const suffix = flat ? "" : `  ${this.foldArrow(turn.expanded)} ${this.foldHint(turn.expanded, "Ctrl+E", zh)}`;
    if (turn.outcome === "completed") return {
      text: `  ${this.glyphs.success} ${zh ? "已完成" : "Completed"} · ${zh ? "用时" : "in"} ${duration}${suffix}`,
      tone: "success",
    };
    if (turn.outcome === "failed" || turn.outcome === "cancelled") {
      const outcome = turn.outcome === "failed" ? (zh ? "执行失败" : "Failed") : (zh ? "已取消" : "Cancelled");
      return { text: `  ${turn.outcome === "failed" ? this.glyphs.error : this.glyphs.notRun} ${outcome} · ${zh ? "用时" : "after"} ${duration}${suffix}`,
        tone: turn.outcome === "failed" ? "error" : "muted" };
    }
    if (turn.outcome === "preparing") return { text: `  ${this.glyphs.running} ${zh ? "准备执行" : "Preparing"}${suffix}`, tone: "muted" };
    return { text: `  ${this.glyphs.running} ${zh ? "正在执行 · 已用时" : "Working · elapsed"} ${duration}${suffix}`, tone: "accent" };
  }

  /** 只在显示层拼接折叠指示符，始终位于对应文字后面。 */
  private foldArrow(expanded: boolean): string {
    return this.glyphs === UNICODE_GLYPHS ? (expanded ? "▾" : "▸") : (expanded ? "v" : ">");
  }

  /**
   * 箭头后面的快捷键提示。
   *
   * 主视图不再捕获鼠标（滚轮和选中复制要留给终端），所以「可以点开」这个隐含约定没了；
   * 箭头后面必须写明按哪个键，否则用户只看到一个孤零零的三角，不知道能展开。
   */
  private foldHint(expanded: boolean, key: string, zh: boolean): string {
    const action = zh ? (expanded ? "收起" : "展开") : (expanded ? "collapse" : "expand");
    return zh ? `（${key} ${action}）` : `(${key} ${action})`;
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
    const mark = summary.notRun ? this.glyphs.notRun : this.glyphs.error;
    const tone: Tone = summary.notRun ? "muted" : "error";
    const label = language === "zh"
      ? summary.notRun ? "未执行" : "失败"
      : summary.notRun ? "not run" : "failed";
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
    // 工具行只留箭头：每个工具都挂一句「（Ctrl+G 展开）」会把详情区淹掉，
    // 快捷键在 /help 和活动组那一行里已经有说明。
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
          "Diff preview unavailable: write succeeded, but the file exceeds 2,000,000 bytes or the previous snapshot could not be read.",
          "Diff 预览已降级：写入成功，但文件超过 2,000,000 字节 或旧内容无法安全读取。")}`, "warning"));
      }
    }
    if (!ended && !group.finished) {
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
   * 界面方法 beginTurn（任务开始）：把用户这一轮写进对话，并关掉上一段可能未收尾的模型回复。
   *
   * 固定布局清掉 readline 的输入回显，所以写一条 `❯ task`；行式聊天默认不重复。
   */
  beginTurn(task: string, { show = this.ownedScreen || !this.interactive }: { show?: boolean } = {}): void {
    this.uiLanguage = detectUiLanguage(task, this.uiLanguage);
    this.runStartedAt = Date.now();
    this.runToolResults = 0;
    this.activeActivity = undefined;
    this.activityFocus = -1;
    this.toolFocus = -1;
    this.turnFocus = -1;
    this.activityPending.clear();
    if (this.ownedScreen) {
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

  /** 界面方法 assistantDelta（收到正文片段）：固定布局只累积、限频重绘；行式聊天直接写。 */
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
   * 界面方法 finishAssistant（收尾回复）：content 是 Agent 的最终消息——流式已经显示过时只提交缓冲，
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
    if (this.ownedScreen) this.commitAssistant();
    this.assistantOpen = false;
    this.assistantAtLineStart = true;
    this.streamingText = "";
  }

  /**
   * 界面方法 confirmAssistant（校对回复）：用已经确认的模型消息校对流式增量。固定布局可原地改正，
   * 行式模式无法撤回已写字节，必须追加明确的更正提示与权威正文，而不是悄悄忽略差异。
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

  /** 界面方法 toolCall（工具开始）：固定布局先写「正在运行」；结果到达时原地替换成 ✓ 或 ✗。 */
  toolCall(call: ToolCall): void {
    this.setThinking(false);
    this.finishAssistant();
    this.setActivityState(moodStateForTool(call));
    const turn = this.currentTurn;
    if (this.ownedScreen && turn !== undefined && turn.endedAt === undefined) {
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
    } else if (this.ownedScreen) {
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

  /** 界面方法 toolResult（工具结果）：成功、失败都落一行；失败原因直接来自工具返回值。 */
  toolResult(call: ToolCall, result: string): void {
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
    if (this.ownedScreen && activeTool === undefined) {
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

  /** 界面方法 finishTurn（一轮结束）：更新统计；固定布局重画页脚，其余布局打一行统计。 */
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
      // 状态行最后落账：正文已经提交进日志，所以它天然排在回复之后
      // （Claude Code 的 "Cooked for 12s"、Codex 的耗时都在回复下面）。
      if (this.currentTurn !== undefined) {
      // 状态行的唯一作用是展开这一轮折叠起来的过程层；没有工具调用就没有可展开的东西，
      // 一个「已完成 · 用时」加个箭头只会让人以为下面藏着内容。失败/取消仍然保留，
      // 那是结果本身，不是在提示「还能展开」。
      if (this.currentTurn !== undefined &&
          (this.currentTurn.groups.length > 0 || this.currentTurn.outcome !== "completed")) {
        this.appendLog({ text: "", tone: "muted", kind: "turn-status", turn: this.currentTurn });
        this.trimLog();
      }
      }
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
   * 界面方法 readLine（读一行输入）：返回 null 表示输入已经关闭（结束或取消）。
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
      // A buffered next paste may already be in readline; prompt() resets its cursor to zero.
      // Preserve the insertion point so later typing appends at the existing cursor.
      this.rl.prompt(true);
      this.renderNow();
      return answer;
    }

    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return answer;
  }

  /** 界面方法 close（关闭）：清掉监听器和定时器、提交当前回复、恢复终端。 */
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
    this.restoreInput();
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

    if (this.cursorStyleChanged) this.output.write("\x1b[0 q");
    if (this.altScreenActive) {
      // transcript 视图退出：备用屏还原主屏，主视图随后自己重画活动区。
      this.output.write("\x1b[?25h\x1b[?1049l");
      this.altScreenActive = false;
      this.transcriptMode = false;
    }
    if (this.layout) {
      // 只清底部活动区：已打印的历史留在 Shell 里，光标落到新行。
      const up = this.lastRowsAboveInput;
      // 关掉括号粘贴，别把终端留在我们自定义的模式里。
      this.output.write(`${up > 0 ? `\x1b[${up}A` : ""}\r\x1b[J\x1b[?2004l\x1b[?25h`);
      this.lastRowsAboveInput = 0;
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
    if (this.ownedScreen) this.pushLog(text, tone);
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

  /** 主视图与 transcript 视图共用的入口：主视图只追加，transcript 重画整屏。 */
  private renderNow(force = false): void {
    if (!this.started || !this.layout || this.closed || this.resizeTimer !== undefined) return;
    // 用户正在往上翻历史：别再往底部写，否则终端会把视口拉回底部。
    if (this.outputPaused && !force) return;
    if (this.transcriptMode) this.renderTranscript();
    else this.renderInline();
  }

  /** 多行粘贴在输入框里的占位提示（Claude Code 的 [Pasted text +N lines]）。 */
  private pastePlaceholder(text: string): string {
    const lines = text.split("\n").length;
    return this.uiText(`[Pasted text +${lines} lines]`, `[已粘贴 ${lines} 行]`);
  }

  /** 提交一行；占位提示换成多行粘贴的原文。 */
  private submitLine(rawSubmitted: string): void {
    const line = rawSubmitted.split(NEWLINE_MARK).join("\n");
    // Enter 提交当前高亮项：`/` 是整行替换并执行，`@` 只把路径补进输入框、不提交——
    // 用户通常还要接着写「这个文件里的 X 怎么改」。
    const candidates = this.completionCandidates(line);
    const chosen = this.layout && this.promptActive && !this.slashDismissed && candidates.length > 0
      ? candidates[Math.min(this.slashSelected, candidates.length - 1)]!
      : undefined;
    if (chosen !== undefined && chosen.command.startsWith("@")) {
      const completed = line.replace(/@[^\s@]*$/, chosen.command);
      this.slashSelected = 0;
      // 补完之后先把菜单关掉，否则下一次回车又会重新选中同一个文件。
      this.slashDismissed = true;
      this.slashDraft = completed;
      this.slashDraftCursor = completed.length;
      this.setEditorLine(completed);
      return;
    }
    const submitted = chosen === undefined ? line : chosen.command;
    this.slashDismissed = false;
    this.slashSelected = 0;
    this.slashDraft = "";
    this.slashDraftCursor = 0;
    // 占位提示对应一段多行粘贴：真正交给模型的是原文。
    const payload = this.expandPastes(submitted);
    if (payload !== submitted) {
      const history = (this.rl as Interface & { history: string[] }).history;
      if (history[0] === rawSubmitted) history[0] = payload.split("\n").join(NEWLINE_MARK);
    }
    // 同一 data 块可能还带着下一条粘贴消息，只移除本次实际消费的提示。
    for (const placeholder of this.pastes.keys()) {
      if (submitted.includes(placeholder)) this.pastes.delete(placeholder);
    }
    // readline 在提交一行时会清空 undo / redo 栈；此前已删除的提示不再可能被恢复。
    this.undoablePastes.clear();
    // 只记任务正文：斜杠命令不进历史（按上键翻出一串 /help 没有意义）。
    if (!payload.startsWith("/")) appendHistory(payload, this.workspace);
    const resolve = this.waiting.shift();
    if (resolve === undefined) {
      this.lines.push(payload);
      this.inputDirty = true;
    } else {
      resolve(payload);
    }
  }

  /** 记录编辑前后变化；被删除的提示仍可能存在于 readline 的撤销 / 重做快照中。 */
  private trackEditorChange(previousLine: string, currentLine: string): void {
    if (previousLine === currentLine) return;
    this.editGeneration++;
    for (const placeholder of this.pastes.keys()) {
      if (previousLine.includes(placeholder) && !currentLine.includes(placeholder)) {
        this.undoablePastes.set(placeholder, this.editGeneration);
      }
    }
  }

  /** 回收当前缓冲区与 readline 最近 2048 个撤销 / 重做快照都不再引用的原文。 */
  private prunePastes(currentLine: string): void {
    for (const placeholder of this.pastes.keys()) {
      if (currentLine.includes(placeholder)) {
        this.undoablePastes.delete(placeholder);
        continue;
      }
      const removedAt = this.undoablePastes.get(placeholder);
      const canUndo = removedAt !== undefined &&
        this.editGeneration - removedAt < READLINE_UNDO_STACK_CAPACITY;
      if (!canUndo) {
        this.pastes.delete(placeholder);
        this.undoablePastes.delete(placeholder);
      }
    }
  }

  /** 一次替换所有提示；回调返回的原文不再参与匹配，避免把粘贴正文里的提示文字也展开。 */
  private expandPastes(text: string): string {
    if (this.pastes.size === 0) return text;
    const pattern = [...this.pastes.keys()].map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return text.replace(new RegExp(pattern, "g"), (key) => this.pastes.get(key)!);
  }

  /**
   * 把当前输入交给外部编辑器（Ctrl+G）。
   *
   * 长 prompt 在终端里改很难受，两家同类产品都提供这条路径：Claude Code 用 Ctrl+G，
   * Codex 读 VISUAL/EDITOR。这里把内容写进临时文件、让编辑器接管终端、保存后读回。
   * 编辑器没配置就给出明确提示，而不是静默失败。
   */
  private openExternalEditor(): void {
    if (this.editorRunning) return;
    const command = (process.env.VISUAL ?? "").trim() || (process.env.EDITOR ?? "").trim() ||
      (process.platform === "win32" ? "notepad" : "vi");
    const file = path.join(tmpdir(), `agent-prompt-${process.pid}.md`);
    try {
      writeFileSync(file, this.expandPastes(this.rl.line).split(NEWLINE_MARK).join("\n"), "utf8");
    } catch (error) {
      this.pushLog(this.uiText(
        `could not prepare the editor buffer: ${describeError(error)}`,
        `无法准备编辑器缓冲区：${describeError(error)}`,
      ), "error");
      this.renderNow(true);
      return;
    }

    this.editorRunning = true;
    // 让出终端：显示光标、清掉底部活动区，编辑器自己会占满屏幕。
    this.output.write("\x1b[?25h");
    const result = spawnSync(command, [file], { stdio: "inherit", shell: true });
    this.editorRunning = false;
    this.output.write("\x1b[?25l");

    if (result.error !== undefined) {
      this.pushLog(this.uiText(
        `could not start "${command}": ${result.error.message}`,
        `无法启动 "${command}"：${result.error.message}`,
      ), "error");
    } else if (result.status !== 0) {
      this.pushLog(this.uiText(
        `editor exited with ${result.status}; the input was left unchanged`,
        `编辑器退出码 ${result.status}；输入内容保持不变`,
      ), "warning");
    } else {
      try {
        const edited = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
        if (edited !== this.rl.line.split(NEWLINE_MARK).join("\n")) {
          this.setEditorLine(edited.split("\n").join(NEWLINE_MARK), edited.length);
        }
        // 外部编辑器接管了整份草稿；返回文本中的占位样式字符串应按字面处理。
        this.pastes.clear();
        this.undoablePastes.clear();
      } catch (error) {
        this.pushLog(this.uiText(
          `could not read the edited text: ${describeError(error)}`,
          `无法读取编辑结果：${describeError(error)}`,
        ), "error");
      }
    }

    try {
      rmSync(file, { force: true });
    } catch {
      // 临时文件删不掉不影响输入内容，下一次会覆盖同名文件。
    }
    this.renderNow(true);
  }

  /** 冻结活动区重绘，把视口交给终端；PgDn / Esc 恢复。 */
  private pauseOutput(): void {
    if (this.outputPaused) return;
    this.outputPaused = true;
    this.pushLog(this.uiText(
      "Live output paused - scroll freely, PgDn or Esc resumes",
      "已暂停刷新 · 可以自由翻看历史，PgDn 或 Esc 恢复",
    ), "muted");
    this.renderNow(true);
  }

  private resumeOutput(): void {
    if (!this.outputPaused) return;
    this.outputPaused = false;
    this.renderNow(true);
  }

  /** 结束后内容已提交进 scrollback，改不了：历史详情只能去 transcript 视图看。 */
  private isPrintedTurn(turn: TurnActivity): boolean {
    return turn.endedAt !== undefined;
  }

  /** 历史详情改不了，就明确告诉用户去哪里看，而不是按了没反应。 */
  private historyHint(): void {
    // 已打印的内容改不了，「原地展开」在追加式视图里做不到——Claude Code 和 Codex
    // 的解法都是切到一个临时全屏视图去展开。所以这里直接把 transcript 打开，
    // 而不是只打一行提示（那样按了像没反应，还容易刷屏）。
    if (!this.transcriptMode) this.toggleTranscript();
  }

  /** 进/出 transcript 视图。备用屏只用在这里：临时独占整屏回看历史，退出原样还回主屏。 */
  private toggleTranscript(): void {
    if (this.closed) return;
    if (this.transcriptMode) {
      this.exitTranscript();
      return;
    }
    this.transcriptMode = true;
    this.output.write("\x1b[?1049h\x1b[?25l");
    this.altScreenActive = true;
    this.clearBeforeNextFrame = true;
    this.lastFrame = [];
    this.renderNow();
  }

  private exitTranscript(): void {
    if (!this.transcriptMode) return;
    this.transcriptMode = false;
    this.output.write("\x1b[?25h\x1b[?1049l");
    this.altScreenActive = false;
    this.lastFrame = [];
    // 光标由 1049l 还原到进入前的输入行；lastRowsAboveInput 仍然有效，直接重画活动区。
    this.renderNow();
  }

  /** 主视图的抬头：只打印一次，之后随历史一起往上滚。 */
  private printHeader(): void {
    const width = this.contentWidth();
    this.output.write(
      `${this.titleLine(width)}\r\n${this.style.paint("muted", fitPath(singleLine(this.workspace), width))}\r\n` +
      `${this.dividerLine(width)}\r\n`,
    );
  }

  /** transcript 视图：临时独占备用屏，整屏重绘，可滚动、可展开历史。 */
  private renderTranscript(): void {
    // 这里是「已启动且还没关闭」才画；之前写成 !this.closed，等于只有关闭之后才画，
    // 于是 Ctrl+T 进去只有一块空白屏——提示用户来看详情，结果什么都没有。
    if (!this.started || this.closed) return;

    if (this.columns < MIN_COLUMNS || this.rows < MIN_ROWS) {
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
    // transcript 是详情视图：默认展开所有过程层。
    const lines = this.wrappedDisplayLines(false, true);
    if (this.flowInput && this.scrollOffset === 0) {
      // 短对话把输入框紧跟内容：只为最近几行上下文留高度，长会话仍停靠底部。
      this.logHeight = Math.min(this.logHeight, Math.max(2, lines.length + 1));
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
    frame += this.inputCursorSequence();
    // 同一帧通过一次输出写入，避免终端在多次 write 之间露出半张画面。
    if (frame !== "") this.output.write(`\x1b[?2026h\x1b[?25l${frame}\x1b[?25h\x1b[?2026l`);
  }

  /**
   * 主视图：只追加。
   *
   * 已定稿的行用普通输出打印一次，之后随 Shell 滚动历史一起上移，不再重绘；
   * 底部活动区（当前轮的可变内容 + 输入框 + 状态行）每帧清掉重画。
   * 这就是 Claude Code 的 `<Static>` 和 Codex 的 inline viewport 的做法：
   * 历史不可改，想改历史就切到 transcript 视图。
   */
  private renderInline(): void {
    const width = this.contentWidth();
    const slashCandidates = this.slashMenuItems();
    const menuRows = Math.min(slashCandidates.length, 5);
    // 主视图拍平：一个工具一行，没有第三层、没有展开箭头；详情去 transcript 看。
    const lines = this.wrappedDisplayLines(true);

    // 折叠一轮会让展示行变少，已经打印出去的行收不回来。这时必须把游标退回到当前长度：
    // 否则 printedLines 会一直大于 lines.length，之后新增的行全部落在游标之前，
    // 永远不会被打印——表现就是「间距没了、整段内容消失」。
    if (lines.length < this.printedLines) this.printedLines = lines.length;

    // 提交边界：最后一组 entry 还在变（流式正文、运行中的工具），留在活动区；其余可以定稿。
    const tailBudget = Math.max(1, Math.min(this.rows - 6, 12));
    const lastId = lines.at(-1)?.id;
    let boundary = lines.length;
    while (boundary > 0 && lines[boundary - 1]?.id === lastId) boundary--;
    const commitTarget = Math.max(0, Math.min(lines.length - tailBudget, boundary));
    const commitTo = Math.min(Math.max(this.printedLines, commitTarget), lines.length);
    const tail = lines.slice(commitTo);
    // 未确认的流式正文不能提前提交到 Shell scrollback：模型可能中断或校正它。
    // 但也不能让整条长回复一直留在可变区，否则活动区会超过终端高度，光标上移越界并重复刷历史。
    // 因此流式期间只显示尾部窗口；确认后 commitAssistant 会把完整正文一次性写入日志。
    let visibleTail = tail;
    if (this.assistantOpen && tail.length > tailBudget) {
      const visibleCount = Math.max(1, tailBudget - 1);
      const hiddenCount = tail.length - visibleCount;
      visibleTail = tailBudget > 1
        ? [{ text: this.uiText(
          `… ${hiddenCount} earlier streaming lines pending confirmation`,
          `… 还有 ${hiddenCount} 行较早的流式正文待确认`,
        ), tone: "muted" }, ...tail.slice(-visibleCount)]
        : tail.slice(-1);
    }
    // 输入框上方 = 活动区尾部实际占用的终端行数 + 输入框上边框。
    // 不能直接用 tail.length：终端在行尾会自动折行，一条逻辑行可能占两行；
    // 少算就会上移不足，旧内容清不掉，新内容叠上去——屏幕上表现为同一句话重复几十遍。
    const tailRows = visibleTail.reduce(
      (rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line.text) / width)), 0);
    // 光标停在最后一行输入上：它上面还有 (输入行数 - 1) 行输入内容。
    const rowsAboveInput = tailRows + 1 + Math.max(0, this.inputLines(width).length - 1);

    let frame = "\x1b[?2026h";
    if (this.lastRowsAboveInput > 0) frame += `\x1b[${this.lastRowsAboveInput}A`;
    frame += "\r\x1b[J";

    for (let index = this.printedLines; index < commitTo; index++) {
      frame += `${this.paintLogLine(lines[index]!, width)}\r\n`;
    }
    this.printedLines = commitTo;

    for (const line of visibleTail) frame += `${this.paintLogLine(line, width)}\r\n`;
    // 输入区可以是多行（Ctrl+J 换行），行数变化要同时反映到光标回退的行数上。
    const inputRows = this.inputLines(width);
    frame += `${this.dividerLine(width)}\r\n${inputRows.join("\r\n")}\r\n${this.dividerLine(width)}\r\n`;
    if (menuRows > 0) {
      const first = Math.min(Math.max(0, this.slashSelected - menuRows + 1),
        Math.max(0, slashCandidates.length - menuRows));
      for (let index = 0; index < menuRows; index++) {
        frame += `${this.slashMenuLine(slashCandidates[first + index]!, first + index === this.slashSelected, width)}\r\n`;
      }
    }
    frame += this.footerLine(width);

    // 光标从状态行回到输入行：下边框 + 菜单 + 状态行都在它下面。
    frame += `\x1b[${1 + menuRows + 1}A\r${this.inputColumnSequence()}\x1b[?25h`;
    frame += "\x1b[?2026l";

    this.lastRowsAboveInput = rowsAboveInput;
    this.inputDirty = false;
    this.clearBeforeNextFrame = false;
    this.output.write(frame);
  }

  /** 主视图的输入光标：相对活动区，按 prompt 宽度和已输入内容算列偏移。 */
  private inputColumnSequence(): string {
    const plainPrompt = this.promptText === COMMAND_PROMPT
      ? `${this.glyphs.user} `
      : singleLine(this.promptText);
    const before = escapeControlCharacters(this.rl.line.slice(this.inputOffset, this.rl.cursor));
    const column = Math.min(this.columns, 1 + displayWidth(plainPrompt) + displayWidth(before));
    return column > 1 ? `\x1b[${column - 1}C` : "";
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
   * 输入区的每一行。
   *
   * Ctrl+J 换行后内容里带 NEWLINE_MARK，这里按它切行：第一行带提示符，
   * 后续行缩进对齐。Enter 才提交，所以多行任务可以先铺开再一次性发出。
   */
  private inputLines(width: number): string[] {
    const prompt = this.promptText === COMMAND_PROMPT ? `${this.glyphs.user} ` : singleLine(this.promptText);
    const segments = this.rl.line.split(NEWLINE_MARK);
    // 光标所在的那一段要横向滚动，保证光标始终可见；其他段从头裁剪即可。
    const beforeCursor = this.rl.line.slice(0, this.rl.cursor);
    const cursorSegment = beforeCursor.split(NEWLINE_MARK).length - 1;
    const cursorInSegment = beforeCursor.length - (beforeCursor.lastIndexOf(NEWLINE_MARK) + 1);
    return segments.map((segment, index) => {
      const prefix = index === 0 ? prompt : "  ";
      const room = Math.max(1, width - displayWidth(prefix));
      const placeholder = index === 0 && this.promptPlaceholder && this.rl.line === "" &&
        this.promptText === COMMAND_PROMPT && this.log.length === 0;
      if (placeholder) {
        return this.style.inputPrompt(prefix) +
          this.style.inputHint(padRight(` ${this.uiText(PLACEHOLDER, "输入任务，或输入 /help...")}`, room));
      }
      let shown = segment;
      if (index === cursorSegment) {
        // 光标前面的内容超出宽度就左移起点，直到光标能落在框内。
        let start = 0;
        while (displayWidth(escapeControlCharacters(shown.slice(start, cursorInSegment))) >= room) start++;
        shown = shown.slice(start);
      }
      return this.style.inputPrompt(prefix) + padRight(takeByWidth(escapeControlCharacters(shown), room), room);
    });
  }

  /** 单行版本：整屏网格只有一行输入位，取最后一行（光标所在行）。 */
  private inputLine(width: number): string {
    const rows = this.inputLines(width);
    return rows[rows.length - 1]!;
  }

  /** 不用 ESC 7/8（conhost 上不一定可靠），按 prompt 宽度和已输入内容算回光标列。 */
  private inputCursorSequence(): string {
    const plainPrompt = this.promptText === COMMAND_PROMPT
      ? `${this.glyphs.user} `
      : singleLine(this.promptText);
    // 多行输入时光标在最后一行：列偏移只算最后一个换行之后的部分。
    const beforeCursor = this.rl.line.slice(this.inputOffset, this.rl.cursor);
    const before = escapeControlCharacters(beforeCursor.slice(beforeCursor.lastIndexOf(NEWLINE_MARK) + 1));
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
   * 一条竖线标出；非 TTY 文本输出仍按原文输出（已经写出的字节无法撤回）。
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
    if (overflow <= 0) return;
    // printedLines 数的是实际展示行；裁剪还可能把相邻空行变成被省略的首行，
    // 因此按裁剪前后的展示长度重定位，不能只数被删条目自身的折行数。
    const before = this.wrappedDisplayLines(true).length;
    this.log.splice(0, overflow);
    const removedLines = before - this.wrappedDisplayLines(true).length;
    this.printedLines = Math.max(0, this.printedLines - removedLines);
  }

  private wrappedDisplayLines(flat = false, expandAll = false): LogLine[] {
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
        const status = { ...this.turnStatusLine(line.turn, flat), kind: "turn-status" as const, turn: line.turn };
        append(line, line.turn.expanded
          ? [status, { text: this.glyphs.divider.repeat(this.contentWidth()), tone: "muted" }]
          : [status]);
        continue;
      }
      // 完成后只隐藏「详情层」，不折叠用户提问、最终正式回复、活动摘要和轮次外的错误。
      // 摘要里有「哪个命令失败、为什么失败」，是安全信息，折叠时也必须看得见。
      // 空白行不算「过程」：它是上下行之间的呼吸，折叠时也要留着（连续空行稍后压成一行）。
      if (line.turn !== undefined && !line.turn.expanded &&
          line.kind !== "final-reply" && line.kind !== "activity" && line.text !== "") continue;
      if (line.kind === "activity" && line.activity !== undefined) {
        // 活动组之间空一行：三段「列出 / 读取 / 编辑」连在一起会糊成一片。
        if (logical.length > 0 && logical[logical.length - 1]!.text !== "") {
          logical.push({ text: "", tone: "plain" });
        }
        const group = line.activity;
        // 轮次折叠时活动组也只显示摘要与失败行：详情属于「下面几层」。
        const detailsOpen = expandAll || (group.expanded && line.turn?.expanded !== false);
        if (flat) {
          // 主视图拍平：一个工具一行（动词 + 目标），没有第三层、没有展开箭头。
          const flatChildren: LogLine[] = [];
          // 主视图不重复描述：工具行已经写了「读取 你好世界.txt」，
          // 再来一句「已读取文件 你好世界.txt。」就是同一件事说两遍。
          for (const item of group.tools) {
            const failure = this.activityFailureLine(item, group.language);
            if (failure !== undefined) {
              flatChildren.push(failure);
              continue;
            }
            // 还没返回的工具用运行符号 + 明确文案：扁平不等于看不出在跑。
            // 这一轮已经结束的话就不是「在跑」，而是「没有结果」，不能继续显示运行中。
            const pending = item.result === undefined && !group.finished;
            flatChildren.push(this.makeLogLine(
              `  ${pending ? this.glyphs.running : this.glyphs === UNICODE_GLYPHS ? "↳" : "+"} ${formatToolEvent(item.call, group.language)}${
                pending ? ` · ${this.uiText("Running...", "运行中...")}` : ""}`, "muted"));
          }
          if (flatChildren.length === 0) {
            flatChildren.push(this.makeLogLine(
              `  ${this.glyphs === UNICODE_GLYPHS ? "↳" : "+"} ${this.activitySummary(group)}`, "muted"));
          }
          append(line, flatChildren);
          continue;
        }
        const children: LogLine[] = [];
        // 同一个阶段只有一条事实性概述；根据最近的实际操作原地更新，不向历史刷重复日志。
        // 这一组已经结束就不再补叙述：摘要行和工具行已经说清了做过什么，再写一句「已列出目录」是第三遍。
        if (group.fallbackOverview && group.tools.length > 0 && !group.finished) {
          const current = [...group.tools].reverse().find((tool) => tool.result === undefined) ?? group.tools.at(-1)!;
          children.push({ text: escapeControlCharacters(`  ${this.glyphs.running} ${toolProgressOverview(
            current.call, current.result, group.language,
          )}`),
            tone: "info" });
        }
        children.push(
          { text: escapeControlCharacters(`  ${this.glyphs === UNICODE_GLYPHS ? "↳" : "+"} ${this.activitySummary(group)}  ${this.foldArrow(detailsOpen)} ${this.foldHint(detailsOpen, "Ctrl+O", group.language === "zh")}`),
            tone: "muted", kind: "activity", activity: group },
        );
        if (detailsOpen) {
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
      if (pendingLines.has(line)) {
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
      // 「怎么取消」是全局提示，放底部状态栏；塞进内容行只会每帧重复一遍。
      logical.push({ text: this.withMood(waiting, this.contentWidth()), tone: "accent", kind: "thinking" });
      }
    } else if (this.currentTurn?.endedAt === undefined && this.currentTurn?.expanded !== false &&
               this.activityState !== undefined && this.activityState !== "preparing" &&
               !this.assistantOpen && !flat) {
      // 主视图扁平后，下面那行「正在执行 · 已用时」已经说明了同一件事，这里不再叠一行「处理中」。
      // 临时语气不进入 Transcript；下一次事件取代它，而非新增日志行。
      this.maybeRotateMood();
      const status = formatActivityStateLabel(this.activityState, this.uiLanguage);
      if (status !== "") logical.push({ text: this.withMood(
        `  ${this.glyphs.running} ${status}`, this.contentWidth()), tone: "muted" });
    }

    // 折叠后可能留下连续空行（被隐藏的过程行原本夹在中间）：压成一行，只去掉开头那一行。
    // 结尾的空行要留着——它就是回复和状态行之间的呼吸。
    for (let index = logical.length - 1; index > 0; index--) {
      if (logical[index]!.text === "" && logical[index - 1]!.text === "") logical.splice(index, 1);
    }
    while (logical.length > 0 && logical[0]!.text === "") logical.shift();

    // 运行中的状态行只作为活动区尾部显示，不进日志；本轮结束时它才落账（排在回复之后）。
    // 主视图在等待模型时已经有 Thinking 那一行（带秒数和工具结果数），再叠一行「正在执行」纯属重复。
    if (this.currentTurn !== undefined && this.currentTurn.endedAt === undefined && !(flat && this.thinking)) {
      // 状态行是独立的一块，和上面的正文之间留一行：贴着正文会读成同一段话的续行。
      if (logical.length > 0 && logical[logical.length - 1]!.text !== "") {
        logical.push({ text: "", tone: "plain" });
      }
      logical.push({ ...this.turnStatusLine(this.currentTurn, flat), kind: "turn-status", turn: this.currentTurn });
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
    // 只有一种权限：这里陈述事实，不再暗示可以切换。
    const accessTone: Tone = "warning";
    const scrollPrefix = `${this.glyphs.scroll} ${this.scrollOffset} ${this.uiText("lines", "行")}`;
    const historyWarning = this.historyTrimmedNotice
      ? this.uiText(" [history truncated]", "【历史已截断】") : "";
    const baseLabel = (this.scrollOffset > 0
      ? `${scrollPrefix} · ${this.accessLabel()}`
      : this.accessLabel()) + historyWarning;
    let left = baseLabel;
    const innerWidth = Math.max(1, width - RIGHT_MARGIN);
    let right = this.formatSessionStats(innerWidth >= 60);

    // 优先保留完整统计，空间不足时再逐级缩短左侧说明。
    if (displayWidth(left) + displayWidth(right) + 1 > innerWidth) {
      right = this.formatSessionStats(false);
    }
    if (displayWidth(left) + displayWidth(right) + 1 > innerWidth) {
      left = baseLabel;
      if (this.scrollOffset > 0 && displayWidth(left) + displayWidth(right) + 1 > innerWidth) left = scrollPrefix;
    }
    if (displayWidth(left) + displayWidth(right) + 1 > innerWidth) {
      const requests = formatNumber(this.stats?.requests ?? 0);
      const lower = (this.stats?.usage.unknown ?? 0) > 0 ? ">=" : "";
      right = `${requests}r ${lower}${formatNumber(this.stats?.usage.totalTokens ?? 0)}tok`;
    }

    // 运行中才提示「怎么中断」：它属于全局状态，放状态栏；放进内容流就是每帧重复一行。
    // 用内容宽度判断而不是逐项量宽：状态栏本身会被 clip 兜底，这里只决定要不要加这一段。
    if (this.currentTurn !== undefined && this.currentTurn.endedAt === undefined && this.contentWidth() >= 40) {
      right = `${right} · ${this.uiText("Ctrl-C cancel", "Ctrl-C 取消")}`;
    }

    const rightText = clip(right, Math.max(1, innerWidth));
    const leftText = clip(left, Math.max(1, innerWidth - displayWidth(rightText) - 1));
    const gap = Math.max(1, innerWidth - displayWidth(leftText) - displayWidth(rightText));
    return (
      this.style.paint(this.scrollOffset > 0 ? "warning" : accessTone, leftText) +
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
    // 宽度必须取「真实终端」和「构造时记录的宽度」的较小值：窗口缩小时 stream.columns
    // 可能比 this.columns 更早更新，一旦按较宽的尺寸排版，行会被终端自动折行，
    // 而我们的行数估算按「一行一行」算——折出来的那一行会让后续清屏整体错位，
    // 表现就是轮次之间的空行被擦掉、续行贴左。
    const stream = this.output as NodeJS.WriteStream;
    const live = typeof stream.columns === "number" && stream.columns > 0 ? stream.columns : this.columns;
    // 留两列而不是一列：终端实际可用宽度可能比我们读到的少 1（滚动条、行尾自动折行、
    // 模糊宽度的中文标点被渲染成两列）。差一列就会让每行多折一行，进而让活动区错位。
    return Math.max(1, Math.min(this.columns, live) - 2);
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
    // 主视图里输入行的位置由 renderInline 用相对移动摆好；绝对行号只属于 transcript 的整屏网格。
    if (!this.transcriptMode) return;
    this.output.write(`\x1b[${this.inputRow};1H`);
  }

  private formatStatus(): string {
    const prefix = `${this.uiText("model", "模型")} ${clip(singleLine(this.model), 24)} | ${this.accessLabel()} | ${this.uiText("workspace", "工作目录")} `;
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

  private readonly mono: boolean;

  private readonly palette: Record<Tone, string>;

  /** 用户消息任务条：前缀色、正文色。底色已经编在这两串里。 */
  private readonly band: { marker: string; body: string };

  constructor(enabled: boolean, rich: boolean, mono = false, theme: TuiTheme = "dark") {
    this.enabled = enabled;
    this.mono = mono;
    // 先按主题选色系，再按终端能力降级。`ansi` 主题就是「要终端自己那套 16 色」，
    // 所以它优先于 rich 探测；浅色主题在没有 256 色的终端上退到 16 色版本。
    this.palette = theme === "light"
      ? (rich ? LIGHT_PALETTE : LIGHT_BASIC_PALETTE)
      : theme === "ansi" || !rich ? BASIC_PALETTE : RICH_PALETTE;
    this.band = theme === "light" ? LIGHT_BAND : DARK_BAND;
  }

  /**
   * 用户消息整行：Claude Code 风格任务条——一块底色、灰色前缀、粗体正文。
   * 先叠一层 16 色退化，能认 256 色的终端再用精确颜色覆盖；
   * 这样传统 conhost 和 Windows Terminal 都能一眼看出「这一行是用户发的」。
   *
   * 深浅两套底色：深色终端用深底白字，浅色终端用浅底黑字。
   * 浅色终端上继续压一块深灰，看着像屏幕上的一块污渍。
   */
  userMessage(text: string, marker = ""): string {
    if (!this.enabled || text === "") return text;
    const markerPaint = this.band.marker;
    const bodyPaint = this.band.body;
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

/**
 * 浅色终端用的 256 色板。
 *
 * 不是把深色板反相——色相要保住，只把亮度压下来：深色板里 `info` 用 250 号近白灰，
 * 在白底上等于没写字；浅色板换成 238 号深灰。`accent` 同理从 215（浅橙）换到 166（深橙）。
 */
const LIGHT_PALETTE: Record<Tone, string> = {
  accent: "38;5;166",
  assistant: "39",
  user: "39",
  muted: "38;5;240",
  success: "38;5;28",
  error: "38;5;160",
  warning: "38;5;130",
  info: "38;5;238",
  plain: "0",
};

/** 浅色终端 + 只有 16 色：黄（33）在白底上几乎读不出来，换成蓝（34）保住对比度。 */
const LIGHT_BASIC_PALETTE: Record<Tone, string> = {
  accent: "34",
  assistant: "39",
  user: "39",
  muted: "90",
  success: "32",
  error: "31",
  warning: "35",
  info: "90",
  plain: "0",
};

/** 深色终端：深灰底 + 白字。 */
const DARK_BAND = {
  marker: "\x1b[37;100m\x1b[38;5;246;48;5;237m",
  body: "\x1b[1;97;100m\x1b[38;5;255;48;5;237m",
};

/** 浅色终端：浅灰底 + 黑字。 */
const LIGHT_BAND = {
  marker: "\x1b[30;47m\x1b[38;5;240;48;5;254m",
  body: "\x1b[1;30;47m\x1b[38;5;235;48;5;254m",
};

function prefersRichColor(): boolean {
  if (process.platform !== "win32") return true;
  if (process.env.WT_SESSION !== undefined && process.env.WT_SESSION !== "") return true;
  if (process.env.COLORTERM !== undefined && process.env.COLORTERM !== "") return true;
  const program = process.env.TERM_PROGRAM;
  return program === "vscode" || program === "WezTerm" || program === "iTerm.app";
}

/** 固定布局只在 stdout 真的是终端时启用；测试里的假输出流可以只开输入、不开布局。 */
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
 * `shell` 显示完整命令的转义文本（多行折成 `\n`），展开详情后才是逐行完整展示。
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
  call: ToolCall, result: string | undefined, language: UiLanguage, finished = false,
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
  // ToolCall 先于真实执行结果到达 TUI；缺少 ToolResult 时不能宣称 Shell 已运行。
  if (result === undefined && name === "shell") {
    return zh ? `正在处理命令请求${target}。` : `Handling command request${target}.`;
  }
  if (result === undefined && (name === "write" || name === "edit")) {
    return zh ? `正在处理文件${name === "write" ? "写入" : "编辑"}请求${target}。`
      : `Handling file ${name === "write" ? "write" : "edit"} request${target}.`;
  }
  const status = result === undefined ? "running" : (() => {
    const summary = summarizeToolResult(call, result);
    return summary.notRun ? "not-run" : summary.failed ? "failed" : "done";
  })();
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
  const error = first.startsWith("ERROR:");
  // CLI 与 TUI 共用一次事实判断；未执行保留自己的展示标记。
  const failed = isToolResultFailure(call, result);
  const body = error ? first.slice("ERROR:".length).trim() : first;
  const more = lines.length > 1 ? " …" : "";
  return { failed, notRun, body, more };
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

  const mark = summary.notRun ? glyphs.notRun : glyphs.error;
  const tone: Tone = summary.notRun ? "muted" : "error";
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
    ? summary.notRun ? "未运行" : summary.failed ? "失败" : "成功"
    : summary.notRun ? "not run" : summary.failed ? "failed" : "ok";
  const mark = summary.failed ? (summary.notRun ? "–" : "✗") : "✓";
  return `${mark} ${call.function.name} [${label}] ${clip(summary.body, 160)}${summary.more}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

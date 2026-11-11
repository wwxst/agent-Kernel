#!/usr/bin/env node
/**
 * 命令行入口：读环境变量 → 组装 Workspace / ToolRegistry / Agent → 跑一次任务或进入 TUI。
 *
 * 用法：
 *   npm run agent -- "给这个仓库加一个 /health 接口并写测试"
 *   npm run agent -- --tui         # 交互式全屏 TUI；不带任务时默认就进这里
 *   node src/cli.ts "解释一下 src/agent.ts 里的循环"
 *   node src/cli.ts --cwd /path/to/other-repo "看看这个项目怎么跑"  # 工作区指向别的目录，不用先 cd
 *
 * 环境变量（可写进 .env，由 --env-file-if-exists 自动加载）：
 *   BASE_URL        OpenAI 兼容端点，默认 https://api.openai.com/v1
 *   API_KEY         必填，也可以用 OPENAI_API_KEY
 *   MODEL           模型名，默认 gpt-4o-mini
 *   WORKDIR         工具能碰的根目录，默认当前目录；--cwd 优先于它
 *   MAX_STEPS       单次 Run 的循环上限，默认 30
 *   MAX_TOOL_CALLS  单次 Run 最多执行多少次工具调用，默认 60
 *   MAX_TOTAL_TOKENS 单次 Run 累计 token 预算，默认 500000；0 表示不限制
 *   MAX_OUTPUT_TOKENS 单次模型响应最多生成多少 token，默认 8192
 *   TOOL_TIMEOUT_MS 单条命令超时，默认 120000
 *   AGENT_VIEW      compact / detailed；也可传 --details
 *   AGENT_VOICE     balanced / energetic / playful / tsundere / curious / gentle / confident
 *   AGENT_TUI_COLOR  mono（默认，只保留用户消息任务条颜色）/ full（状态与提示层次配色）
 *   AGENT_TUI_THEME  dark（默认）/ light（浅色终端）/ ansi（强制 16 色）
 *
 * 这里只做组装，不含任何 agent 逻辑：换模型、换工具集、换提示词，改的都是这一层。
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { askWithSignal, formatApproval } from "./approval.ts";
import { Agent, DEFAULT_SYSTEM_PROMPT } from "./agent.ts";
import type { AgentStats } from "./agent.ts";
import { RunPresenter } from "./cli-presenter.ts";
import type { AgentView, AgentVoice } from "./cli-presenter.ts";
import { ModelConfigError, ModelHttpError, describeError, modelFailure } from "./errors.ts";
import { Llm } from "./llm.ts";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, Permission, approvalGate, isApproved, parsePermissionMode, permissionPrompt } from "./permission.ts";
import type { PermissionApprover, PermissionMode } from "./permission.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { Tui, parseTuiColorMode, parseTuiTheme, uiLanguageFromLocale } from "./tui.ts";
import { PermissionRules } from "./permission-rules.ts";
import type { ToolCall } from "./types.ts";
import { Workspace, createWorkspaceTools } from "./workspace.ts";
import { projectInstructionsPrompt, readProjectInstructions } from "./project-instructions.ts";

/** 帮助文案、错误文案和 usage 共用同一份模式列表，避免四处各写一遍。 */
const PERMISSION_MODE_LIST = PERMISSION_MODES.join(", ");

/** 取第一个 trim 后非空的值；空白的 API_KEY 不能挡住后面的回退。 */
function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** 读一个「正整数」环境变量；写错就抛错，由最外层的 catch 统一收尾。 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    // 中文对照：「{name} 的值 "{raw}" 不合法（需要一个正整数）」
    throw new Error(`invalid ${name}: "${raw}" (expected a positive integer)`);
  }
  return value;
}

/** 读一个「非负整数」环境变量；0 表示关闭这一项限制。 */
function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    // 中文对照：「{name} 的值 "{raw}" 不合法（需要 0 或正整数）」
    throw new Error(`invalid ${name}: "${raw}" (expected 0 or a positive integer)`);
  }
  return value;
}

/** 一次进程的环境配置。读一次、校验一次，TUI 会话里每轮复用。 */
interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 仅标注外部 Mock 演示，不自动启动模拟模型或绕过模型配置。 */
  demo: boolean;
  root: string;
  maxSteps: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxOutputTokens: number;
  toolTimeoutMs: number;
  permission: PermissionMode;
  view: AgentView;
  voice: AgentVoice;
}

/** 角色语气只属于 CLI 展示；输入写错明确报错，不影响模型权限策略。 */
function voiceFromEnv(): AgentVoice {
  const voice = process.env.AGENT_VOICE?.trim() || "balanced";
  switch (voice) {
    case "balanced":
    case "energetic":
    case "playful":
    case "tsundere":
    case "curious":
    case "gentle":
    case "confident":
      return voice;
    default:
      // 中文对照：AGENT_VOICE 的值不合法。
      throw new Error('invalid AGENT_VOICE: "' + voice + '"');
  }
}

function viewFromEnv(): AgentView {
  const view = process.env.AGENT_VIEW?.trim() || "compact";
  if (view === "compact" || view === "detailed") return view;
  // 中文对照：AGENT_VIEW 必须是 compact 或 detailed。
  throw new Error('invalid AGENT_VIEW: "' + view + '" (expected compact or detailed)');
}

function loadConfig(permission: PermissionMode, details: boolean, allowMissingModel = false, cwd?: string): Config {
  // 先 trim 再判空：API_KEY="   " 等于没填，应该继续回退到 OPENAI_API_KEY。
  const candidateKeys = [process.env.API_KEY, process.env.OPENAI_API_KEY];
  const apiKey = firstNonEmpty(...candidateKeys.filter((value) =>
    value?.trim() !== "sk-your-key-here" && value?.trim() !== "your-api-key"));
  if (!apiKey && !allowMissingModel) {
    // 非交互 CLI 仍在请求前显式失败；真实 TUI 显示“未配置模型”，不得产生模型请求。
    throw new ModelConfigError("missing API_KEY (or OPENAI_API_KEY); replace the .env.example placeholder with a real key");
  }

  return {
    apiKey,
    baseUrl: process.env.BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.MODEL?.trim() || "gpt-4o-mini",
    // 显式演示标记仅供外部 Mock 服务展示；不提供内置模拟端点。
    demo: process.env.AGENT_DEMO === "1",
    // 工作区根目录固定成绝对路径，后面所有相对路径都相对它解析。
    // 优先级：--cwd（显式打开的目录）> WORKDIR（环境变量）> 当前目录。
    root: path.resolve(cwd ?? process.env.WORKDIR ?? process.cwd()),
    maxSteps: positiveIntFromEnv("MAX_STEPS", 30),
    maxToolCalls: positiveIntFromEnv("MAX_TOOL_CALLS", 60),
    maxTotalTokens: nonNegativeIntFromEnv("MAX_TOTAL_TOKENS", 500_000),
    maxOutputTokens: positiveIntFromEnv("MAX_OUTPUT_TOKENS", 8192),
    toolTimeoutMs: positiveIntFromEnv("TOOL_TIMEOUT_MS", 120_000),
    permission,
    view: details ? "detailed" : viewFromEnv(),
    voice: voiceFromEnv(),
  };
}

/** 一次进程的启动参数。和 Config 分开：命令行是输入，Config 是校验后的运行配置。 */
interface CliArgs {
  help: boolean;
  tui: boolean;
  details: boolean;
  permission: PermissionMode;
  /** 已解析成绝对路径的工作区根目录；没给就是 undefined，回落到 WORKDIR / 当前目录。 */
  cwd?: string;
  task: string;
  error?: string;
}

/** 只判断「是不是一个已存在的目录」：路径越界由 Workspace 负责，这里只管启动参数写没写对。 */
function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析命令行：`--permission` / `--cwd` 支持空格和等号两种写法，剩下的位置参数拼成任务文本。
 *
 * 不用现成的参数解析库：运行时零依赖，而且这里只有几个选项。
 * 模式在解析时就校验，非法值不会拖到 loadConfig 之后才报。
 */
function parseArgs(argv: readonly string[]): CliArgs {
  let help = false;
  let tui = false;
  let details = false;
  let permission: PermissionMode = DEFAULT_PERMISSION_MODE;
  let cwd: string | undefined;
  const taskParts: string[] = [];

  const result = (error?: string): CliArgs => ({
    help,
    tui,
    details,
    permission,
    cwd,
    task: taskParts.join(" ").trim(),
    error,
  });

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--tui") {
      tui = true;
      continue;
    }
    if (arg === "--details") {
      details = true;
      continue;
    }
    if (arg === "--permission" || arg.startsWith("--permission=")) {
      let raw: string | undefined;
      if (arg === "--permission") {
        index++;
        raw = argv[index];
      } else {
        raw = arg.slice("--permission=".length);
      }
      if (raw === undefined || raw === "" || raw.startsWith("--")) {
        return result(`missing value for --permission (expected: ${PERMISSION_MODE_LIST})`);
      }
      const parsed = parsePermissionMode(raw);
      if (parsed === undefined) {
        return result(`invalid --permission value "${raw}" (expected: ${PERMISSION_MODE_LIST})`);
      }
      permission = parsed;
      continue;
    }
    // 这就是 Claude Code / Codex 的「打开某个目录」：从本仓库启动，但把工作区根目录指向别处。
    // 不这么做就只能把整个 agent 复制到目标目录里跑，源码和 .env 会被一起带过去。
    if (arg === "--cwd" || arg === "-C" || arg.startsWith("--cwd=")) {
      let raw: string | undefined;
      if (arg.startsWith("--cwd=")) {
        raw = arg.slice("--cwd=".length);
      } else {
        index++;
        raw = argv[index];
      }
      if (raw === undefined || raw === "" || raw.startsWith("--")) {
        return result("missing value for --cwd (expected a directory)");
      }
      // 启动前就解析成绝对路径并确认存在：写错目录名时立刻报错，而不是等第一次工具调用才炸。
      const resolved = path.resolve(raw);
      if (!isDirectory(resolved)) {
        return result(`--cwd is not a directory: ${raw}`);
      }
      cwd = resolved;
      continue;
    }
    // --repl 已经移除。不能把它当普通任务文本吞下去：那会拿 "--repl" 当任务发给模型，
    // 用户以为进了会话，实际是一次莫名其妙的请求。
    if (arg === "--repl" || arg.startsWith("--repl=")) {
      return result("--repl was removed; the full-screen TUI is the only interactive mode (run without a task, or pass --tui)");
    }
    // 其余位置参数保留原样：任务文本里可以有空格，最后统一 join。
    taskParts.push(arg);
  }

  return result();
}

/** 审批提示要求 stdin / stdout 都是 TTY：没有输出终端没法问，没有输入终端没法答。 */
function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

interface ApprovalPrompt {
  /** 无 TTY 时没有审批通道：故意不给函数，让 Permission 报「没有审批提示」而不是「用户拒绝」。 */
  approve?: PermissionApprover;
  close(): void;
}

/**
 * 一次性任务里的审批通道。
 *
 * readline 要到第一次真正需要审批时才创建：它在终端模式下会进入 raw mode，
 * 一创建就会抢走 Ctrl-C。没有 shell 调用的任务不该因为「可能审批」而改变取消行为。
 *
 * 非交互进程（管道、CI、评测）没有 TTY：直接拒绝，不读 stdin。
 * 读 stdin 会把管道里后续的任务行当成审批答案，既错位又危险。
 */
function createApprovalPrompt(controller: AbortController, cwd: string): ApprovalPrompt {
  const signal = controller.signal;
  const gate = approvalGate(signal, hasInteractiveTerminal(), false);
  if (!gate.ask) {
    return { close: () => {} };
  }

  let rl: ReturnType<typeof createInterface> | undefined;

  const open = (): ReturnType<typeof createInterface> => {
    if (rl !== undefined) return rl;
    const created = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // readline 在终端模式下会自己处理 Ctrl-C，进程收不到 SIGINT。审批期间仍然要停掉整个会话，
    // 所以显式 abort 同一个 controller，走和普通任务一样的取消链。
    created.on("SIGINT", () => {
      controller.abort(new Error("received SIGINT"));
      created.close();
    });
    rl = created;
    return created;
  };

  return {
    approve: async (request) => {
      const gate = approvalGate(signal, hasInteractiveTerminal(), false);
      if (!gate.ask) throw new Error(`shell approval skipped: ${gate.reason}`);
      // 等待被 abort / close / 正常回答三者之一收口；不再直接等一个不接 signal 的 question。
      const answer = await askWithSignal(open(), formatApproval(request, cwd), signal);
      return isApproved(answer);
    },
    close: () => {
      rl?.close();
    },
  };
}

/** 非 TUI 错误也提供简短解决方向，原始详情保留在同一行供日志检索。 */
function describeForUser(error: unknown): string {
  const failure = modelFailure(error, "en");
  return failure === undefined ? describeError(error)
    : `${failure.title}: ${failure.advice} [detail: ${failure.detail}]`;
}

/** 一次只显示一个普通 CLI Run；TUI 通过 callbacks 走自己的展示层。 */
let activePresenter: RunPresenter | undefined;

/**
 * 交互壳可以替换的三个显示回调。默认实现写 console / stdout（一次性任务）；
 * TUI 传入自己的版本，让同一份 Agent 装配逻辑不直接绑定输出方式。
 */
/** 只对聊天式 TUI 的可见进度说明提供轻量引导；不新增请求或修改 Agent 循环。 */
const TUI_PROGRESS_GUIDANCE = [
  // 在重要的一组工具调用之前，向用户简短说明当前准备做什么。
  "In this interactive TUI, briefly tell the user what you are doing before a meaningful group of tool calls.",
  // 有实际结果以后，简短说明观察到的结果，以及已经明确的下一步。
  "After a meaningful result, briefly explain the observed outcome and your next step if known.",
  // 用用户的语言，每次只说一句；合并相关操作，不逐个工具播报。
  "Keep each visible progress update to one short sentence in the user's language; group related operations instead of narrating every tool.",
  // 只说有证据的事实和计划；不伪造结果，也不暴露模型内部推理。
  "Only describe verified facts and plans, never invent results or reveal private chain-of-thought.",
  // 正式回答与临时进度说明分离。
  "Keep the final response separate from these progress updates.",
].join(" ");

interface AgentCallbacks {
  onRequestStart?: (step: number) => void;
  onToolCall?: (call: ToolCall, confirmedContent: string | null) => void;
  onToolResult?: (call: ToolCall, result: string) => void;
  onDelta?: (text: string) => void;
  onRetry?: (error: unknown, attempt: number, maxRetries: number) => void;
}

/**
 * 组装一个 Agent。TUI 的 /reset 也走这里 —— 换一个全新的 Agent，
 * 但复用同一份配置和取消信号（Ctrl-C 应该停掉整个进程，而不是只停一轮）。
 *
 * signal 是这次会话唯一的取消源：同一个 controller 交给 Agent、Llm、Workspace，
 * 三处各自响应 —— 循环停手、HTTP 断开、进程树被杀。取消链上没有第二个管理器。
 *
 * `announce: false` 只给 TUI 用：TUI 头部/页脚已经显示模型/工作区/权限，不再往运行记录里
 * 打一遍启动 banner。
 */
function createAgent(
  config: Config,
  signal: AbortSignal,
  permission: Permission,
  options: { announce?: boolean; callbacks?: AgentCallbacks; narrateProgress?: boolean;
    onEditCommitted?: (path: string, before: string, after: string) => void;
    onWriteCommitted?: (path: string, before: string | undefined, after: string | undefined, created: boolean) => void;
    onImageRead?: (path: string, bytes: Buffer) => void } = {},
): Agent {
  const tools = new ToolRegistry(
    createWorkspaceTools(new Workspace({ root: config.root, timeoutMs: config.toolTimeoutMs, signal,
      onEditCommitted: options.onEditCommitted, onWriteCommitted: options.onWriteCommitted,
      onImageRead: options.onImageRead })),
    { permission },
  );

  if (options.announce !== false) {
    // 中文对照：工作区：… ／ 模型：… ／ 权限：… ／ 工具：…
    console.log(`workspace: ${config.root}`);
    console.log(`model:     ${config.model}`);
    if (config.demo) console.log("mode:      demo (external mock; connection not verified)");
    console.log(`permission: ${permission.mode}`);
    console.log(`tools:     ${tools.definitions.map((tool) => tool.name).join(", ")}\n`);
  }

  const callbacks = options.callbacks;

  // 项目指令：仓库里的 AGENTS.md 注入系统提示（Claude Code 读 CLAUDE.md、Codex 读 AGENTS.md 的同类机制）。
  // 启动时读一次；文件不存在就是「没有项目规范」，不是错误。
  const projectInstructions = readProjectInstructions(config.root);

  return new Agent({
    llm: new Llm({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxOutputTokens: config.maxOutputTokens,
      signal,
      // 交互式 CLI 用流式：模型一开口就能看到字，不必等整段生成完。
      stream: true,
    }),
    tools,
    // 权限说明只指导模型；真正的放行/拒绝仍由 ToolRegistry 执行。
    // 函数在每次请求前求值，/permission 切换后下一次请求自动使用新规则。
    systemPrompt: () => `${DEFAULT_SYSTEM_PROMPT}\n\n${permissionPrompt(permission.mode)}${projectInstructions === undefined ? "" : `\n\n${projectInstructionsPrompt(projectInstructions)}`}${options.narrateProgress ? `\n\n${TUI_PROGRESS_GUIDANCE}` : ""}`,
    maxSteps: config.maxSteps,
    maxToolCalls: config.maxToolCalls,
    maxTotalTokens: config.maxTotalTokens === 0 ? undefined : config.maxTotalTokens,
    signal,
    // 只在 TUI 启用有界暂时故障重试；其它 CLI/评测继续保持一次一请求。
    maxModelRetries: callbacks?.onRetry === undefined ? 0 : 5,
    onRetry: callbacks?.onRetry,
    // 每次模型请求/工具调用只有一个开始通知；CLI 和 TUI 共享事实，展示实现仍各自负责。
    onRequestStart: callbacks?.onRequestStart ?? ((step) => activePresenter?.thinking(step)),
    onToolCall: callbacks?.onToolCall ?? ((call, content) => {
      activePresenter?.confirmAssistant(content);
      activePresenter?.toolStart(call);
    }),
    onToolResult: callbacks?.onToolResult ?? ((call, result) => activePresenter?.toolResult(call, result)),
    // CLI 显示在 RunPresenter；TUI 使用自己提供的流式回调。
    onDelta: callbacks?.onDelta ?? ((text) => activePresenter?.delta(text)),
  });
}

/**
 * 跑一轮任务（一次 Run），打印最终回复和这一轮的账单。
 *
 * 失败时先打 usage 再抛：失败的任务同样花了 token，账单不能因为异常就消失。
 */
async function runTurn(agent: Agent, task: string, config: Config, signal: AbortSignal): Promise<void> {
  const presenter = new RunPresenter(config.view, config.voice);
  activePresenter = presenter;
  presenter.start();
  const transcriptStart = agent.transcript.length;
  try {
    const reply = await agent.run(task);
    presenter.finalAnswer(reply.content ?? "");
    presenter.finish(agent.stats.toolCalls);
    printUsage(agent.stats, { failed: false });
  } catch (error) {
    // 预算阻断可能已经确认模型正文；请求中断时则必须明确宣布临时增量无效。
    const confirmed = agent.transcript.slice(transcriptStart)
      .filter((message) => message.role === "assistant");
    const latest = confirmed.length === agent.stats.requests - agent.retryAttempts ? confirmed.at(-1) : undefined;
    if (latest !== undefined) presenter.confirmAssistant(latest.content);
    else presenter.discardAssistantDraft(modelFailure(error, "en") === undefined);
    presenter.finish(agent.stats.toolCalls, signal.aborted, true);
    printUsage(agent.stats, { failed: true });
    throw error;
  } finally {
    activePresenter = undefined;
  }
}

/**
 * 打印成本摘要。成功和失败都打：失败的任务同样花了 token，隐藏它等于丢掉账单。
 *
 * usage 缺失时写 at least，绝不把「已统计到的」说成「实际花的」；
 * 软预算超了也写出来，因为任务可能已经成功返回。
 */
function printUsage(stats: AgentStats, { failed }: { failed: boolean }): void {
  const lower = stats.usage.unknown > 0 ? "at least " : "";
  const unknown = stats.usage.unknown > 0 ? ` · ${stats.usage.unknown} request(s) without usage` : "";
  const overBudget = stats.tokenBudget.exceeded ? ` · budget exceeded (limit=${stats.tokenBudget.limit})` : "";
  const outcome = failed ? " · task failed" : "";
  console.log(
    `\n[usage] requests=${stats.requests} tool_calls=${stats.toolCalls} ` +
      `tokens=${lower}${stats.usage.totalTokens} (prompt=${lower}${stats.usage.promptTokens} ` +
      `completion=${lower}${stats.usage.completionTokens})${unknown}${overBudget}${outcome}`,
  );
}

/**
 * TUI 两条路径共用同一套会话命令解析：固定栏位模式，以及非 TTY 的逐行输出模式。
 *
 * 两种显示方式不同（运行记录 vs console），但「/exit 是退出、/permission 后面
 * 跟什么、非法模式怎么报」这类规则只能有一份；否则两条路径会悄悄分叉。
 */
type SessionCommand =
  | { kind: "exit" | "help" | "reset" | "task" }
  | { kind: "permission"; mode?: PermissionMode; value?: string };

function parseSessionCommand(input: string): SessionCommand {
  if (input === "/exit" || input === "/quit") return { kind: "exit" };
  if (input === "/help") return { kind: "help" };
  if (input === "/reset") return { kind: "reset" };

  const permissionCommand = input.match(/^\/permission(?:\s+(.*))?$/);
  if (permissionCommand === null) return { kind: "task" };

  const value = (permissionCommand[1] ?? "").trim();
  if (value === "") return { kind: "permission" };
  const mode = parsePermissionMode(value);
  // 非法值保留原文，交给各壳用同一份可用模式列表报错。
  return mode === undefined ? { kind: "permission", value } : { kind: "permission", mode };
}

/**
 * 轻量 TUI 会话：同一个 Agent / Permission / 取消链，只把显示和输入换成 Tui。
 *
 * TUI 是外壳，不是内核：Transcript、预算、工具配对仍由 Agent 管；审批仍由 Permission 决定。
 * `--tui` 可以带一个初始任务（先跑完再等输入），之后每一行输入是一次 Run。
 * `/reset` 换 Agent 但不换 Permission；`/permission` 切换后页脚和下一次请求同时生效。
 */
async function tuiSession(config: Config, controller: AbortController, initialTask?: string): Promise<void> {
  const signal = controller.signal;
  const interactive = hasInteractiveTerminal();
  // 交互式终端按系统语言初始化界面；管道/CI 保持英文，脚本和端到端断言不随机器语言漂移。
  const initialLanguage = interactive
    ? uiLanguageFromLocale(Intl.DateTimeFormat().resolvedOptions().locale)
    : "en";
  const tui = new Tui({
    input: process.stdin,
    output: process.stdout,
    model: config.apiKey === "" ? "未配置模型"
      : config.demo ? `${config.model} [demo: external mock]` : config.model,
    workspace: config.root,
    permission: config.permission,
    controller,
    interactive,
    language: initialLanguage,
    // Shift+Tab 只发起模式切换；Permission 是唯一的执行授权源。
    // Agent 每次请求动态读取此 Permission，因此下一轮模型提示自动同步。
    onPermissionChange: (mode) => {
      permission.setMode(mode);
      tui.setPermission(mode);
    },
    // 短对话贴近输入框，内容多时再停靠底部。
    flowInput: true,
    colorMode: parseTuiColorMode(process.env.AGENT_TUI_COLOR),
    theme: parseTuiTheme(process.env.AGENT_TUI_THEME),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  });

  // 审批和任务输入共用 Tui 的同一个 readline/行队列；权限策略本身仍是会话级对象。
  // 无 TTY 时不注入审批器：Permission 会明确说「没有审批通道」，而不是把
  // 「读不到终端」误报成「审批失败」或「用户拒绝」。
  // 规则文件坏了在这里就抛：一份读不懂的安全配置不能当成「没有规则」继续跑。
  const rules = await PermissionRules.load(config.root);
  const permission = new Permission(
    config.permission,
    interactive ? (request) => tui.approve(request) : undefined,
    rules,
  );

  // Agent 在回调创建时还没赋值，但回调只会在 run() 期间触发；用 current 拿最新实例的账。
  let current: Agent | undefined;
  // 工具开始展示时会把本次 assistant 段落提交到运行记录；Run 后续失败不能重复补写。
  let toolStartedInLatestResponse = false;
  // ToolRegistry 串行执行每条调用；只把该次真实 edit 提交对应到当前 ToolCall。
  let pendingEditId: string | undefined;
  let pendingWriteId: string | undefined;
  let pendingImageId: string | undefined;
  const callbacks: AgentCallbacks = {
    onRequestStart: () => {
      toolStartedInLatestResponse = false;
      pendingEditId = undefined;
      pendingWriteId = undefined;
      pendingImageId = undefined;
      tui.beginModelRequest();
      tui.setThinking(true);
    },
    onToolCall: (call, confirmedContent) => {
      // 同一条 assistant 可以带多个工具；只确认一次阶段说明，不能重复展示。
      if (!toolStartedInLatestResponse) tui.confirmAssistant(confirmedContent);
      toolStartedInLatestResponse = true;
      pendingEditId = call.function.name === "edit" ? call.id : undefined;
      pendingWriteId = call.function.name === "write" ? call.id : undefined;
      pendingImageId = call.function.name === "read" ? call.id : undefined;
      tui.toolCall(call);
      if (current !== undefined) tui.setStats(current.sessionStats);
    },
    onToolResult: (call, result) => {
      if (call.id === pendingEditId) pendingEditId = undefined;
      if (call.id === pendingWriteId) pendingWriteId = undefined;
      if (call.id === pendingImageId) pendingImageId = undefined;
      tui.toolResult(call, result);
      if (current !== undefined) tui.setStats(current.sessionStats);
    },
    onDelta: (text) => tui.assistantDelta(text),
    onRetry: (_error, attempt, maxRetries) => tui.setRetrying(attempt, maxRetries),
  };

  const newAgent = (): Agent => {
    current = createAgent(config, signal, permission, { announce: false, callbacks, narrateProgress: true,
      onEditCommitted: (path, before, after) => {
        if (pendingEditId !== undefined) tui.recordEditDiff(pendingEditId, path, before, after);
      },
      onWriteCommitted: (path, before, after, created) => {
        if (pendingWriteId !== undefined) tui.recordEditDiff(pendingWriteId, path, before, after, created);
      },
      onImageRead: (path, bytes) => {
        if (pendingImageId !== undefined) tui.recordImagePreview(pendingImageId, path, bytes);
      },
    });
    return current;
  };

  let agent: Agent;
  try {
    agent = newAgent();
    tui.start();
    tui.setStats(agent.sessionStats);
  } catch (error) {
    // 装配/画屏幕失败也要把终端还原，不能把 shell 留在 raw mode。
    tui.close();
    throw error;
  }

  /** 跑一轮；返回 false 表示取消，循环该停了。失败但不取消时返回 true。 */
  const runTask = async (task: string, showTask?: boolean): Promise<boolean> => {
    if (config.apiKey === "") {
      // 未配置不是一次 Agent Run；不进入 Thinking、也不产生虚假的请求或账单。
      tui.logError(tui.uiText("Model not configured · set API_KEY in .env", "未配置模型，请在 .env 中设置 API_KEY"));
      return true;
    }
    // Transcript 跨多个 Run 累积；只检查当前 Run 的响应，不把先前的正式回复当成新草稿。
    const transcriptStart = agent.transcript.length;
    tui.beginTurn(task, showTask === undefined ? {} : { show: showTask });
    try {
      const reply = await agent.run(task);
      // 只有 Agent.run 的最终回复独立于可折叠的执行时间线；工具前阶段说明保持原位。
      tui.confirmAssistant(reply.content, true);
      tui.finishTurn(agent.stats, agent.sessionStats, { failed: false });
      return true;
    } catch (error) {
      // 每次模型请求至多写入一条确认的 assistant 消息；请求计数也包含流式失败的请求。
      // 数量相等说明最后一次响应已写入 Transcript，预算后置失败不应抹去其真实正文。
      // 数量不等说明最新响应仍未确认，必须丢弃其临时增量，不能复用先前请求的正文。
      const failure = modelFailure(error, tui.uiText("en", "zh") === "zh" ? "zh" : "en");
      const confirmed = agent.transcript.slice(transcriptStart)
        .filter((message) => message.role === "assistant");
      const latest = confirmed.length === agent.stats.requests - agent.retryAttempts ? confirmed.at(-1) : undefined;
      if (latest?.content?.trim()) {
        // onToolCall 已提交该段正文时不要重复提交；预算阻断的调用则还没有这一事件。
        if (!toolStartedInLatestResponse) tui.confirmAssistant(latest.content);
      } else {
        // 已分类的模型异常在同一错误区块解释，不再叠加一条“流式未确认”警告。
        tui.discardAssistantDraft(failure === undefined);
      }
      // 失败的任务同样花了 token：先结账，再把错误写进运行记录。
      tui.finishTurn(agent.stats, agent.sessionStats, { failed: true, cancelled: signal.aborted });
      if (signal.aborted) {
        tui.logError(`${tui.uiText("[agent] cancelled:", "[agent] 已取消：")} ${describeError(error)}`);
        return false;
      }
      // 一轮失败不等于会话失败：继续等下一行输入。
      if (failure !== undefined) {
        // 真实 HTTP 状态码可见，错误类型仍只占一类；技术原文保留在异常中供 CLI 诊断。
        const code = error instanceof ModelHttpError ? `HTTP ${error.status} · ` : "";
        tui.logError(`${code}${failure.title}：${failure.advice}`);
      } else {
        tui.logError(`${tui.uiText("[agent] turn failed:", "[agent] 任务失败：")} ${describeError(error)}`);
      }
      return true;
    }
  };

  let keepGoing = true;
  try {
    if (initialTask !== undefined && initialTask !== "") {
      keepGoing = await runTask(initialTask, true);
    }

    while (keepGoing && !signal.aborted) {
      const line = await tui.readLine();
      if (line === null) break;
      const input = line.trim();
      const command = parseSessionCommand(input);

      if (command.kind === "exit") break;
      if (command.kind === "help") {
        tui.logLine(tui.helpText(PERMISSION_MODE_LIST));
        continue;
      }
      if (command.kind === "reset") {
        agent = newAgent();
        tui.logLine(tui.uiText("(session reset)", "（会话已重置）"));
        tui.setStats(agent.sessionStats);
        continue;
      }
      if (command.kind === "permission") {
        if (command.value !== undefined) {
          // 中文对照：未知权限模式 "{值}"（可用：…）
          tui.logError(tui.uiText(
            `unknown permission mode "${command.value}" (expected: ${PERMISSION_MODE_LIST})`,
            `未知权限模式 "${command.value}"（可选：${PERMISSION_MODE_LIST}）`,
          ));
        } else if (command.mode !== undefined) {
          permission.setMode(command.mode);
          tui.setPermission(command.mode);
          tui.logLine(`${tui.uiText("permission: ", "权限：")}${tui.permissionLabel(permission.mode)}`);
        } else {
          tui.logLine(`${tui.uiText("permission: ", "权限：")}${tui.permissionLabel(permission.mode)}`);
        }
        continue;
      }

      if (input === "") continue;
      // 固定布局会清掉 readline 的回显，Tui 自己补 `❯ task`；行式聊天默认不重复。
      keepGoing = await runTask(input);
    }
  } finally {
    // 先写总账再退出：TUI 的日志行比固定栏位更适合作为最后的记录。
    if (agent.sessionStats.runs > 0) tui.sessionSummary(agent.sessionStats);
    tui.close();
  }

  if (signal.aborted) process.exitCode = 130;
}

const usage = [
  // 中文对照：用法：node src/cli.ts "<任务>" [--permission <模式>] [--cwd <目录>]
  'usage: node src/cli.ts "<task>" [--permission <mode>] [--cwd <dir>]',
  // 中文对照：不带任务时进入全屏 TUI（TUI 是唯一的交互界面）
  "       node src/cli.ts [--permission <mode>] [--cwd <dir>]           # no task: full-screen TUI (only interactive mode)",
  // 中文对照：node src/cli.ts --tui [--permission <模式>] [--cwd <目录>] 进入 TUI；可带一个初始任务
  "       node src/cli.ts --tui [--permission <mode>] [--cwd <dir>] [task]  # TUI, optional first task",
  "       node src/cli.ts --details \"<task>\"  # expanded tool logs",
  // 中文对照：--cwd <目录> 把工作区根目录指向另一个目录（等于先 cd 再启动）；优先于 WORKDIR
  "       --cwd <dir>  open another directory as the workspace root (like cd before start); overrides WORKDIR",
  // 中文对照：权限模式：…（默认：…）
  `       modes: ${PERMISSION_MODE_LIST} (default: ${DEFAULT_PERMISSION_MODE})`,
  // 中文对照：环境变量：BASE_URL、API_KEY、MODEL、WORKDIR、MAX_STEPS、MAX_TOOL_CALLS、MAX_TOTAL_TOKENS、MAX_OUTPUT_TOKENS、TOOL_TIMEOUT_MS
  "env:   BASE_URL, API_KEY, MODEL, AGENT_DEMO, WORKDIR, MAX_STEPS, MAX_TOOL_CALLS, MAX_TOTAL_TOKENS, MAX_OUTPUT_TOKENS, TOOL_TIMEOUT_MS, AGENT_VIEW, AGENT_VOICE, AGENT_TUI_COLOR, AGENT_TUI_THEME",
].join("\n");

const cli = parseArgs(process.argv.slice(2));
// 没给任务、又在真终端里：直接进 TUI。TUI 是唯一的交互界面，不再有逐行 REPL。
// 管道/CI 里没有交互输入，给用法更安全；--tui 显式指定时照旧处理它自己的初始任务。
const tuiMode = cli.tui || (cli.task === "" && process.stdin.isTTY === true);

if (cli.error !== undefined) {
  // 中文对照：[agent] 致命错误：{原因}
  console.error(`[agent] fatal: ${cli.error}`);
  console.log(usage);
  process.exitCode = 1;
} else if (cli.help) {
  console.log(usage);
} else if (cli.task === "" && !tuiMode) {
  console.log(usage);
  process.exitCode = 1;
} else {
  // 取消链的起点：Ctrl-C / kill 只做一件事 —— abort 同一个 signal。
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => controller.abort(new Error(`received ${name}`)));
  }

  try {
    const config = loadConfig(cli.permission, cli.details, tuiMode && hasInteractiveTerminal(), cli.cwd);
    if (tuiMode) {
      await tuiSession(config, controller, cli.task === "" ? undefined : cli.task);
    } else {
      const approvalPrompt = createApprovalPrompt(controller, config.root);
      try {
        // 一次性任务同样使用会话级 Permission：审批器负责「怎么问」，Permission 负责「放不放行」。
        // 行式审批没有「以后不再问」那一项（没有菜单可点），但已有的规则照样生效。
        const permission = new Permission(
          config.permission,
          approvalPrompt.approve,
          await PermissionRules.load(config.root),
        );
        await runTurn(createAgent(config, controller.signal, permission), cli.task, config, controller.signal);
      } finally {
        approvalPrompt.close();
      }
    }
  } catch (error) {
    // 取消不是「内核出错」：它有自己的退出码（130 = 被 SIGINT 打断），日志也要分开。
    const cancelled = controller.signal.aborted;
    // 中文对照：[agent] 已取消：{原因} ／ [agent] 致命错误：{原因}
    console.error(`[agent] ${cancelled ? "cancelled" : "fatal"}: ${cancelled ? describeError(error) : describeForUser(error)}`);
    // 不用 process.exit(1)：Windows 上 fetch 的 keep-alive 连接还在关闭时强退，
    // 会触发 libuv 断言（退出码 0xC0000409）。设置退出码后让进程自然结束即可。
    process.exitCode = cancelled ? 130 : 1;
  }
}

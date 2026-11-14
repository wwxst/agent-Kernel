#!/usr/bin/env node
/**
 * 文件目的：程序的入口 —— 读配置，把各个零件装到一起，然后跑一次任务或进入全屏界面。
 *
 * 这里是唯一直接碰 `process` 的地方：命令行参数、环境变量、信号、退出码都收在这一层，
 * 所以内核与界面都不需要知道「自己是被谁启动的」。
 *
 * 文件职责：负责组装与收尾 —— 解析参数与环境变量、创建 `Workspace` / `ToolRegistry` /
 * `Llm` / `Agent` / `Tui` 与 `TodoManager`、装观察回调、把致命错误变成一句人话加非零退出码。
 * 不负责循环逻辑、不负责工具实现、不负责渲染细节。完整的参数与环境变量表在 `README.md`，这里不重复。
 *
 * 内容目录：
 *   - `Config` / `CliArgs` / `AgentCallbacks` / `SessionCommand`：装配用到的几种形状。
 *   - `parseArgs()`：命令行参数；`--permission` / `--repl` 已移除，传入即报错。
 *   - `loadConfig()`：环境变量 → `Config`；占位 API Key 在发请求前就拒绝。
 *   - `createAgent()`：把客户端、工具注册表、系统提示、预算、回调，以及可选的工具调用日志 Hook
 *     装成一个 `Agent`。
 *   - `runTurn()`：跑一次任务并打印结果；`printUsage()`：打印统计。
 *   - `tuiSession()`：TUI 会话，含 `/help`、`/reset` 等命令的分发。
 *   - `describeForUser()`：把模型类错误翻成「标题 + 建议 + 详情」三段。
 *   - 文件末尾：顶层入口 —— 决定进 TUI 还是单次任务，接 SIGINT / SIGTERM，设置退出码。
 *
 * 模块关系：依赖 `core/`（`Agent`、`ToolRegistry`）、`tools/`（`Workspace`、`createWorkspaceTools`）、
 * `model/`（`Llm`、项目指令）、`tools/todo.ts`（任务计划）、`ui/`（`Tui`、`RunPresenter`）、`protocol/`。
 * 由 `bin/agent.mjs`（`npm link` 后的全局命令）与 `test/cli.test.mjs` 启动。
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import { Agent, DEFAULT_SYSTEM_PROMPT } from "./core/agent.ts";
import type { AgentStats } from "./core/agent.ts";
import { RunPresenter } from "./ui/cli-presenter.ts";
import { escapeControlCharacters } from "./ui/text.ts";
import type { AgentView, AgentVoice } from "./ui/cli-presenter.ts";
import { ModelConfigError, ModelHttpError, describeError, modelFailure } from "./protocol/errors.ts";
import { Llm } from "./model/llm.ts";
import { ToolRegistry } from "./core/tool-registry.ts";
import { ToolHooks } from "./core/tool-hooks.ts";
import { createToolLogHooks } from "./core/tool-log.ts";
import { Tui, parseTuiColorMode, parseTuiTheme, uiLanguageFromLocale } from "./ui/tui.ts";
import type { ToolCall } from "./protocol/types.ts";
import { Workspace, createWorkspaceTools } from "./tools/workspace.ts";
import { TodoManager, createTodoTool, TODO_PLANNING_GUIDANCE } from "./tools/todo.ts";
import { projectInstructionsPrompt, readProjectInstructions } from "./model/project-instructions.ts";

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

function loadConfig(details: boolean, allowMissingModel = false, cwd?: string): Config {
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
    view: details ? "detailed" : viewFromEnv(),
    voice: voiceFromEnv(),
  };
}

/** 一次进程的启动参数。和 Config 分开：命令行是输入，Config 是校验后的运行配置。 */
interface CliArgs {
  help: boolean;
  tui: boolean;
  details: boolean;
  /** 已解析成绝对路径的工作区根目录；没给就是 undefined，回落到 WORKDIR / 当前目录。 */
  cwd?: string;
  task: string;
  error?: string;
}

/** 只判断「是不是一个已存在的目录」：完全访问不设路径边界，这里只管启动参数写没写对。 */
function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析命令行：`--cwd` 支持空格和等号两种写法，剩下的位置参数拼成任务文本。
 *
 * 不用现成的参数解析库：运行时零依赖，而且这里只有几个选项。
 * 已移除的选项（`--permission` / `--repl`）在解析时就报错，不会被当成任务文本。
 */
function parseArgs(argv: readonly string[]): CliArgs {
  let help = false;
  let tui = false;
  let details = false;
  let cwd: string | undefined;
  const taskParts: string[] = [];

  const result = (error?: string): CliArgs => ({
    help,
    tui,
    details,
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
    // 权限模式已经移除：现在只有 Full Access。显式传入要报错，不能把它当成任务文本，
    // 否则用户以为在限制权限，实际只是把 "--permission" 当成任务发给了模型。
    if (arg === "--permission" || arg.startsWith("--permission=")) {
      return result("--permission was removed; agent-Kernel always runs with full access");
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

  // AGENT_PERMISSION 也已移除：配置残留不能被静默忽略，否则用户会以为它还在生效。
  if (process.env.AGENT_PERMISSION !== undefined && process.env.AGENT_PERMISSION !== "") {
    return result("AGENT_PERMISSION was removed; agent-Kernel always runs with full access");
  }

  return result();
}

/** TUI 需要 stdin / stdout 都是 TTY：没有输出终端没法画，没有输入终端没法交互。 */
function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
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
  onToolResult?: (call: ToolCall, result: string, isError: boolean) => void;
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
 * `announce: false` 只给 TUI 用：TUI 头部/页脚已经显示模型/工作区，不再往运行记录里
 * 打一遍启动 banner。
 */
function createAgent(
  config: Config,
  signal: AbortSignal,
  options: { announce?: boolean; callbacks?: AgentCallbacks; narrateProgress?: boolean;
    onEditCommitted?: (path: string, before: string, after: string) => void;
    onWriteCommitted?: (path: string, before: string | undefined, after: string | undefined, created: boolean) => void;
    onImageRead?: (path: string, bytes: Buffer) => void } = {},
): Agent {
  // 工具调用日志：设了 AGENT_TOOL_LOG 才登记 Hook，不设就完全没变化（空执行器）。
  // 它挂在唯一的执行入口上，所以所有内置工具自动全部记到，不用逐个接线。
  const toolLogPath = process.env.AGENT_TOOL_LOG?.trim() ?? "";
  const hooks = toolLogPath === "" ? undefined : new ToolHooks(createToolLogHooks(toolLogPath));

  const workspace = new Workspace({ root: config.root, timeoutMs: config.toolTimeoutMs, signal,
    onEditCommitted: options.onEditCommitted, onWriteCommitted: options.onWriteCommitted,
    onImageRead: options.onImageRead });
  const tools = new ToolRegistry(
    [...createWorkspaceTools(workspace), createTodoTool(new TodoManager())],
    hooks,
  );

  if (options.announce !== false) {
    // 中文对照：默认目录：… ／ 模型：… ／ 访问级别：… ／ 工具：…
    console.log(`workspace: ${config.root}`);
    console.log(`model:     ${config.model}`);
    if (config.demo) console.log("mode:      demo (external mock; connection not verified)");
    console.log(`access:    full-access (no approvals, no workspace sandbox)`);
    console.log(`tools:     ${tools.definitions.map((tool) => tool.name).join(", ")}`);
    if (hooks !== undefined) console.log(`tool log:  ${toolLogPath}`);
    console.log("");
  }

  const callbacks = options.callbacks;

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
    // 函数在每次请求前求值：项目指令变化后，下一次请求立即看到新内容。
    systemPrompt: () => {
      // AGENTS.md 可能被本轮工具或用户修改；每次请求重新读取，不能闭包缓存旧正文。
      const projectInstructions = readProjectInstructions(config.root);
      return `${DEFAULT_SYSTEM_PROMPT}\n\n${TODO_PLANNING_GUIDANCE}${projectInstructions === undefined ? "" : `\n\n${projectInstructionsPrompt(projectInstructions)}`}${options.narrateProgress ? `\n\n${TUI_PROGRESS_GUIDANCE}` : ""}`;
    },
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
    onToolResult: callbacks?.onToolResult ?? ((call, result, isError) => activePresenter?.toolResult(call, result, isError)),
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
 * 两种显示方式不同（运行记录 vs console），但「/exit 是退出、/reset 重建 Agent」
 * 这类规则只能有一份；否则两条路径会悄悄分叉。
 */
type SessionCommand = { kind: "exit" | "help" | "reset" | "task" };

function parseSessionCommand(input: string): SessionCommand {
  if (input === "/exit" || input === "/quit") return { kind: "exit" };
  if (input === "/help") return { kind: "help" };
  if (input === "/reset") return { kind: "reset" };
  return { kind: "task" };
}

/**
 * 轻量 TUI 会话：同一个 Agent / 取消链，只把显示和输入换成 Tui。
 *
 * TUI 是外壳，不是内核：Transcript、预算、工具配对仍由 Agent 管。
 * `--tui` 可以带一个初始任务（先跑完再等输入），之后每一行输入是一次 Run。
 * `/reset` 换一个全新的 Agent，复用同一份配置与取消信号。
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
    controller,
    interactive,
    language: initialLanguage,
    // 短对话贴近输入框，内容多时再停靠底部。
    flowInput: true,
    colorMode: parseTuiColorMode(process.env.AGENT_TUI_COLOR),
    theme: parseTuiTheme(process.env.AGENT_TUI_THEME),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  });

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
    onToolResult: (call, result, isError) => {
      if (call.id === pendingEditId) pendingEditId = undefined;
      if (call.id === pendingWriteId) pendingWriteId = undefined;
      if (call.id === pendingImageId) pendingImageId = undefined;
      tui.toolResult(call, result, isError);
      if (current !== undefined) tui.setStats(current.sessionStats);
    },
    onDelta: (text) => tui.assistantDelta(text),
    onRetry: (_error, attempt, maxRetries) => tui.setRetrying(attempt, maxRetries),
  };

  const newAgent = (): Agent => {
    current = createAgent(config, signal, { announce: false, callbacks, narrateProgress: true,
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
        tui.logLine(tui.helpText());
        continue;
      }
      if (command.kind === "reset") {
        agent = newAgent();
        tui.logLine(tui.uiText("(session reset)", "（会话已重置）"));
        tui.setStats(agent.sessionStats);
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
  // 中文对照：用法：node src/cli.ts "<任务>" [--cwd <目录>]
  'usage: node src/cli.ts "<task>" [--cwd <dir>]',
  // 中文对照：不带任务时进入全屏 TUI（TUI 是唯一的交互界面）
  "       node src/cli.ts [--cwd <dir>]           # no task: full-screen TUI (only interactive mode)",
  // 中文对照：node src/cli.ts --tui [--cwd <目录>] 进入 TUI；可带一个初始任务
  "       node src/cli.ts --tui [--cwd <dir>] [task]  # TUI, optional first task",
  "       node src/cli.ts --details \"<task>\"  # expanded tool logs",
  // 中文对照：--cwd <目录> 把工作区根目录指向另一个目录（等于先 cd 再启动）；优先于 WORKDIR
  "       --cwd <dir>  use another directory as the default for relative paths (like cd before start); overrides WORKDIR",
  // 中文对照：权限固定为完全访问：没有审批，也没有工作区沙箱。
  "       access: full-access only (no approvals, no workspace sandbox)",
  // 中文对照：环境变量：BASE_URL、API_KEY、MODEL、WORKDIR、MAX_STEPS、MAX_TOOL_CALLS、MAX_TOTAL_TOKENS、MAX_OUTPUT_TOKENS、TOOL_TIMEOUT_MS、AGENT_TOOL_LOG
  "env:   BASE_URL, API_KEY, MODEL, AGENT_DEMO, WORKDIR, MAX_STEPS, MAX_TOOL_CALLS, MAX_TOTAL_TOKENS, MAX_OUTPUT_TOKENS, TOOL_TIMEOUT_MS, AGENT_TOOL_LOG, AGENT_VIEW, AGENT_VOICE, AGENT_TUI_COLOR, AGENT_TUI_THEME",
].join("\n");

const cli = parseArgs(process.argv.slice(2));
// 没给任务、又在真终端里：直接进 TUI。TUI 是唯一的交互界面，不再有逐行 REPL。
// 管道/CI 里没有交互输入，给用法更安全；--tui 显式指定时照旧处理它自己的初始任务。
const tuiMode = cli.tui || (cli.task === "" && process.stdin.isTTY === true);

if (cli.error !== undefined) {
  // 中文对照：[agent] 致命错误：{原因}
  console.error(escapeControlCharacters(`[agent] fatal: ${cli.error}`));
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
    const config = loadConfig(cli.details, tuiMode && hasInteractiveTerminal(), cli.cwd);
    if (tuiMode) {
      await tuiSession(config, controller, cli.task === "" ? undefined : cli.task);
    } else {
      await runTurn(createAgent(config, controller.signal), cli.task, config, controller.signal);
    }
  } catch (error) {
    // 取消不是「内核出错」：它有自己的退出码（130 = 被 SIGINT 打断），日志也要分开。
    const cancelled = controller.signal.aborted;
    // 中文对照：[agent] 已取消：{原因} ／ [agent] 致命错误：{原因}
    console.error(escapeControlCharacters(`[agent] ${cancelled ? "cancelled" : "fatal"}: ${cancelled ? describeError(error) : describeForUser(error)}`));
    // 不用 process.exit(1)：Windows 上 fetch 的 keep-alive 连接还在关闭时强退，
    // 会触发 libuv 断言（退出码 0xC0000409）。设置退出码后让进程自然结束即可。
    process.exitCode = cancelled ? 130 : 1;
  }
}

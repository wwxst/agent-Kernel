#!/usr/bin/env node
/**
 * 命令行入口：读环境变量 → 组装 Workspace / ToolRegistry / Agent → 跑一次任务或进入 REPL。
 *
 * 用法：
 *   npm run agent -- "给这个仓库加一个 /health 接口并写测试"
 *   npm run agent -- --repl        # 多轮会话：/exit 退出、/reset 清空上下文、/help 看命令
 *   node src/cli.ts "解释一下 src/agent.ts 里的循环"
 *
 * 环境变量（可写进 .env，由 --env-file-if-exists 自动加载）：
 *   BASE_URL        OpenAI 兼容端点，默认 https://api.openai.com/v1
 *   API_KEY         必填，也可以用 OPENAI_API_KEY
 *   MODEL           模型名，默认 gpt-4o-mini
 *   WORKDIR         工具能碰的根目录，默认当前目录
 *   MAX_STEPS       单次 Run 的循环上限，默认 30
 *   MAX_TOOL_CALLS  单次 Run 最多执行多少次工具调用，默认 60
 *   MAX_TOTAL_TOKENS 单次 Run 累计 token 预算，默认 500000；0 表示不限制
 *   MAX_OUTPUT_TOKENS 单次模型响应最多生成多少 token，默认 8192
 *   TOOL_TIMEOUT_MS 单条命令超时，默认 120000
 *   AGENT_VIEW      compact / detailed；也可传 --details
 *   AGENT_VOICE     balanced / energetic / playful / tsundere / curious / gentle / confident
 *   AGENT_TUI_SCREEN auto（现代终端独立屏幕）/ always（强制）/ never（兼容行式）
 *
 * 这里只做组装，不含任何 agent 逻辑：换模型、换工具集、换提示词，改的都是这一层。
 */
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { askWithSignal, formatApproval } from "./approval.ts";
import { Agent, DEFAULT_SYSTEM_PROMPT } from "./agent.ts";
import type { AgentSessionStats, AgentStats } from "./agent.ts";
import { RunPresenter } from "./cli-presenter.ts";
import type { AgentView, AgentVoice } from "./cli-presenter.ts";
import { ModelConfigError, ModelHttpError, describeError, modelFailure } from "./errors.ts";
import { Llm } from "./llm.ts";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, Permission, approvalGate, isApproved, parsePermissionMode, permissionPrompt } from "./permission.ts";
import type { PermissionApprover, PermissionMode } from "./permission.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { Tui, parseTuiScreenMode } from "./tui.ts";
import type { ToolCall } from "./types.ts";
import { Workspace, createWorkspaceTools } from "./workspace.ts";

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

/** 一次进程的环境配置。读一次、校验一次，REPL 里每轮复用。 */
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

function loadConfig(permission: PermissionMode, details: boolean, allowMissingModel = false): Config {
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
    root: path.resolve(process.env.WORKDIR ?? process.cwd()),
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
  repl: boolean;
  tui: boolean;
  details: boolean;
  permission: PermissionMode;
  task: string;
  error?: string;
}

/**
 * 解析命令行：`--permission` 支持空格和等号两种写法，剩下的位置参数拼成任务文本。
 *
 * 不用现成的参数解析库：运行时零依赖，而且这里只有五个选项。
 * 模式在解析时就校验，非法值不会拖到 loadConfig 之后才报。
 */
function parseArgs(argv: readonly string[]): CliArgs {
  let help = false;
  let repl = false;
  let tui = false;
  let details = false;
  let permission: PermissionMode = DEFAULT_PERMISSION_MODE;
  const taskParts: string[] = [];

  const result = (error?: string): CliArgs => ({
    help,
    repl,
    tui,
    details,
    permission,
    task: taskParts.join(" ").trim(),
    error,
  });

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--repl") {
      repl = true;
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
    // 其余位置参数保留原样：任务文本里可以有空格，最后统一 join。
    taskParts.push(arg);
  }

  // 两个交互壳不能同时选：一个是逐行 REPL，一个是固定栏位 TUI，混在一起没有可解释的行为。
  if (repl && tui) return result("cannot combine --repl and --tui");
  return result();
}

/** 审批和 REPL 提示都要求 stdin / stdout 都是 TTY：没有输出终端没法问，没有输入终端没法答。 */
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

/** 一次只显示一个普通 CLI / REPL Run；TUI 通过 callbacks 走自己的展示层。 */
let activePresenter: RunPresenter | undefined;

/**
 * 交互壳可以替换的三个显示回调。默认实现写 console / stdout（REPL、一次性任务）；
 * TUI 传入自己的版本，让同一份 Agent 装配逻辑不直接绑定输出方式。
 */
interface AgentCallbacks {
  onRequestStart?: (step: number) => void;
  onToolCall?: (call: ToolCall, confirmedContent: string | null) => void;
  onToolResult?: (call: ToolCall, result: string) => void;
  onDelta?: (text: string) => void;
  onRetry?: (error: unknown, attempt: number, maxRetries: number) => void;
}

/**
 * 组装一个 Agent。REPL 的 /reset 也走这里 —— 换一个全新的 Agent，
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
  options: { announce?: boolean; callbacks?: AgentCallbacks } = {},
): Agent {
  const tools = new ToolRegistry(
    createWorkspaceTools(new Workspace({ root: config.root, timeoutMs: config.toolTimeoutMs, signal })),
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
    systemPrompt: () => `${DEFAULT_SYSTEM_PROMPT}\n\n${permissionPrompt(permission.mode)}`,
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

/** 会话结束时的总账：跨 Run 累计，和每一轮的 [usage] 是两个口径。 */
function printSession(stats: AgentSessionStats): void {
  const lower = stats.usage.unknown > 0 ? "at least " : "";
  console.log(
    `\n[session] runs=${stats.runs} requests=${stats.requests} tool_calls=${stats.toolCalls} ` +
      `tokens=${lower}${stats.usage.totalTokens} (prompt=${lower}${stats.usage.promptTokens} ` +
      `completion=${lower}${stats.usage.completionTokens})`,
  );
}

const REPL_HELP = [
  // 中文对照：命令：/exit 退出、/reset 清空上下文并重开一个 Agent、/permission 查看或切换权限、/help 显示这段帮助
  "commands: /exit  quit · /reset  clear the transcript and start a new Agent · /help  show this",
  // 中文对照：/permission [模式] 查看或切换权限（read-only、workspace-write、full-access）
  `          /permission [mode]  show or switch permission (${PERMISSION_MODE_LIST})`,
].join("\n");

/**
 * REPL 和 TUI 共用同一套会话命令解析。
 *
 * 两个壳的输出方式不同（console vs 运行记录），但「/exit 是退出、/permission 后面
 * 跟什么、非法模式怎么报」这类规则只能有一份；否则两个界面会悄悄分叉。
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
 * 多轮会话。
 *
 * 每一行输入是一次 Run；Transcript 留在同一个 Agent 里，所以模型记得前面说过什么。
 * 失败的一轮不会结束会话：打印错误、继续等下一行输入。唯一的例外是取消 ——
 * Ctrl-C 停掉的是整个进程，所以循环跟着退出。
 */
async function repl(config: Config, controller: AbortController): Promise<void> {
  const signal = controller.signal;
  const interactive = process.stdin.isTTY === true;
  const canPrompt = hasInteractiveTerminal();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });

  // readline 在终端模式下会自己处理 Ctrl-C，进程收不到 SIGINT。
  // 显式接住，仍然走同一条取消链：abort 控制器、关掉 readline、循环退出。
  rl.on("SIGINT", () => {
    controller.abort(new Error("received SIGINT"));
    rl.close();
  });

  // 自己维护一条「已读到的行」队列，而不是用 rl.question：
  // 管道输入会在任务还没跑完时就读到 EOF 并 close，question 会直接拒绝，缓冲里的后续行就丢了；
  // for await 又和审批的第二个消费者抢同一行。一个 line 监听器同时服务 REPL 和审批，
  // 谁先 await 谁拿到下一行，顺序才明确。
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let ended = false;

  rl.on("line", (line) => {
    const resolve = waiting.shift();
    if (resolve === undefined) lines.push(line);
    else resolve(line);
  });
  rl.on("close", () => {
    ended = true;
    // close 之后不会再有 line：所有等输入的人统一拿到 null，循环自然结束。
    for (const resolve of waiting.splice(0)) resolve(null);
  });

  const nextLine = (prompt: string): Promise<string | null> => {
    // 和旧 REPL 一样，每次读下一行前画提示符；管道里已经排着行时也不改变输出节奏。
    if (!ended) {
      rl.setPrompt(prompt);
      rl.prompt();
    }
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };

  // 取消发生在「等输入」而不是「跑任务」时，也要能把循环叫醒。
  const onAbort = () => rl.close();
  signal.addEventListener("abort", onAbort, { once: true });

  const approve: PermissionApprover = async (request) => {
    const gate = approvalGate(signal, canPrompt, lines.length > 0);
    if (!gate.ask) throw new Error(`shell approval skipped: ${gate.reason}`);
    const answer = await nextLine(formatApproval(request, config.root));
    if (answer === null) {
      // EOF/readline 关闭不是「用户拒绝」；让 Permission 的 catch 折成审批通道错误。
      throw new Error(
        signal.aborted ? "shell approval skipped: task cancelled" : "shell approval skipped: approval prompt closed",
      );
    }
    return isApproved(answer);
  };

  // 权限是会话级的：/reset 只换 Agent，不换这个对象，所以模式不会被重置。
  // 无 TTY 时不注入审批器：Permission 会明确说「没有审批通道」，而不是假装用户拒绝。
  const permission = new Permission(config.permission, canPrompt ? approve : undefined);
  let agent = createAgent(config, signal, permission);

  try {
    while (!signal.aborted) {
      const line = await nextLine("> ");
      if (line === null) break;
      const input = line.trim();
      const command = parseSessionCommand(input);

      if (command.kind === "exit") break;
      if (command.kind === "help") {
        console.log(REPL_HELP);
        continue;
      }
      if (command.kind === "reset") {
        agent = createAgent(config, signal, permission);
        console.log("(session reset)\n");
        continue;
      }
      if (command.kind === "permission") {
        if (command.value !== undefined) {
          // 中文对照：未知权限模式 "{值}"（可用：…）
          console.log(`unknown permission mode "${command.value}" (expected: ${PERMISSION_MODE_LIST})`);
        } else if (command.mode !== undefined) {
          permission.setMode(command.mode);
          console.log(`permission: ${permission.mode}`);
        } else {
          console.log(`permission: ${permission.mode}`);
        }
        continue;
      }

      if (input === "") continue;

      try {
        await runTurn(agent, input, config, signal);
      } catch (error) {
        if (signal.aborted) {
          console.error(`[agent] cancelled: ${describeError(error)}`);
          break;
        }
        // 一轮失败不等于会话失败：这里的错误已经进过账单，继续等输入。
        console.error(`[agent] turn failed: ${describeForUser(error)}`);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    rl.close();
  }

  printSession(agent.sessionStats);
  if (signal.aborted) process.exitCode = 130;
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
  const tui = new Tui({
    input: process.stdin,
    output: process.stdout,
    model: config.apiKey === "" ? "未配置模型"
      : config.demo ? `${config.model} [demo: external mock]` : config.model,
    workspace: config.root,
    permission: config.permission,
    controller,
    interactive,
    // Shift+Tab 只发起模式切换；Permission 是唯一的执行授权源。
    // Agent 每次请求动态读取此 Permission，因此下一轮模型提示自动同步。
    onPermissionChange: (mode) => {
      permission.setMode(mode);
      tui.setPermission(mode);
    },
    // 短对话贴近输入框，内容多时再停靠底部；旧的固定布局仍可供兼容测试。
    flowInput: true,
    screenMode: parseTuiScreenMode(process.env.AGENT_TUI_SCREEN),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  });

  // 审批和任务输入共用 Tui 的同一个 readline/行队列；权限策略本身仍是会话级对象。
  // 无 TTY 时不注入审批器：Permission 会明确说「没有审批通道」，而不是把
  // 「读不到终端」误报成「审批失败」或「用户拒绝」。
  const permission = new Permission(
    config.permission,
    interactive ? (request) => tui.approve(request) : undefined,
  );

  // Agent 在回调创建时还没赋值，但回调只会在 run() 期间触发；用 current 拿最新实例的账。
  let current: Agent | undefined;
  // 工具开始展示时会把本次 assistant 段落提交到运行记录；Run 后续失败不能重复补写。
  let toolStartedInLatestResponse = false;
  const callbacks: AgentCallbacks = {
    onRequestStart: () => {
      toolStartedInLatestResponse = false;
      tui.setThinking(true);
    },
    onToolCall: (call, confirmedContent) => {
      // 同一条 assistant 可以带多个工具；只确认一次阶段说明，不能重复展示。
      if (!toolStartedInLatestResponse) tui.confirmAssistant(confirmedContent);
      toolStartedInLatestResponse = true;
      tui.toolCall(call);
      if (current !== undefined) tui.setStats(current.sessionStats);
    },
    onToolResult: (call, result) => {
      tui.toolResult(call, result);
      if (current !== undefined) tui.setStats(current.sessionStats);
    },
    onDelta: (text) => tui.assistantDelta(text),
    onRetry: (_error, attempt, maxRetries) => tui.setRetrying(attempt, maxRetries),
  };

  const newAgent = (): Agent => {
    current = createAgent(config, signal, permission, { announce: false, callbacks });
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
      tui.confirmAssistant(reply.content);
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
          tui.logLine(tui.uiText(`permission: ${permission.mode}`, `权限：${permission.mode}`));
        } else {
          tui.logLine(tui.uiText(`permission: ${permission.mode}`, `权限：${permission.mode}`));
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
  // 中文对照：用法：node src/cli.ts "<任务>" [--permission <模式>]；node src/cli.ts --repl 进入多轮会话
  'usage: node src/cli.ts "<task>" [--permission <mode>]',
  "       node src/cli.ts --repl [--permission <mode>]     # multi-turn session; /exit, /reset, /permission, /help",
  // 中文对照：node src/cli.ts --tui [--permission <模式>] 进入轻量 TUI；可带一个初始任务
  "       node src/cli.ts --tui [--permission <mode>] [task]  # lightweight TUI session",
  "       node src/cli.ts --details \"<task>\"  # expanded tool logs",
  // 中文对照：权限模式：…（默认：…）
  `       modes: ${PERMISSION_MODE_LIST} (default: ${DEFAULT_PERMISSION_MODE})`,
  // 中文对照：环境变量：BASE_URL、API_KEY、MODEL、WORKDIR、MAX_STEPS、MAX_TOOL_CALLS、MAX_TOTAL_TOKENS、MAX_OUTPUT_TOKENS、TOOL_TIMEOUT_MS
  "env:   BASE_URL, API_KEY, MODEL, AGENT_DEMO, WORKDIR, MAX_STEPS, MAX_TOOL_CALLS, MAX_TOTAL_TOKENS, MAX_OUTPUT_TOKENS, TOOL_TIMEOUT_MS, AGENT_VIEW, AGENT_VOICE, AGENT_TUI_SCREEN",
].join("\n");

const cli = parseArgs(process.argv.slice(2));
// 没给任务、又是在终端里直接运行：默认进 REPL。管道/CI 里没有输入，给用法更安全。
// --tui 是显式选择：它自己会处理初始任务，不能因为 task 为空就退回 usage。
const replMode = cli.repl || (!cli.tui && cli.task === "" && process.stdin.isTTY === true);
const tuiMode = cli.tui;

if (cli.error !== undefined) {
  // 中文对照：[agent] 致命错误：{原因}
  console.error(`[agent] fatal: ${cli.error}`);
  console.log(usage);
  process.exitCode = 1;
} else if (cli.help) {
  console.log(usage);
} else if (cli.task === "" && !replMode && !tuiMode) {
  console.log(usage);
  process.exitCode = 1;
} else {
  // 取消链的起点：Ctrl-C / kill 只做一件事 —— abort 同一个 signal。
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => controller.abort(new Error(`received ${name}`)));
  }

  try {
    const config = loadConfig(cli.permission, cli.details, tuiMode && hasInteractiveTerminal());
    if (tuiMode) {
      await tuiSession(config, controller, cli.task === "" ? undefined : cli.task);
    } else if (replMode) {
      await repl(config, controller);
    } else {
      const approvalPrompt = createApprovalPrompt(controller, config.root);
      try {
        // 一次性任务同样使用会话级 Permission：审批器负责「怎么问」，Permission 负责「放不放行」。
        const permission = new Permission(config.permission, approvalPrompt.approve);
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

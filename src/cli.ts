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
 *
 * 这里只做组装，不含任何 agent 逻辑：换模型、换工具集、换提示词，改的都是这一层。
 */
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { askWithSignal, formatApproval } from "./approval.ts";
import { Agent, DEFAULT_SYSTEM_PROMPT } from "./agent.ts";
import type { AgentSessionStats, AgentStats } from "./agent.ts";
import { describeError } from "./errors.ts";
import { Llm } from "./llm.ts";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, Permission, approvalGate, isApproved, parsePermissionMode, permissionPrompt } from "./permission.ts";
import type { PermissionApprover, PermissionMode } from "./permission.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { Tui } from "./tui.ts";
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
  root: string;
  maxSteps: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxOutputTokens: number;
  toolTimeoutMs: number;
  permission: PermissionMode;
}

function loadConfig(permission: PermissionMode): Config {
  // 先 trim 再判空：API_KEY="   " 等于没填，应该继续回退到 OPENAI_API_KEY。
  const apiKey = firstNonEmpty(process.env.API_KEY, process.env.OPENAI_API_KEY);
  if (!apiKey) {
    // 中文对照：缺少 API_KEY（或 OPENAI_API_KEY）；参考 .env.example
    throw new Error("missing API_KEY (or OPENAI_API_KEY); see .env.example");
  }

  return {
    apiKey,
    baseUrl: process.env.BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.MODEL ?? "gpt-4o-mini",
    // 工作区根目录固定成绝对路径，后面所有相对路径都相对它解析。
    root: path.resolve(process.env.WORKDIR ?? process.cwd()),
    maxSteps: positiveIntFromEnv("MAX_STEPS", 30),
    maxToolCalls: positiveIntFromEnv("MAX_TOOL_CALLS", 60),
    maxTotalTokens: nonNegativeIntFromEnv("MAX_TOTAL_TOKENS", 500_000),
    maxOutputTokens: positiveIntFromEnv("MAX_OUTPUT_TOKENS", 8192),
    toolTimeoutMs: positiveIntFromEnv("TOOL_TIMEOUT_MS", 120_000),
    permission,
  };
}

/** 一次进程的启动参数。和 Config 分开：命令行是输入，Config 是校验后的运行配置。 */
interface CliArgs {
  help: boolean;
  repl: boolean;
  tui: boolean;
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
  let permission: PermissionMode = DEFAULT_PERMISSION_MODE;
  const taskParts: string[] = [];

  const result = (error?: string): CliArgs => ({
    help,
    repl,
    tui,
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

/**
 * 本轮是否已经把正文流式打印过。用模块级变量而不是 Agent 内部状态：
 * 「显示过没有」是 CLI 的事，Agent 只负责把增量交出来。
 */
let streamedThisTurn = false;

/**
 * 交互壳可以替换的三个显示回调。默认实现写 console / stdout（REPL、一次性任务）；
 * TUI 传入自己的版本，让同一份 Agent 装配逻辑不直接绑定输出方式。
 */
interface AgentCallbacks {
  onRequestStart?: () => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (call: ToolCall, result: string) => void;
  onDelta?: (text: string) => void;
}

/**
 * 组装一个 Agent。REPL 的 /reset 也走这里 —— 换一个全新的 Agent，
 * 但复用同一份配置和取消信号（Ctrl-C 应该停掉整个进程，而不是只停一轮）。
 *
 * signal 是这次会话唯一的取消源：同一个 controller 交给 Agent、Llm、Workspace，
 * 三处各自响应 —— 循环停手、HTTP 断开、进程树被杀。取消链上没有第二个管理器。
 *
 * `announce: false` 只给 TUI 用：状态栏已经显示模型/工作区/权限，不再往运行记录里
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
    // 默认实现打印每一步的工具调用，让你能「看见」循环在转；TUI 会换成运行记录里的两行。
    onRequestStart: callbacks?.onRequestStart,
    onToolCall: callbacks?.onToolCall,
    onToolResult:
      callbacks?.onToolResult ??
      ((call, result) => {
        const firstLine = (result.split("\n")[0] ?? "").slice(0, 120);
        console.log(`  ↳ ${call.function.name} → ${firstLine}`);
      }),
    // 正文增量直接写 stdout：不换行、不加前缀，让流出来的字连成一段。
    // 第一段之前补一个换行，避免紧跟在工具结果那一行后面。
    onDelta:
      callbacks?.onDelta ??
      ((text) => {
        if (!streamedThisTurn) process.stdout.write("\n");
        streamedThisTurn = true;
        process.stdout.write(text);
      }),
  });
}

/**
 * 跑一轮任务（一次 Run），打印最终回复和这一轮的账单。
 *
 * 失败时先打 usage 再抛：失败的任务同样花了 token，账单不能因为异常就消失。
 */
async function runTurn(agent: Agent, task: string): Promise<void> {
  streamedThisTurn = false;
  try {
    const reply = await agent.run(task);
    // 流式时正文已经逐字打过了；没有增量（比如纯工具调用轮）就打印最终回复。
    if (streamedThisTurn) process.stdout.write("\n");
    else console.log(`\n${reply.content ?? ""}`);
    printUsage(agent.stats, { failed: false });
  } catch (error) {
    // 失败的任务同样花了 token：账单不能因为异常就消失。
    printUsage(agent.stats, { failed: true });
    throw error;
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
        await runTurn(agent, input);
      } catch (error) {
        if (signal.aborted) {
          console.error(`[agent] cancelled: ${describeError(error)}`);
          break;
        }
        // 一轮失败不等于会话失败：这里的错误已经进过账单，继续等输入。
        console.error(`[agent] turn failed: ${describeError(error)}`);
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
 * `/reset` 换 Agent 但不换 Permission；`/permission` 切换后状态栏和下一次请求同时生效。
 */
async function tuiSession(config: Config, controller: AbortController, initialTask?: string): Promise<void> {
  const signal = controller.signal;
  const interactive = hasInteractiveTerminal();
  const tui = new Tui({
    input: process.stdin,
    output: process.stdout,
    model: config.model,
    workspace: config.root,
    permission: config.permission,
    controller,
    interactive,
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
  const callbacks: AgentCallbacks = {
    onRequestStart: () => tui.setThinking(true),
    onToolCall: (call) => {
      tui.toolCall(call);
      if (current !== undefined) tui.setStats(current.sessionStats);
    },
    onToolResult: (call, result) => {
      tui.toolResult(call, result);
      if (current !== undefined) tui.setStats(current.sessionStats);
    },
    onDelta: (text) => tui.assistantDelta(text),
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
  const runTask = async (task: string, showTask = true): Promise<boolean> => {
    tui.beginTurn(task, { show: showTask });
    try {
      const reply = await agent.run(task);
      tui.finishAssistant(reply.content ?? "");
      tui.finishTurn(agent.stats, agent.sessionStats, { failed: false });
      return true;
    } catch (error) {
      // 失败的任务同样花了 token：先结账，再把错误写进运行记录。
      tui.finishAssistant("");
      tui.finishTurn(agent.stats, agent.sessionStats, { failed: true });
      if (signal.aborted) {
        tui.logLine(`[agent] cancelled: ${describeError(error)}`);
        return false;
      }
      // 一轮失败不等于会话失败：继续等下一行输入。
      tui.logLine(`[agent] turn failed: ${describeError(error)}`);
      return true;
    }
  };

  let keepGoing = true;
  try {
    if (initialTask !== undefined && initialTask !== "") {
      keepGoing = await runTask(initialTask);
    }

    while (keepGoing && !signal.aborted) {
      const line = await tui.readLine();
      if (line === null) break;
      const input = line.trim();
      const command = parseSessionCommand(input);

      if (command.kind === "exit") break;
      if (command.kind === "help") {
        tui.logLine(REPL_HELP);
        continue;
      }
      if (command.kind === "reset") {
        agent = newAgent();
        tui.logLine("(session reset)");
        tui.setStats(agent.sessionStats);
        continue;
      }
      if (command.kind === "permission") {
        if (command.value !== undefined) {
          // 中文对照：未知权限模式 "{值}"（可用：…）
          tui.logLine(`unknown permission mode "${command.value}" (expected: ${PERMISSION_MODE_LIST})`);
        } else if (command.mode !== undefined) {
          permission.setMode(command.mode);
          tui.setPermission(command.mode);
          tui.logLine(`permission: ${permission.mode}`);
        } else {
          tui.logLine(`permission: ${permission.mode}`);
        }
        continue;
      }

      if (input === "") continue;
      // TTY 的 readline 已经回显了这一行；管道没有回显，补一条 `you:`。
      keepGoing = await runTask(input, !interactive);
    }
  } finally {
    // 先写总账再退出：TUI 的日志行比固定栏位更适合作为最后的记录。
    tui.sessionSummary(agent.sessionStats);
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
  // 中文对照：权限模式：…（默认：…）
  `       modes: ${PERMISSION_MODE_LIST} (default: ${DEFAULT_PERMISSION_MODE})`,
  // 中文对照：环境变量：BASE_URL、API_KEY、MODEL、WORKDIR、MAX_STEPS、MAX_TOOL_CALLS、MAX_TOTAL_TOKENS、MAX_OUTPUT_TOKENS、TOOL_TIMEOUT_MS
  "env:   BASE_URL, API_KEY, MODEL, WORKDIR, MAX_STEPS, MAX_TOOL_CALLS, MAX_TOTAL_TOKENS, MAX_OUTPUT_TOKENS, TOOL_TIMEOUT_MS",
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
    const config = loadConfig(cli.permission);
    if (tuiMode) {
      await tuiSession(config, controller, cli.task === "" ? undefined : cli.task);
    } else if (replMode) {
      await repl(config, controller);
    } else {
      const approvalPrompt = createApprovalPrompt(controller, config.root);
      try {
        // 一次性任务同样使用会话级 Permission：审批器负责「怎么问」，Permission 负责「放不放行」。
        const permission = new Permission(config.permission, approvalPrompt.approve);
        await runTurn(createAgent(config, controller.signal, permission), cli.task);
      } finally {
        approvalPrompt.close();
      }
    }
  } catch (error) {
    // 取消不是「内核出错」：它有自己的退出码（130 = 被 SIGINT 打断），日志也要分开。
    const cancelled = controller.signal.aborted;
    // 中文对照：[agent] 已取消：{原因} ／ [agent] 致命错误：{原因}
    console.error(`[agent] ${cancelled ? "cancelled" : "fatal"}: ${describeError(error)}`);
    // 不用 process.exit(1)：Windows 上 fetch 的 keep-alive 连接还在关闭时强退，
    // 会触发 libuv 断言（退出码 0xC0000409）。设置退出码后让进程自然结束即可。
    process.exitCode = cancelled ? 130 : 1;
  }
}

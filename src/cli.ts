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
import { Agent } from "./agent.ts";
import type { AgentSessionStats, AgentStats } from "./agent.ts";
import { describeError } from "./errors.ts";
import { Llm } from "./llm.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { Workspace, createWorkspaceTools } from "./workspace.ts";

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
}

function loadConfig(): Config {
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
  };
}

/**
 * 组装一个 Agent。REPL 的 /reset 也走这里 —— 换一个全新的 Agent，
 * 但复用同一份配置和取消信号（Ctrl-C 应该停掉整个进程，而不是只停一轮）。
 *
 * signal 是这次会话唯一的取消源：同一个 controller 交给 Agent、Llm、Workspace，
 * 三处各自响应 —— 循环停手、HTTP 断开、进程树被杀。取消链上没有第二个管理器。
 */
function createAgent(config: Config, signal: AbortSignal): Agent {
  const tools = new ToolRegistry(
    createWorkspaceTools(new Workspace({ root: config.root, timeoutMs: config.toolTimeoutMs, signal })),
  );

  // 中文对照：工作区：… ／ 模型：… ／ 工具：…
  console.log(`workspace: ${config.root}`);
  console.log(`model:     ${config.model}`);
  console.log(`tools:     ${tools.definitions.map((tool) => tool.name).join(", ")}\n`);

  return new Agent({
    llm: new Llm({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, maxOutputTokens: config.maxOutputTokens, signal }),
    tools,
    maxSteps: config.maxSteps,
    maxToolCalls: config.maxToolCalls,
    maxTotalTokens: config.maxTotalTokens === 0 ? undefined : config.maxTotalTokens,
    signal,
    // 打印每一步的工具调用，让你能「看见」循环在转。
    onToolResult: (call, result) => {
      const firstLine = (result.split("\n")[0] ?? "").slice(0, 120);
      console.log(`  ↳ ${call.function.name} → ${firstLine}`);
    },
  });
}

/**
 * 跑一轮任务（一次 Run），打印最终回复和这一轮的账单。
 *
 * 失败时先打 usage 再抛：失败的任务同样花了 token，账单不能因为异常就消失。
 */
async function runTurn(agent: Agent, task: string): Promise<void> {
  try {
    const reply = await agent.run(task);
    console.log(`\n${reply.content ?? ""}`);
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
  // 中文对照：命令：/exit 退出、/reset 清空上下文并重开一个 Agent、/help 显示这段帮助
  "commands: /exit  quit · /reset  clear the transcript and start a new Agent · /help  show this",
].join("\n");

/**
 * 多轮会话。
 *
 * 每一行输入是一次 Run；Transcript 留在同一个 Agent 里，所以模型记得前面说过什么。
 * 失败的一轮不会结束会话：打印错误、继续等下一行输入。唯一的例外是取消 ——
 * Ctrl-C 停掉的是整个进程，所以循环跟着退出。
 */
async function repl(config: Config, signal: AbortSignal): Promise<void> {
  const interactive = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  let agent = createAgent(config, signal);

  // 取消发生在「等输入」而不是「跑任务」时，也要能把循环叫醒。
  const onAbort = () => rl.close();
  signal.addEventListener("abort", onAbort, { once: true });

  // 管道输入会在所有行读完时（可能还有一轮任务在跑）就把 readline 关掉：
  // 这时再 prompt 会抛 "readline was closed"，所以先看状态再画提示符。
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const prompt = () => {
    if (!closed) rl.prompt();
  };

  try {
    rl.setPrompt("> ");
    prompt();
    for await (const line of rl) {
      const input = line.trim();
      if (input === "/exit" || input === "/quit") break;
      if (input === "/help") {
        console.log(REPL_HELP);
        prompt();
        continue;
      }
      if (input === "/reset") {
        agent = createAgent(config, signal);
        console.log("(session reset)\n");
        prompt();
        continue;
      }
      if (input === "") {
        prompt();
        continue;
      }

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
      prompt();
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    rl.close();
  }

  printSession(agent.sessionStats);
  if (signal.aborted) process.exitCode = 130;
}

const usage = [
  // 中文对照：用法：node src/cli.ts "<任务>"；node src/cli.ts --repl 进入多轮会话
  'usage: node src/cli.ts "<task>"',
  "       node src/cli.ts --repl     # multi-turn session; /exit, /reset, /help",
  // 中文对照：环境变量：BASE_URL、API_KEY、MODEL、WORKDIR、MAX_STEPS、MAX_TOOL_CALLS、MAX_TOTAL_TOKENS、MAX_OUTPUT_TOKENS、TOOL_TIMEOUT_MS
  "env:   BASE_URL, API_KEY, MODEL, WORKDIR, MAX_STEPS, MAX_TOOL_CALLS, MAX_TOTAL_TOKENS, MAX_OUTPUT_TOKENS, TOOL_TIMEOUT_MS",
].join("\n");

const args = process.argv.slice(2);
const wantsHelp = args.includes("--help") || args.includes("-h");
const replRequested = args.includes("--repl");
const task = args.filter((arg) => arg !== "--repl").join(" ").trim();
// 没给任务、又是在终端里直接运行：默认进 REPL。管道/CI 里没有输入，给用法更安全。
const replMode = replRequested || (task === "" && process.stdin.isTTY === true);

if (wantsHelp) {
  console.log(usage);
} else if (task === "" && !replMode) {
  console.log(usage);
  process.exitCode = 1;
} else {
  // 取消链的起点：Ctrl-C / kill 只做一件事 —— abort 同一个 signal。
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => controller.abort(new Error(`received ${name}`)));
  }

  try {
    const config = loadConfig();
    if (replMode) {
      await repl(config, controller.signal);
    } else {
      await runTurn(createAgent(config, controller.signal), task);
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

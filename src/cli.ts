#!/usr/bin/env node
/**
 * 命令行入口：读环境变量 → 组装 Workspace / ToolRegistry / Agent → 跑一次任务 → 打印最终回复。
 *
 * 用法：
 *   npm run agent -- "给这个仓库加一个 /health 接口并写测试"
 *   node src/cli.ts "解释一下 src/agent.ts 里的循环"
 *
 * 环境变量（可写进 .env，由 --env-file-if-exists 自动加载）：
 *   BASE_URL        OpenAI 兼容端点，默认 https://api.openai.com/v1
 *   API_KEY         必填，也可以用 OPENAI_API_KEY
 *   MODEL           模型名，默认 gpt-4o-mini
 *   WORKDIR         工具能碰的根目录，默认当前目录
 *   MAX_STEPS       循环上限，默认 30
 *   MAX_TOOL_CALLS  一次任务最多执行多少次工具调用，默认 60
 *   MAX_TOTAL_TOKENS 一次任务累计 token 预算，默认 500000；0 表示不限制
 *   MAX_OUTPUT_TOKENS 单次模型响应最多生成多少 token，默认 8192
 *   TOOL_TIMEOUT_MS 单条命令超时，默认 120000
 *
 * 这里只做组装，不含任何 agent 逻辑：换模型、换工具集、换提示词，改的都是这一层。
 */
import * as path from "node:path";
import { Agent } from "./agent.ts";
import type { AgentStats } from "./agent.ts";
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

const usage = [
  // 中文对照：用法：node src/cli.ts "<任务>"
  'usage: node src/cli.ts "<task>"',
  // 中文对照：环境变量：BASE_URL、API_KEY、MODEL、WORKDIR、MAX_STEPS、MAX_TOOL_CALLS、MAX_TOTAL_TOKENS、MAX_OUTPUT_TOKENS、TOOL_TIMEOUT_MS
  "env:   BASE_URL, API_KEY, MODEL, WORKDIR, MAX_STEPS, MAX_TOOL_CALLS, MAX_TOTAL_TOKENS, MAX_OUTPUT_TOKENS, TOOL_TIMEOUT_MS",
].join("\n");

/**
 * 一次任务的全部工作。写在函数里，是为了让「失败怎么退出」只有一处。
 *
 * signal 是这次任务唯一的取消源：同一个 controller 交给 Agent、Llm、Workspace，
 * 三处各自响应 —— 循环停手、HTTP 断开、进程树被杀。取消链上没有第二个管理器。
 */
async function runTask(task: string, signal: AbortSignal): Promise<void> {
  // 先 trim 再判空：API_KEY="   " 等于没填，应该继续回退到 OPENAI_API_KEY。
  const apiKey = firstNonEmpty(process.env.API_KEY, process.env.OPENAI_API_KEY);
  if (!apiKey) {
    // 中文对照：缺少 API_KEY（或 OPENAI_API_KEY）；参考 .env.example
    throw new Error("missing API_KEY (or OPENAI_API_KEY); see .env.example");
  }

  const baseUrl = process.env.BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.MODEL ?? "gpt-4o-mini";
  // 工作区根目录固定成绝对路径，后面所有相对路径都相对它解析。
  const root = path.resolve(process.env.WORKDIR ?? process.cwd());
  const maxSteps = positiveIntFromEnv("MAX_STEPS", 30);
  const maxToolCalls = positiveIntFromEnv("MAX_TOOL_CALLS", 60);
  const maxTotalTokens = nonNegativeIntFromEnv("MAX_TOTAL_TOKENS", 500_000);
  const maxOutputTokens = positiveIntFromEnv("MAX_OUTPUT_TOKENS", 8192);
  const toolTimeoutMs = positiveIntFromEnv("TOOL_TIMEOUT_MS", 120_000);

  const tools = new ToolRegistry(
    createWorkspaceTools(new Workspace({ root, timeoutMs: toolTimeoutMs, signal })),
  );

  // 中文对照：工作区：… ／ 模型：… ／ 工具：…
  console.log(`workspace: ${root}`);
  console.log(`model:     ${model}`);
  console.log(`tools:     ${tools.definitions.map((tool) => tool.name).join(", ")}\n`);

  const agent = new Agent({
    llm: new Llm({ baseUrl, apiKey, model, maxOutputTokens, signal }),
    tools,
    maxSteps,
    maxToolCalls,
    maxTotalTokens: maxTotalTokens === 0 ? undefined : maxTotalTokens,
    signal,
    // 打印每一步的工具调用，让你能「看见」循环在转。
    onToolResult: (call, result) => {
      const firstLine = (result.split("\n")[0] ?? "").slice(0, 120);
      console.log(`  ↳ ${call.function.name} → ${firstLine}`);
    },
  });

  try {
    const reply = await agent.run(task);
    console.log(`\n${reply.content ?? ""}`);
    printUsage(agent.stats, { failed: false });
  } catch (error) {
    // 失败的任务同样花了 token：账单不能因为异常就消失。
    // 先打 usage 再把错误抛给最外层，顺序上也更容易读。
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

const task = process.argv.slice(2).join(" ").trim();
if (!task || task === "--help" || task === "-h") {
  console.log(usage);
  // --help 是用户主动要看帮助，算成功；没给任务算用法错误。
  process.exitCode = task ? 0 : 1;
} else {
  // 取消链的起点：Ctrl-C / kill 只做一件事 —— abort 同一个 signal。
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => controller.abort(new Error(`received ${name}`)));
  }

  try {
    await runTask(task, controller.signal);
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

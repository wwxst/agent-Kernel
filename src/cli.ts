#!/usr/bin/env node
/**
 * 命令行入口：读环境变量 → 组装 Workspace / Toolbelt / Agent → 跑一次任务 → 打印最终回复。
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
 *   TOOL_TIMEOUT_MS 单条命令超时，默认 120000
 *
 * 这里只做组装，不含任何 agent 逻辑：换模型、换工具集、换提示词，改的都是这一层。
 */
import * as path from "node:path";
import { Agent } from "./agent.ts";
import { Llm } from "./llm.ts";
import { Toolbelt } from "./toolbelt.ts";
import { Workspace, workspaceTools } from "./workspace.ts";

/** 读一个「正整数」环境变量；写错就立刻报错，别带着 NaN 跑一半才炸。 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`invalid ${name}: "${raw}" (expected a positive integer)`);
    process.exit(1);
  }
  return value;
}

const usage = [
  'usage: node src/cli.ts "<task>"',
  "env:   BASE_URL, API_KEY, MODEL, WORKDIR, MAX_STEPS, TOOL_TIMEOUT_MS",
].join("\n");

const task = process.argv.slice(2).join(" ").trim();
if (!task || task === "--help" || task === "-h") {
  console.log(usage);
  // --help 是用户主动要看帮助，算成功；没给任务算用法错误。
  process.exit(task ? 0 : 1);
}

const apiKey = process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? "";
if (!apiKey) {
  console.error("missing API_KEY (or OPENAI_API_KEY); see .env.example");
  process.exit(1);
}

const baseUrl = process.env.BASE_URL ?? "https://api.openai.com/v1";
const model = process.env.MODEL ?? "gpt-4o-mini";
// 沙箱根目录固定成绝对路径，后面所有相对路径都相对它解析。
const root = path.resolve(process.env.WORKDIR ?? process.cwd());
const maxSteps = positiveIntFromEnv("MAX_STEPS", 30);
const toolTimeoutMs = positiveIntFromEnv("TOOL_TIMEOUT_MS", 120_000);

const toolbelt = new Toolbelt(
  workspaceTools(new Workspace({ root, timeoutMs: toolTimeoutMs })),
);

console.log(`workspace: ${root}`);
console.log(`model:     ${model}`);
console.log(`tools:     ${toolbelt.definitions.map((tool) => tool.name).join(", ")}\n`);

const agent = new Agent({
  llm: new Llm({ baseUrl, apiKey, model }),
  toolbelt,
  maxSteps,
  // 打印每一步的工具调用，让你能「看见」循环在转。
  onToolResult: (call, result) => {
    const firstLine = (result.split("\n")[0] ?? "").slice(0, 120);
    console.log(`  ↳ ${call.function.name} → ${firstLine}`);
  },
});

try {
  const reply = await agent.run(task);
  console.log(`\n${reply.content ?? ""}`);
} catch (error) {
  console.error(`[agent] fatal: ${error instanceof Error ? error.message : String(error)}`);
  // 不用 process.exit(1)：Windows 上 fetch 的 keep-alive 连接还在关闭时强退，
  // 会触发 libuv 断言（退出码 0xC0000409）。设置退出码后让进程自然结束即可。
  process.exitCode = 1;
}

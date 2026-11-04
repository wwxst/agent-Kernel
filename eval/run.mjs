#!/usr/bin/env node
/**
 * 最小评测集：拿真实模型跑一组小任务，记录成功率、成本（token / 请求 / 工具调用）和耗时。
 *
 * 为什么需要它：单元测试只能证明「代码没坏」，证明不了「agent 变强」。
 * 改 prompt、改工具描述、改命名、改预算，最终都要在这里判分。
 *
 * 用法：
 *   npm run eval                     # 跑全部任务
 *   npm run eval -- rename          # 只跑名字里带 rename 的
 *   node --env-file-if-exists=.env eval/run.mjs --keep   # 保留失败的工作区
 *
 * 需要真实 API：BASE_URL / API_KEY / MODEL 来自 .env。
 * 结果同时写进 eval/results/<时间戳>.json（不进 git）。
 *
 * 失败分四类，别混在一起看：
 *   task        —— agent 没做完（步数/工具预算耗尽、模型空回复……）
 *   check       —— agent 交卷了，但检查断言没过
 *   infra       —— 检查器自己抛了非断言错误（写错、依赖缺失）
 *   environment —— 网络、端点超时之类的环境问题
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Agent } from "../src/agent.ts";
import { Llm } from "../src/llm.ts";
import { ToolRegistry } from "../src/tool-registry.ts";
import { Workspace, createWorkspaceTools } from "../src/workspace.ts";
import { isExpectedFailure } from "./selfcheck.mjs";

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = path.join(here, "tasks");
const resultsDir = path.join(here, "results");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const filters = [];
let jobs = 4;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--keep") continue;
  if (arg === "--jobs") {
    jobs = Math.max(1, Number(args[(index += 1)]) || jobs);
    continue;
  }
  if (arg.startsWith("-")) continue;
  filters.push(arg);
}

// 一个写坏的 check 不该把整轮评测带走：检查里若有没 await 的 promise，
// 它的 rejection 会以未处理事件的形式逃出 try/catch。记一笔，继续跑。
process.on("unhandledRejection", (reason) => {
  console.error(`  [warn] unhandled rejection: ${describe(reason)}`);
});

// 先 trim 再判空：API_KEY="   " 等于没填，应该继续回退到 OPENAI_API_KEY。
const apiKey = firstNonEmpty(process.env.API_KEY, process.env.OPENAI_API_KEY);
if (!apiKey) {
  console.error("missing API_KEY (or OPENAI_API_KEY); see .env.example");
  process.exitCode = 1;
} else {
  await main();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** 评测记录要能对上是哪次提交跑出来的；仓库外/没装 git 时记成 unknown。 */
async function currentCommit() {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: here });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const baseUrl = process.env.BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.MODEL ?? "gpt-4o-mini";
  const commit = await currentCommit();

  const names = (await readdir(tasksDir))
    .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
    .sort();

  if (names.length === 0) {
    console.error("no tasks matched");
    process.exitCode = 1;
    return;
  }

  console.log(`model:  ${model}`);
  console.log(`commit: ${commit}`);
  console.log(`tasks:  ${names.length}  并发: ${Math.min(jobs, names.length)}\n`);

  // 任务之间互不依赖，串行只是浪费等待模型的时间。
  const startedAt = Date.now();
  const results = await runPool(names, jobs, (name) => runTask(name, { baseUrl, apiKey, model }));
  const elapsed = (Date.now() - startedAt) / 1000;

  report(results, elapsed, { model, commit });
}

/** 简单的并发池：同一时刻最多 limit 个任务在跑，结果按原顺序返回。 */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

/** 跑一个任务：复制夹具 → 真跑一遍 → 跑检查 → 清理。 */
async function runTask(name, { baseUrl, apiKey, model }) {
  const taskDir = path.join(tasksDir, name);
  const prompt = (await readFile(path.join(taskDir, "task.md"), "utf8")).trim();
  const workdir = await mkdtemp(path.join(tmpdir(), `agent-eval-${name}-`));
  await cp(path.join(taskDir, "files"), workdir, { recursive: true });

  const agent = new Agent({
    llm: new Llm({ baseUrl, apiKey, model }),
    tools: new ToolRegistry(createWorkspaceTools(new Workspace({ root: workdir }))),
    maxSteps: 30,
    // 兜底：单个任务烧到 20 万 token 还没做完，多半是循环出了问题，不该继续付钱。
    maxTotalTokens: 200_000,
  });

  const started = Date.now();
  let error;
  let failure;
  try {
    await agent.run(prompt);
  } catch (failureOfTask) {
    error = failureOfTask;
    failure = classifyRunFailure(failureOfTask);
  }

  if (error === undefined) {
    try {
      const check = (await import(pathToFileURL(path.join(taskDir, "check.mjs")).href)).default;
      await check(workdir);
    } catch (failureOfCheck) {
      error = failureOfCheck;
      failure = isExpectedFailure(failureOfCheck) ? "check" : "infra";
    }
  }

  const seconds = (Date.now() - started) / 1000;
  const stats = agent.stats;
  const result = {
    name,
    ok: error === undefined,
    failure,
    requests: stats.requests,
    toolCalls: stats.toolCalls,
    tokens: {
      prompt: stats.usage.promptTokens,
      completion: stats.usage.completionTokens,
      total: stats.usage.totalTokens,
      unknownResponses: stats.usage.unknown,
    },
    seconds: Number(seconds.toFixed(1)),
    error: error === undefined ? undefined : describe(error),
    workdir: keep ? workdir : undefined,
  };

  if (!keep) await rm(workdir, { recursive: true, force: true });

  const mark = result.ok ? "PASS" : "FAIL";
  const detail = result.ok ? "" : `  [${result.failure}] ${result.error.split("\n")[0]}`;
  console.log(
    `  ${mark}  ${name.padEnd(28)} ${String(result.requests).padStart(3)} req  ` +
      `${String(result.toolCalls).padStart(3)} tool  ${String(result.seconds).padStart(6)}s  ` +
      `${String(result.tokens.total).padStart(6)} tok${detail}`,
  );

  return result;
}

/**
 * 判断失败属于「任务没做完」还是「环境不对」。
 *
 * 这是个启发式：只认明确的网络错误码和超时。端点返回 HTTP 4xx/5xx 时不在这里猜，
 * 归到 task —— 记录里保留了原始错误文本，复盘时能看出来。
 */
function classifyRunFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  if (
    ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)
  ) {
    return "environment";
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "environment";
  return "task";
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function report(results, elapsed, { model, commit }) {
  const passed = results.filter((result) => result.ok).length;
  const requests = results.reduce((total, result) => total + result.requests, 0);
  const toolCalls = results.reduce((total, result) => total + result.toolCalls, 0);
  const tokens = results.reduce((total, result) => total + result.tokens.total, 0);
  const unknown = results.reduce((total, result) => total + result.tokens.unknownResponses, 0);
  const busy = results.reduce((total, result) => total + result.seconds, 0);

  // 并发跑时「任务耗时之和」会大于墙钟，两个都写出来，避免误读。
  // usage 有缺失时 tokens 前加 at least：那是已统计到的下限，不是实际账单。
  console.log(
    `\n${passed}/${results.length} 通过 · ${requests} 次模型请求 · ${toolCalls} 次工具调用 · ` +
      `${unknown > 0 ? "at least " : ""}${tokens} tokens` +
      `${unknown > 0 ? `（${unknown} 个响应没有 usage）` : ""} · 墙钟 ${elapsed.toFixed(1)}s` +
      `（任务耗时合计 ${busy.toFixed(1)}s）`,
  );

  if (passed < results.length) {
    const kinds = [
      ["task", "任务失败"],
      ["check", "检查未通过"],
      ["infra", "评测基础设施错误"],
      ["environment", "环境 / 网络错误"],
    ];
    for (const [kind, label] of kinds) {
      const failed = results.filter((result) => !result.ok && result.failure === kind);
      if (failed.length === 0) continue;
      console.log(`\n${label}（${failed.length}）：`);
      for (const result of failed) console.log(`  - ${result.name}: ${result.error ?? "?"}`);
    }
  }

  // 落一份结果，方便对比两次改动（评测的价值在趋势，不在单次分数）。
  const record = {
    at: new Date().toISOString(),
    model,
    commit,
    passed,
    total: results.length,
    elapsed: Number(elapsed.toFixed(1)),
    totals: { requests, toolCalls, tokens, unknownResponses: unknown },
    results,
  };
  mkdir(resultsDir, { recursive: true })
    .then(() => writeFile(path.join(resultsDir, `${Date.now()}.json`), JSON.stringify(record, null, 2), "utf8"))
    .catch((error) => console.error(`could not write results: ${describe(error)}`));

  if (passed < results.length) process.exitCode = 1;
}

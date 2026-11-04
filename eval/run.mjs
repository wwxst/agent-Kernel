#!/usr/bin/env node
/**
 * 最小评测集：拿真实模型跑一组小任务，记录成功率、步数、耗时。
 *
 * 为什么需要它：单元测试只能证明「代码没坏」，证明不了「agent 变强」。
 * 改 prompt、改工具描述、改命名，最终都要在这里判分。
 *
 * 用法：
 *   npm run eval                     # 跑全部任务
 *   npm run eval -- rename          # 只跑名字里带 rename 的
 *   node --env-file-if-exists=.env eval/run.mjs --keep   # 保留失败的工作区
 *
 * 需要真实 API：BASE_URL / API_KEY / MODEL 来自 .env。
 * 结果同时写进 eval/results/<时间戳>.json（不进 git）。
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Agent } from "../src/agent.ts";
import { Llm } from "../src/llm.ts";
import { ToolRegistry } from "../src/tool-registry.ts";
import { Workspace, createWorkspaceTools } from "../src/workspace.ts";

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

const apiKey = process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? "";
if (!apiKey) {
  console.error("missing API_KEY (or OPENAI_API_KEY); see .env.example");
  process.exitCode = 1;
} else {
  await main();
}

async function main() {
  const baseUrl = process.env.BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.MODEL ?? "gpt-4o-mini";

  const names = (await readdir(tasksDir))
    .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
    .sort();

  if (names.length === 0) {
    console.error("no tasks matched");
    process.exitCode = 1;
    return;
  }

  console.log(`model: ${model}`);
  console.log(`tasks: ${names.length}  并发: ${Math.min(jobs, names.length)}\n`);

  // 任务之间互不依赖，串行只是浪费等待模型的时间。
  const startedAt = Date.now();
  const results = await runPool(names, jobs, (name) => runTask(name, { baseUrl, apiKey, model }));
  const elapsed = (Date.now() - startedAt) / 1000;

  report(results, elapsed);
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

  const llm = countingChat(new Llm({ baseUrl, apiKey, model }));
  const agent = new Agent({
    llm,
    tools: new ToolRegistry(createWorkspaceTools(new Workspace({ root: workdir }))),
    maxSteps: 30,
  });

  const started = Date.now();
  let error;
  try {
    await agent.run(prompt);
  } catch (failure) {
    error = failure;
  }

  if (error === undefined) {
    try {
      const check = (await import(pathToFileURL(path.join(taskDir, "check.mjs")).href)).default;
      await check(workdir);
    } catch (failure) {
      error = failure;
    }
  }

  const seconds = (Date.now() - started) / 1000;
  const result = {
    name,
    ok: error === undefined,
    steps: llm.calls,
    seconds: Number(seconds.toFixed(1)),
    error: error === undefined ? undefined : describe(error),
    workdir: keep ? workdir : undefined,
  };

  if (!keep) await rm(workdir, { recursive: true, force: true });

  const mark = result.ok ? "PASS" : "FAIL";
  const detail = result.ok ? "" : `  ${result.error.split("\n")[0]}`;
  console.log(`  ${mark}  ${name.padEnd(28)} ${String(result.steps).padStart(3)} 步  ${String(result.seconds).padStart(5)}s${detail}`);

  return result;
}

/** 记录模型调用次数：步数就是「问了几次模型」，不需要给内核加接口。 */
function countingChat(client) {
  const counter = {
    calls: 0,
    async chat(messages, tools) {
      counter.calls += 1;
      return client.chat(messages, tools);
    },
  };
  return counter;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function report(results, elapsed) {
  const passed = results.filter((result) => result.ok).length;
  const steps = results.reduce((total, result) => total + result.steps, 0);
  const busy = results.reduce((total, result) => total + result.seconds, 0);

  // 并发跑时「任务耗时之和」会大于墙钟，两个都写出来，避免误读。
  console.log(
    `\n${passed}/${results.length} 通过 · 平均 ${(steps / results.length).toFixed(1)} 步 · 墙钟 ${elapsed.toFixed(1)}s（任务耗时合计 ${busy.toFixed(1)}s）`,
  );
  if (passed < results.length) {
    console.log("失败的任务：");
    for (const result of results.filter((entry) => !entry.ok)) console.log(`  - ${result.name}: ${result.error ?? "?"}`);
  }

  // 落一份结果，方便对比两次改动（评测的价值在趋势，不在单次分数）。
  const record = { at: new Date().toISOString(), passed, total: results.length, elapsed: Number(elapsed.toFixed(1)), results };
  mkdir(resultsDir, { recursive: true })
    .then(() => writeFile(path.join(resultsDir, `${Date.now()}.json`), JSON.stringify(record, null, 2), "utf8"))
    .catch((error) => console.error(`could not write results: ${describe(error)}`));

  if (passed < results.length) process.exitCode = 1;
}

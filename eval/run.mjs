#!/usr/bin/env node
/**
 * 文件目的：评测集 —— 拿真实模型跑一组小任务，记录成功率、花了多少、用了多久。
 *
 * 为什么需要它：单元测试只能证明「代码没坏」，证明不了「模型变强了」。
 * 改提示词、改工具说明、改预算，最终都要在这里判分。用法见 README。
 *
 * 失败分四类，别混着看：任务没做完（步数或工具次数用光）、交卷了但没通过（断言没过）、
 * 检查器自己坏了（写错、依赖缺失、有异步任务没等就跑）、环境问题（网络或服务超时）。
 * 最后一类不代表某个任务失败，而是「这一轮成绩整体不可信」—— 任务可能已经通过，
 * 但后台还有东西在跑、最后才炸。这种轮次整轮作废。
 *
 * 文件职责：负责跑任务、判分、统计、写结果文件。
 * 不负责判断「任务初始状态是否真的会失败」（那是 `selfcheck.mjs`）、
 * 不负责诊断单次运行的细节（那是 `diagnostics.mjs`）、不负责汇总跨天结果（那是 `summary.mjs`）。
 *
 * 内容目录：
 *   - `runRound()`：跑一轮（可并发），返回每条任务的记录与整体汇总。
 *   - `runTask()`：单条任务 —— 复制到临时目录、起 Agent、跑断言、收拾现场。
 *   - `summarize()`：把一轮结果压成成功率、请求数、工具调用、token、耗时。
 *   - `runPool()`：有并发上限的任务池；`classifyRunFailure()`：把失败分到上面四类。
 *   - `cli()`：命令行入口；`report()`：逐条打印；`currentCommit()`：记下跑的是哪个提交。
 *
 * 模块关系：依赖 `src/` 的 `Agent`、`Llm`、`ToolRegistry`、`Workspace` 与 `createWorkspaceTools`，
 * 以及同目录的 `diagnostics.mjs`、`selfcheck.mjs`。被 `test/support/eval-floating-check.mjs` 引用。
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Agent, DEFAULT_SYSTEM_PROMPT } from "../src/core/agent.ts";
import { ModelConnectionError } from "../src/protocol/errors.ts";
import { createEvalDiagnostics } from "./diagnostics.mjs";
import { Llm } from "../src/model/llm.ts";
import { ToolRegistry } from "../src/core/tool-registry.ts";
import { Workspace, createWorkspaceTools } from "../src/tools/workspace.ts";
import { isExpectedFailure } from "./selfcheck.mjs";

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultTasksDir = path.join(here, "tasks");
const resultsDir = path.join(here, "results");

/** 未处理的 rejection 最多等这么久再结算；检查器里的后台任务通常在这之前就会炸。 */
const INFRA_SETTLE_MS = 20;

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await cli();
}

async function cli() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const trace = args.includes("--trace");
  const filters = [];
  let jobs = 4;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep" || arg === "--trace") continue;
    if (arg === "--jobs") {
      jobs = Number(args[(index += 1)]);
      continue;
    }
    if (arg.startsWith("-")) continue;
    filters.push(arg);
  }

  // 先 trim 再判空：API_KEY="   " 等于没填，应该继续回退到 OPENAI_API_KEY。
  const apiKey = firstNonEmpty(process.env.API_KEY, process.env.OPENAI_API_KEY);
  if (!apiKey) {
    console.error("missing API_KEY (or OPENAI_API_KEY); see .env.example");
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.MODEL ?? "gpt-4o-mini";
  const commit = await currentCommit();

  const names = (await readdir(defaultTasksDir))
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

  const { results, elapsed, infra } = await runRound({
    tasksDir: defaultTasksDir,
    names,
    baseUrl,
    apiKey,
    model,
    jobs,
    keep,
    trace,
  });

  await report(summarize({ results, elapsed, model, commit, infra }));
}

/** 跑一轮：并发执行任务，并在结算窗口内收集检查器留下的未处理 rejection。 */
export async function runRound({ tasksDir, names, baseUrl, apiKey, model, jobs = 4, keep = false, trace = false }) {
  // 非法并发数会让任务池生成零个 runner，留下从未执行的稀疏结果；必须在启动前拒绝。
  if (!Number.isSafeInteger(jobs) || jobs <= 0) throw new Error("jobs must be a positive safe integer");
  const infra = [];
  const onUnhandled = (reason) => {
    infra.push(describe(reason));
    console.error(`  [infra] unhandled rejection: ${describe(reason)}`);
  };

  process.on("unhandledRejection", onUnhandled);
  const startedAt = Date.now();
  try {
    let results;
    try {
      results = await runPool(names, jobs, (name) =>
        runTask(name, { tasksDir, baseUrl, apiKey, model, keep, trace }),
      );
    } finally {
      // 池失败也先等已启动任务结束，再留一个窗口收集检查器没 await 的 promise。
      // 更晚才炸的 rejection 仍走 Node 默认行为，不能静默通过。
      await new Promise((resolve) => setTimeout(resolve, INFRA_SETTLE_MS));
    }

    return { results, elapsed: (Date.now() - startedAt) / 1000, infra };
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

/** 把一轮的原始结果折成可落盘的记录；`ok` 同时要求任务全过且没有基础设施错误。 */
export function summarize({ results, elapsed, model, commit, infra }) {
  const requests = results.reduce((total, result) => total + result.requests, 0);
  const toolCalls = results.reduce((total, result) => total + result.toolCalls, 0);
  const tokens = results.reduce((total, result) => total + result.tokens.total, 0);
  const unknown = results.reduce((total, result) => total + result.tokens.unknownResponses, 0);
  const passed = results.filter((result) => result.ok).length;

  return {
    at: new Date().toISOString(),
    model,
    commit,
    ok: infra.length === 0 && passed === results.length,
    passed,
    total: results.length,
    elapsed: Number(elapsed.toFixed(1)),
    totals: { requests, toolCalls, tokens, unknownResponses: unknown },
    infraErrors: infra,
    results,
  };
}

/** 首错后不再领取任务，已启动任务全部收尾后才传播首错；结果按原顺序返回。 */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let failed = false;
  let failure;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  });

  await Promise.all(runners);
  if (failed) throw failure;
  return results;
}

/** 跑一个任务：复制夹具 → 真跑一遍 → 跑检查 → 清理。 */
async function runTask(name, { tasksDir, baseUrl, apiKey, model, keep, trace }) {
  const taskDir = path.join(tasksDir, name);
  const prompt = (await readFile(path.join(taskDir, "task.md"), "utf8")).trim();
  const workdir = await mkdtemp(path.join(tmpdir(), `agent-eval-${name}-`));
  try {
    await cp(path.join(taskDir, "files"), workdir, { recursive: true });

    const llm = new Llm({ baseUrl, apiKey, model });
    const tools = new ToolRegistry(createWorkspaceTools(new Workspace({ root: workdir })));
    const diagnostics = trace ? await createEvalDiagnostics({ llm, tools, workdir }) : undefined;
    const agent = new Agent({
      llm: diagnostics?.llm ?? llm,
      tools,
      systemPrompt: () => DEFAULT_SYSTEM_PROMPT,
      ...(diagnostics ? { onToolResult: diagnostics.onToolResult } : {}),
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

    const traceRecord = diagnostics ? await diagnostics.finish() : undefined;

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
      ...(traceRecord === undefined ? {} : { trace: traceRecord }),
    };

    const mark = result.ok ? "PASS" : "FAIL";
    const detail = result.ok ? "" : `  [${result.failure}] ${result.error.split("\n")[0]}`;
    console.log(
      `  ${mark}  ${name.padEnd(28)} ${String(result.requests).padStart(3)} req  ` +
        `${String(result.toolCalls).padStart(3)} tool  ${String(result.seconds).padStart(6)}s  ` +
        `${String(result.tokens.total).padStart(6)} tok${detail}`,
    );

    return result;
  } finally {
    if (!keep) await rm(workdir, { recursive: true, force: true });
  }
}

/**
 * 判断失败属于「任务没做完」还是「环境不对」。
 *
 * 这是个启发式：只认明确的网络错误码和超时。端点返回 HTTP 4xx/5xx 时不在这里猜，
 * 归到 task —— 记录里保留了原始错误文本，复盘时能看出来。
 */
function classifyRunFailure(error) {
  if (error instanceof ModelConnectionError) return "environment";
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

async function report(record) {
  const { passed, total, totals, elapsed, results, infraErrors, ok } = record;
  const unknown = totals.unknownResponses;
  const busy = results.reduce((sum, result) => sum + result.seconds, 0);

  // 并发跑时「任务耗时之和」会大于墙钟，两个都写出来，避免误读。
  // usage 有缺失时 tokens 前加 at least：那是已统计到的下限，不是实际账单。
  console.log(
    `\n${passed}/${total} 通过 · ${totals.requests} 次模型请求 · ${totals.toolCalls} 次工具调用 · ` +
      `${unknown > 0 ? "at least " : ""}${totals.tokens} tokens` +
      `${unknown > 0 ? `（${unknown} 个请求没有 usage）` : ""} · 墙钟 ${elapsed.toFixed(1)}s` +
      `（任务耗时合计 ${busy.toFixed(1)}s）`,
  );

  if (passed < total) {
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

  if (infraErrors.length > 0) {
    console.log(`\n评测基础设施错误（${infraErrors.length}）：未处理的 promise rejection，这一轮不能算通过`);
    for (const message of infraErrors) console.log(`  - ${message.split("\n")[0]}`);
  }

  try {
    await mkdir(resultsDir, { recursive: true });
    await writeFile(path.join(resultsDir, `${Date.now()}.json`), JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    console.error(`could not write results: ${describe(error)}`);
    process.exitCode = 1;
  }

  if (!ok) process.exitCode = 1;
}

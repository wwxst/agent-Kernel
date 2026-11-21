#!/usr/bin/env node
/**
 * 在两个已准备好的工作区里交替运行真实评测。不会创建/删除 Git worktree，也不会改动任何分支。
 * 使用前由用户准备 A/B 两个目录并确认其任务夹具与模型配置相同。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareRuns, renderComparison, summarizeExperiment } from "./compare.mjs";

export function experimentOrder(round) {
  if (!Number.isSafeInteger(round) || round < 1) throw new Error("round must be a positive integer");
  return round % 2 === 1 ? ["A", "B"] : ["B", "A"];
}

async function runVariant(root, variant, experimentId, round, jobs, filters, trace, keep, pricingFile) {
  const label = variant;
  const output = "eval/results/experiments/" + experimentId +
    "/round-" + String(round).padStart(2, "0") + "-" + label + ".json";
  const env = {
    ...process.env,
    EVAL_OUTPUT_FILE: output,
    EVAL_EXPERIMENT_ID: experimentId,
    EVAL_VARIANT: label,
  };
  if (pricingFile) env.EVAL_PRICING_FILE = pricingFile;
  const args = ["eval/run.mjs", "--jobs", String(jobs)];
  if (trace) args.push("--trace");
  if (keep) args.push("--keep");
  args.push(...filters);
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const resultPath = path.join(root, output);
  try {
    const record = JSON.parse(await readFile(resultPath, "utf8"));
    return { record, exitCode, resultPath };
  } catch (error) {
    throw new Error(label + " run did not produce a result file: " + (error instanceof Error ? error.message : String(error)));
  }
}

async function ensureRepo(root, label) {
  const resolved = path.resolve(root);
  for (const file of ["eval/run.mjs", "eval/tasks"]) {
    await access(path.join(resolved, file));
  }
  return resolved;
}

async function cli() {
  const args = process.argv.slice(2);
  const options = {};
  const filters = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--a-dir" || arg === "--b-dir" || arg === "--rounds" || arg === "--jobs" || arg === "--task") {
      options[arg.slice(2)] = args[++index];
    } else if (arg === "--trace" || arg === "--keep") {
      options[arg.slice(2)] = true;
    } else if (arg === "--help") {
      console.log("Usage: npm run eval:ab -- --a-dir PATH --b-dir PATH [--rounds 3] [--jobs 1] [--task FILTER] [--trace] [--keep]");
      return;
    } else {
      throw new Error("unknown argument: " + arg);
    }
  }
  if (!options["a-dir"] || !options["b-dir"]) throw new Error("--a-dir and --b-dir are required");
  const aDir = await ensureRepo(options["a-dir"], "A");
  const bDir = await ensureRepo(options["b-dir"], "B");
  if (aDir === bDir) throw new Error("A and B must be different directories");
  const rounds = Number(options.rounds ?? 3);
  const jobs = Number(options.jobs ?? 1);
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error("rounds must be a positive integer");
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive integer");
  if (!process.env.API_KEY?.trim() && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("missing API_KEY or OPENAI_API_KEY; start with npm run eval:ab so .env is loaded");
  }
  if (process.env.EVAL_PRICING_FILE) {
    process.env.EVAL_PRICING_FILE = path.resolve(aDir, process.env.EVAL_PRICING_FILE);
  }
  const pricingFile = process.env.EVAL_PRICING_FILE;
  const experimentId = randomUUID();
  const comparisons = [];
  const runFiles = [];

  for (let round = 1; round <= rounds; round++) {
    const records = {};
    for (const variant of experimentOrder(round)) {
      const root = variant === "A" ? aDir : bDir;
      const result = await runVariant(root, variant, experimentId, round, jobs,
        options.task ? [options.task] : filters, Boolean(options.trace), Boolean(options.keep), pricingFile);
      records[variant] = result.record;
      runFiles.push(result.resultPath);
      if (result.exitCode !== 0) {
        console.warn("Variant " + variant + " round " + round + " exited with " + result.exitCode + "; preserving its recorded result.");
      }
    }
    const comparison = compareRuns(records.A, records.B);
    comparisons.push(comparison);
    console.log("Paired round " + round + ": " + (comparison.comparable ? "comparable" : "invalid"));
  }

  const summary = summarizeExperiment(comparisons);
  const report = renderComparison(comparisons, summary);
  const outputDir = path.join(aDir, "eval", "results", "experiments", experimentId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "experiment.json"), JSON.stringify({
    experimentId, rounds, jobs, runFiles, comparisons, summary,
  }, null, 2), "utf8");
  await writeFile(path.join(outputDir, "report.md"), report, "utf8");
  console.log(report);
  console.log("Experiment files: " + outputDir);
  if (summary.invalidRounds > 0) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await cli();

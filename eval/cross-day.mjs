#!/usr/bin/env node
/**
 * Run three same-day stability rounds against the immutable prompt-v2 baseline.
 *
 * This helper lives on the diagnostics branch, but dynamically imports eval/run.mjs
 * only after checking out the baseline SHA. The measured Agent/eval code is therefore
 * exactly the pinned commit, not the newer diagnostic harness.
 *
 * Usage (once on each of three different natural days):
 *   npm run eval:cross-day
 *   npm run eval:cross-day -- --date 2026-11-05
 *
 * The helper restores the original branch after each day's run. It leaves archived
 * JSON under eval/baselines/cross-day/<date>/ for later review/commit.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const BASELINE_SHA = "eac798de31b24463dba09361b8c2c551e1e114d2";
const EXPECTED_MODEL = "hy3";
const EXPECTED_BASE_URL = "http://127.0.0.1:8788/v1";
const ROUNDS = 3;
const JOBS = 4;
const TASK_COUNT = 20;

let interrupted = false;
const onInterrupt = () => {
  interrupted = true;
  console.error("[eval:cross-day] interrupt received; finishing the current round before restoring the original branch");
};
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

function localDate() {
  const now = new Date();
  const part = (value) => String(value).padStart(2, "0");
  return now.getFullYear() + "-" + part(now.getMonth() + 1) + "-" + part(now.getDate());
}

function parseArgs(args) {
  let date = localDate();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--help" || args[index] === "-h") return { help: true };
    if (args[index] === "--date") {
      date = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error("unknown argument: " + args[index]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
    throw new Error("--date must use YYYY-MM-DD");
  }
  return { date };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function currentEnvironment() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function loadPriorSummaries({ date, model, baseUrl }) {
  const archiveRoot = path.join(here, "baselines", "cross-day");
  let entries;
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const environment = currentEnvironment();
  const prior = [];
  for (const entry of entries.filter((item) => item.isDirectory() && item.name < date).sort((a, b) => a.name.localeCompare(b.name))) {
    const summaryPath = path.join(archiveRoot, entry.name, "summary.json");
    let summary;
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch (error) {
      throw new Error("cannot validate prior archive " + entry.name + ": " + (error instanceof Error ? error.message : String(error)));
    }

    if (summary.date !== entry.name || summary.baselineSha !== BASELINE_SHA || summary.model !== model ||
        summary.baseUrl !== baseUrl || summary.tasks !== TASK_COUNT || summary.jobs !== JOBS) {
      throw new Error("prior archive " + entry.name + " does not match the pinned experiment configuration");
    }
    for (const key of ["node", "platform", "arch", "timezone"]) {
      if (summary.environment?.[key] !== environment[key]) {
        throw new Error(
          "environment drift from " + entry.name + ": " + key + " was " +
          String(summary.environment?.[key]) + ", now " + String(environment[key]),
        );
      }
    }
    prior.push(summary);
  }
  return prior;
}

function roundMetrics(record) {
  const results = record.results ?? [];
  const hasResults = results.length > 0;
  const sum = (field) => hasResults
    ? results.reduce((total, result) => total + (result.tokens?.[field] ?? 0), 0)
    : null;
  return {
    round: record.round,
    at: record.at,
    ok: record.ok === true,
    passed: record.passed ?? results.filter((result) => result.ok).length,
    total: record.total ?? results.length,
    requests: Number.isFinite(record.totals?.requests)
      ? record.totals.requests
      : hasResults ? results.reduce((total, result) => total + result.requests, 0) : null,
    toolCalls: Number.isFinite(record.totals?.toolCalls)
      ? record.totals.toolCalls
      : hasResults ? results.reduce((total, result) => total + result.toolCalls, 0) : null,
    prompt: sum("prompt"),
    completion: sum("completion"),
    tokens: Number.isFinite(record.totals?.tokens)
      ? record.totals.tokens
      : sum("total"),
    unknown: Number.isFinite(record.totals?.unknownResponses)
      ? record.totals.unknownResponses
      : sum("unknownResponses"),
    elapsed: record.elapsed ?? null,
    failures: results.filter((result) => !result.ok).map((result) => ({
      name: result.name,
      type: result.failure ?? "fatal",
      error: result.error ?? "unknown failure",
    })),
    infraErrors: record.infraErrors ?? [],
    runnerError: record.runnerError,
  };
}

function buildDailySummary({ date, records, model, baseUrl, taskNames, priorDaysCompared }) {
  const rounds = records.map(roundMetrics);
  const taskNamesSeen = [...new Set(records.flatMap((record) => (record.results ?? []).map((result) => result.name)))].sort();
  const perTask = taskNamesSeen.map((name) => {
    const entries = records.map((record) => (record.results ?? []).find((result) => result.name === name)).filter(Boolean);
    const tokenValues = entries.map((entry) => entry.tokens.total);
    const requestValues = entries.map((entry) => entry.requests);
    const min = tokenValues.length ? Math.min(...tokenValues) : null;
    const max = tokenValues.length ? Math.max(...tokenValues) : null;
    return {
      name,
      requests: requestValues,
      tokens: tokenValues,
      medianTokens: median(tokenValues),
      minTokens: min,
      maxTokens: max,
      spread: min > 0 ? Number((max / min).toFixed(2)) : null,
      failures: entries.filter((entry) => !entry.ok).map((entry) => ({
        failure: entry.failure ?? "fatal",
        error: entry.error ?? "unknown failure",
      })),
    };
  });

  const taskAttempts = rounds.reduce((sum, round) => sum + round.total, 0);
  const taskPasses = rounds.reduce((sum, round) => sum + round.passed, 0);
  const successfulRounds = rounds.filter((round) => round.ok).length;

  return {
    date,
    baselineSha: BASELINE_SHA,
    model,
    baseUrl,
    command: "npm run eval:cross-day",
    tasks: taskNames.length,
    jobs: JOBS,
    rounds: records.length,
    plannedRounds: ROUNDS,
    complete: records.length === ROUNDS,
    generatedAt: new Date().toISOString(),
    environment: currentEnvironment(),
    environmentConsistency: {
      priorDaysCompared,
      originalSixRoundBaselineEnvironmentRecorded: false,
    },
    overall: {
      taskAttempts,
      taskPasses,
      passRate: taskAttempts > 0 ? Number(((taskPasses / taskAttempts) * 100).toFixed(1)) : 0,
      successfulRounds,
      totalRounds: records.length,
    },
    medians: {
      requests: median(rounds.map((round) => round.requests)),
      toolCalls: median(rounds.map((round) => round.toolCalls)),
      prompt: median(rounds.map((round) => round.prompt)),
      completion: median(rounds.map((round) => round.completion)),
      tokens: median(rounds.map((round) => round.tokens)),
      elapsed: median(rounds.map((round) => round.elapsed)),
    },
    tokenRange: {
      min: rounds.some((round) => Number.isFinite(round.tokens))
        ? Math.min(...rounds.map((round) => round.tokens).filter(Number.isFinite))
        : null,
      max: rounds.some((round) => Number.isFinite(round.tokens))
        ? Math.max(...rounds.map((round) => round.tokens).filter(Number.isFinite))
        : null,
    },
    perRound: rounds,
    perTask,
  };
}

async function git(args) {
  const { stdout } = await run("git", args, { cwd: repoRoot, encoding: "utf8" });
  return stdout.trim();
}

function printHelp() {
  console.log(
    "Run three full eval rounds on the current local natural day against baseline " + BASELINE_SHA + ".\n" +
    "Usage: npm run eval:cross-day [-- --date YYYY-MM-DD]\n" +
    "Requires MODEL=hy3, BASE_URL=" + EXPECTED_BASE_URL + ", API_KEY, 20 tasks, and a clean worktree.\n" +
    "The original branch is restored after the run; output is archived under eval/baselines/cross-day/<date>/.",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.date !== localDate()) {
    throw new Error(
      "refusing to backdate a stability run: --date must equal this machine's local date (" + localDate() + ")",
    );
  }

  const apiKey = (process.env.API_KEY ?? "").trim() || (process.env.OPENAI_API_KEY ?? "").trim();
  const model = (process.env.MODEL ?? "gpt-4o-mini").trim();
  const baseUrl = (process.env.BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  if (!apiKey) throw new Error("missing API_KEY (or OPENAI_API_KEY); see .env.example");
  if (model !== EXPECTED_MODEL) throw new Error("MODEL must remain " + EXPECTED_MODEL + "; got " + model);
  if (baseUrl !== EXPECTED_BASE_URL) {
    throw new Error("BASE_URL must remain " + EXPECTED_BASE_URL + "; got " + baseUrl);
  }

  const status = await git(["status", "--porcelain"]);
  const dirty = status.split(/\r?\n/).filter(Boolean).filter((line) => !line.startsWith("?? eval/baselines/cross-day/"));
  if (dirty.length > 0) {
    throw new Error("worktree must be clean except for prior cross-day archives:\n" + dirty.join("\n"));
  }

  const originalSha = await git(["rev-parse", "HEAD"]);
  const originalBranch = await git(["branch", "--show-current"]);
  const priorSummaries = await loadPriorSummaries({ date: options.date, model, baseUrl });
  const archiveDir = path.join(here, "baselines", "cross-day", options.date);
  try {
    await access(archiveDir);
    throw new Error("archive already exists for " + options.date + "; refusing to overwrite it");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let checkedOutBaseline = false;
  let records = [];
  try {
    await git(["checkout", "--detach", BASELINE_SHA]);
    checkedOutBaseline = true;
    const actualSha = await git(["rev-parse", "HEAD"]);
    if (actualSha !== BASELINE_SHA) throw new Error("baseline checkout mismatch: " + actualSha);

    const evalDir = path.join(repoRoot, "eval");
    const tasksDir = path.join(evalDir, "tasks");
    const taskEntries = await readdir(tasksDir, { withFileTypes: true });
    const taskNames = taskEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (taskNames.length !== TASK_COUNT) {
      throw new Error("expected exactly " + TASK_COUNT + " eval tasks; found " + taskNames.length);
    }

    await mkdir(archiveDir, { recursive: true });
    console.log("baseline: " + BASELINE_SHA);
    console.log("date: " + options.date + " · model: " + model + " · tasks: " + taskNames.length + " · jobs: " + JOBS);
    console.log("running " + ROUNDS + " sequential rounds; no retries, no task or checker changes");

    // Import only after checkout: this resolves eval/run.mjs from the pinned baseline commit.
    const baselineModule = await import(pathToFileURL(path.join(evalDir, "run.mjs")).href + "?baseline=" + Date.now());

    let runnerFailed = false;
    for (let round = 1; round <= ROUNDS; round += 1) {
      if (interrupted) break;
      console.log("\n=== " + options.date + " round " + round + "/" + ROUNDS + " ===");
      let record;
      try {
        const result = await baselineModule.runRound({
          tasksDir,
          names: taskNames,
          baseUrl,
          apiKey,
          model,
          jobs: JOBS,
          keep: false,
        });
        record = baselineModule.summarize({
          results: result.results,
          elapsed: result.elapsed,
          model,
          commit: BASELINE_SHA,
          infra: result.infra,
        });
      } catch (error) {
        runnerFailed = true;
        record = {
          at: new Date().toISOString(),
          model,
          commit: BASELINE_SHA,
          ok: false,
          passed: 0,
          total: 0,
          elapsed: null,
          totals: { requests: null, toolCalls: null, tokens: null, unknownResponses: null },
          infraErrors: [],
          runnerError: error instanceof Error ? error.message : String(error),
          results: [],
        };
      }

      record.date = options.date;
      record.round = round;
      record.baselineSha = BASELINE_SHA;
      records.push(record);
      await writeFile(
        path.join(archiveDir, "round-" + String(round).padStart(2, "0") + ".json"),
        JSON.stringify(record, null, 2),
        "utf8",
      );
      // A rejected round may have left workers in flight; do not start another round.
      if (runnerFailed || interrupted) break;
    }

    const summary = buildDailySummary({
      date: options.date,
      records,
      model,
      baseUrl,
      taskNames,
      priorDaysCompared: priorSummaries.map((item) => item.date),
    });
    await writeFile(path.join(archiveDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log("\nDaily result: " + summary.overall.taskPasses + "/" + summary.overall.taskAttempts +
      " tasks · " + summary.overall.passRate + "% · " + summary.overall.successfulRounds + "/" + ROUNDS +
      " full rounds · median " + summary.medians.tokens + " tokens");
    console.log("archived: eval/baselines/cross-day/" + options.date);

    if (interrupted) process.exitCode = 130;
    else if (records.length !== ROUNDS || records.some((record) => record.ok !== true)) process.exitCode = 1;
  } finally {
    if (checkedOutBaseline) {
      if (originalBranch) {
        await git(["checkout", originalBranch]);
      } else {
        await git(["checkout", "--detach", originalSha]);
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error("[eval:cross-day] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
}

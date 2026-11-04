#!/usr/bin/env node
/**
 * 跨天评测运行器：固定一个 commit（默认 `stability-2026-11-04` tag），
 * 在临时 git worktree 里跑 N 轮完整评测，并把每轮原始 JSON 按日期归档。
 *
 * 为什么用 worktree：跨天实验的代码必须固定，不能受主分支后续提交影响；
 * 也不能为了跑评测去 checkout 主工作区（会打断正在做的事）。
 * 评测本身零运行时依赖，所以 worktree 不需要 npm install。
 *
 * 用法：
 *   node eval/cross-day.mjs                                  # 今天（Asia/Shanghai），3 轮
 *   node eval/cross-day.mjs --date 2026-11-05                # 指定归档日期
 *   node eval/cross-day.mjs --date 2026-11-05 --rounds 3 --jobs 4
 *   node eval/cross-day.mjs --ref stability-2026-11-04
 *
 * 产出：
 *   eval/baselines/cross-day/<date>/round-01.json … round-03.json
 *   eval/baselines/cross-day/<date>/day-summary.json
 *
 * 注意：这是**真实模型调用**，会消耗端点额度；没有 API Key / 端点不通会直接失败。
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const archiveRoot = path.join(here, "baselines", "cross-day");
const DEFAULT_REF = "stability-2026-11-04";
const TIME_ZONE = "Asia/Shanghai";

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await cli();
}

async function cli() {
  const args = process.argv.slice(2);
  const options = { ref: DEFAULT_REF, rounds: 3, jobs: 4, date: localDate(), force: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ref") {
      options.ref = requiredValue(args, (index += 1), "--ref");
      continue;
    }
    if (arg === "--rounds") {
      options.rounds = Math.max(1, Number(requiredValue(args, (index += 1), "--rounds")) || 0);
      continue;
    }
    if (arg === "--jobs") {
      options.jobs = Math.max(1, Number(requiredValue(args, (index += 1), "--jobs")) || 0);
      continue;
    }
    if (arg === "--date") {
      options.date = requiredValue(args, (index += 1), "--date");
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    console.error(`unknown argument: ${arg}`);
    process.exitCode = 1;
    return;
  }

  if (!/^[A-Za-z0-9._-]+$/.test(options.date)) {
    console.error(`invalid --date "${options.date}": use YYYY-MM-DD (or a safe label)`);
    process.exitCode = 1;
    return;
  }

  const outDir = path.join(archiveRoot, options.date);
  if (!options.force && (await exists(outDir))) {
    console.error(`archive already exists: ${path.relative(repoRoot, outDir)} (use --force to append/overwrite)`);
    process.exitCode = 1;
    return;
  }

  const envFile = path.join(repoRoot, ".env");
  if (!(await exists(envFile))) {
    console.error(`missing ${path.relative(repoRoot, envFile)}; cross-day runs need the real endpoint`);
    process.exitCode = 1;
    return;
  }

  const sha = await git(["rev-parse", `${options.ref}^{commit}`]);
  const holder = await mkdtemp(path.join(tmpdir(), "agent-cross-day-"));
  const worktree = path.join(holder, "tree");
  console.log(`ref:     ${options.ref} (${sha.slice(0, 7)})`);
  console.log(`date:    ${options.date} (${TIME_ZONE})`);
  console.log(`rounds:  ${options.rounds}  jobs: ${options.jobs}`);
  console.log(`archive: ${path.relative(repoRoot, outDir)}\n`);

  const records = [];
  try {
    await git(["worktree", "add", "--detach", worktree, sha]);
    await mkdir(outDir, { recursive: true });

    for (let round = 1; round <= options.rounds; round += 1) {
      console.log(`--- round ${round}/${options.rounds} ---`);
      const code = await runEval(worktree, envFile, options.jobs);
      const record = await newestRecord(worktree);
      const destination = path.join(outDir, `round-${String(round).padStart(2, "0")}.json`);
      await copyFile(path.join(worktree, "eval", "results", record), destination);

      const parsed = JSON.parse(await readFile(destination, "utf8"));
      records.push(parsed);
      console.log(
        `  archived ${path.relative(repoRoot, destination)} · ${parsed.passed}/${parsed.total} · ` +
          `${parsed.totals?.tokens ?? "?"} tokens · ${parsed.elapsed ?? "?"}s` +
          `${code === 0 ? "" : ` (eval exit ${code})`}\n`,
      );
    }

    const summary = summarizeDay({ date: options.date, ref: options.ref, commit: sha, records });
    await writeFile(path.join(outDir, "day-summary.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log(
      `day summary: ${summary.aggregate.passed}/${summary.aggregate.total} tasks · ` +
        `median ${summary.medians.tokens} tokens · ${summary.medians.elapsed}s`,
    );
    if (summary.aggregate.passed < summary.aggregate.total) process.exitCode = 1;
  } finally {
    await git(["worktree", "remove", "--force", worktree]).catch(() => {});
    await rm(holder, { recursive: true, force: true }).catch(() => {});
  }
}

/** 把同一天的多轮记录折成可跨天对比的摘要；纯函数，测试直接喂假记录。 */
export function summarizeDay({ date, ref, commit, records }) {
  if (records.length === 0) throw new Error("summarizeDay needs at least one round");

  const perRound = records.map((record, index) => ({
    round: index + 1,
    at: record.at,
    passed: record.passed,
    total: record.total,
    requests: record.totals?.requests ?? null,
    toolCalls: record.totals?.toolCalls ?? null,
    tokens: record.totals?.tokens ?? null,
    elapsed: record.elapsed ?? null,
    failures: record.results
      .filter((task) => !task.ok)
      .map((task) => ({ name: task.name, failure: task.failure, error: task.error })),
  }));

  const names = records[0].results.map((task) => task.name);
  const perTask = names.map((name) => {
    const entries = records.map((record) => record.results.find((task) => task.name === name));
    const tokens = entries.map((task) => task.tokens.total);
    return {
      name,
      tokens,
      min: Math.min(...tokens),
      max: Math.max(...tokens),
      spread: Number((Math.max(...tokens) / Math.min(...tokens)).toFixed(2)),
      failures: entries.filter((task) => !task.ok).map((task) => task.name),
    };
  });

  const values = (key) => perRound.map((round) => round[key]).filter((value) => value !== null);

  return {
    date,
    ref,
    commit,
    model: records[0].model,
    rounds: records.length,
    aggregate: {
      passed: perRound.reduce((total, round) => total + round.passed, 0),
      total: perRound.reduce((total, round) => total + round.total, 0),
    },
    medians: {
      requests: median(values("requests")),
      toolCalls: median(values("toolCalls")),
      tokens: median(values("tokens")),
      elapsed: median(values("elapsed")),
    },
    perRound,
    perTask,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** 今天（Asia/Shanghai）的 YYYY-MM-DD；避免用机器本地时区导致归档日期漂移。 */
function localDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function requiredValue(args, index, name) {
  const value = args[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

function runEval(cwd, envFile, jobs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--env-file", envFile, "eval/run.mjs", "--jobs", String(jobs)], {
      cwd,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** 一轮结束后取 worktree 里最新的结果文件；run.mjs 只写一个。 */
async function newestRecord(worktree) {
  const dir = path.join(worktree, "eval", "results");
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    throw new Error(`no results written under ${dir}`);
  }
  if (names.length === 0) throw new Error(`no results written under ${dir}`);

  const withTime = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(path.join(dir, name))).mtimeMs })),
  );
  withTime.sort((a, b) => a.mtime - b.mtime);
  return withTime.at(-1).name;
}

function git(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`));
    });
  });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

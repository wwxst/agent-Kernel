#!/usr/bin/env node
/**
 * 汇总最近几次**完整**评测（跑满当前任务数的那种），给出通过率、平均步数、总耗时，
 * 以及三者的中位数。单跑某几个任务的记录会被自动忽略，免得污染中位数。
 *
 *   npm run eval:summary        # 最近 3 轮
 *   node eval/summary.mjs 5     # 最近 5 轮
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = path.join(here, "tasks");
const resultsDir = path.join(here, "results");

const wanted = Number(process.argv[2] ?? 3);
const taskCount = (await readdir(tasksDir)).length;

let files;
try {
  files = (await readdir(resultsDir)).filter((name) => name.endsWith(".json")).sort();
} catch {
  console.log("还没有评测记录：先跑 npm run eval");
  process.exit(0);
}

const runs = [];
for (const file of files) {
  const record = JSON.parse(await readFile(path.join(resultsDir, file), "utf8"));
  // 只统计完整跑：任务数对得上，说明不是 --only 过滤出来的。
  if (record.total === taskCount) runs.push(record);
}

if (runs.length === 0) {
  console.log(`还没有完整跑过全部 ${taskCount} 个任务的记录`);
  process.exit(0);
}

const recent = runs.slice(-wanted);
const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

console.log(`最近 ${recent.length} 轮完整评测（共 ${taskCount} 个任务）：`);
for (const [index, run] of recent.entries()) {
  const seconds = run.elapsed ?? run.results.reduce((total, task) => total + task.seconds, 0);
  // 老记录只有 steps（当时把「问模型的次数」叫步数）；新记录统一叫 requests。
  const requests = average(run.results.map((task) => task.requests ?? task.steps));
  const tokens = run.totals?.tokens;
  console.log(
    `  第 ${index + 1} 轮  ${run.passed}/${run.total}  ${requests.toFixed(1)} 次请求  ` +
      `${tokens === undefined ? "" : `${tokens} tokens  `}${Math.round(seconds)}s  ${run.at}`,
  );
}

const passRates = recent.map((run) => (run.passed / run.total) * 100);
const averageRequests = recent.map((run) =>
  average(run.results.map((task) => task.requests ?? task.steps)),
);
// 老记录没有 elapsed（串行跑，任务耗时之和就等于墙钟），新记录优先用墙钟。
const totalSeconds = recent.map((run) => run.elapsed ?? run.results.reduce((total, task) => total + task.seconds, 0));

// 按轮取中位数会把「3 轮里 1 轮 19/20」压成 100%：中位数只描述典型轮次，
// 不描述总通过量。两个口径都打印，避免把典型轮次误读成整体成功率。
const aggregatePassed = recent.reduce((total, run) => total + run.passed, 0);
const aggregateTotal = recent.reduce((total, run) => total + run.total, 0);
const models = [...new Set(recent.map((run) => run.model).filter((model) => model !== undefined))];
const commits = [...new Set(recent.map((run) => (run.commit ?? "unknown").slice(0, 7)))];
console.log(
  `\n模型：${models.length > 0 ? models.join(", ") : "unknown"} · 提交：${commits.join(", ")}`,
);
console.log(
  `按轮中位数：通过率 ${median(passRates).toFixed(0)}% · 平均 ${median(averageRequests).toFixed(1)} 次请求 · ` +
    `合计 ${Math.round(median(totalSeconds))}s`,
);
console.log(
  `合计：${aggregatePassed}/${aggregateTotal} 个任务（${((aggregatePassed / aggregateTotal) * 100).toFixed(1)}%）`,
);

// 成本只在有记录时汇总：没有 usage 的轮次混在一起算中位数会骗人。
const tokenTotals = recent.filter((run) => run.totals?.tokens !== undefined).map((run) => run.totals.tokens);
if (tokenTotals.length > 0) {
  const unknown = recent.reduce((total, run) => total + (run.totals?.unknownResponses ?? 0), 0);
  console.log(
    `Token：中位数 ${median(tokenTotals)}${unknown > 0 ? `（至少；${unknown} 个响应没有 usage）` : ""}`,
  );
}

// 不稳定的任务比失败更值得注意：它说明检查或任务本身有随机性。
if (recent.length > 1) {
  const unstable = recent[0].results
    .map((task) => task.name)
    .filter((name) => recent.some((run) => !run.results.find((task) => task.name === name)?.ok));
  if (unstable.length > 0) {
    console.log("\n不是每轮都通过的任务：");
    for (const name of unstable) {
      const wins = recent.filter((run) => run.results.find((task) => task.name === name)?.ok).length;
      console.log(`  ${name}: ${wins}/${recent.length}`);
    }
  }
}

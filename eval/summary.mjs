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
  console.log(
    `  第 ${index + 1} 轮  ${run.passed}/${run.total}  ${average(run.results.map((task) => task.steps)).toFixed(1)} 步  ${Math.round(run.results.reduce((total, task) => total + task.seconds, 0))}s  ${run.at}`,
  );
}

const passRates = recent.map((run) => (run.passed / run.total) * 100);
const averageSteps = recent.map((run) => average(run.results.map((task) => task.steps)));
const totalSeconds = recent.map((run) => run.results.reduce((total, task) => total + task.seconds, 0));

console.log(
  `\n中位数：通过率 ${median(passRates).toFixed(0)}% · 平均 ${median(averageSteps).toFixed(1)} 步 · 合计 ${Math.round(median(totalSeconds))}s`,
);

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

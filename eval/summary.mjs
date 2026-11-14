#!/usr/bin/env node
/**
 * 文件目的：把最近几轮完整评测的成绩汇总起来 —— 通过率、平均请求数、总耗时，以及它们的中位数。
 *
 * 只算「跑满所有任务」的轮次。只跑了两三个任务的记录会被自动忽略，
 * 否则中位数会被这些半截数据带偏。
 *
 * 文件职责：负责读结果文件、筛掉不可信的轮次、算中位数与合计、打印。
 * 不负责跑评测（`run.mjs`）、不负责判分、不写任何文件。
 *
 * 内容目录（顶层脚本，没有函数，从上到下一条线）：
 *   - 读任务数与 `results/*.json`；一份记录都没有就提示先跑评测。
 *   - 过滤：任务集合或通过数对不上、`infraErrors` 非空（整轮不可信）都不计入。
 *   - 打印：逐轮成绩 → 按轮中位数 → 合计通过量 → token 中位数 → 不是每轮都通过的任务。
 *   - 两个口径都打：中位数只描述典型轮次，合计才是总通过量，别把前者当成整体成功率。
 *
 * 模块关系：只依赖 Node 内置模块，读 `eval/results/` 与 `eval/tasks/` 目录。
 * 由 `npm run eval:summary` 启动；不被任何模块引用。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = path.join(here, "tasks");
const resultsDir = path.join(here, "results");

const wanted = Number(process.argv[2] ?? 3);
if (!Number.isSafeInteger(wanted) || wanted <= 0) throw new Error("round count must be a positive safe integer");
const taskNames = new Set((await readdir(tasksDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name));
const taskCount = taskNames.size;

let files;
try {
  files = (await readdir(resultsDir)).filter((name) => name.endsWith(".json")).sort();
} catch {
  console.log("还没有评测记录：先跑 npm run eval");
  process.exit(0);
}

const runs = [];
let invalidRounds = 0;
for (const file of files) {
  const record = JSON.parse(await readFile(path.join(resultsDir, file), "utf8"));
  // 汇总头的 total 不能证明执行完整；结果必须恰好覆盖每个当前任务一次，且计数自洽。
  if (record === null || typeof record !== "object") continue;
  if (record.total !== taskCount) continue;
  if (!Array.isArray(record.results) || record.results.length !== taskCount ||
      !record.results.every((task) => task !== null && typeof task === "object" &&
        taskNames.has(task.name) && typeof task.ok === "boolean") ||
      new Set(record.results.map((task) => task.name)).size !== taskCount ||
      record.passed !== record.results.filter((task) => task.ok).length) continue;
  // infraErrors 非空 = 这一轮不可信（后台 rejection 等）：即使任务全过也不能算有效样本，
  // 否则会把 100% 通过率写进中位数、把异常成本混进汇总。
  if ((record.infraErrors ?? []).length > 0) {
    invalidRounds += 1;
    continue;
  }
  runs.push(record);
}

if (invalidRounds > 0) {
  console.log(`已跳过 ${invalidRounds} 轮基础设施无效记录（infraErrors 非空）`);
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

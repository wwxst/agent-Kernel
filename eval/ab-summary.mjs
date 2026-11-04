#!/usr/bin/env node
/**
 * 三臂实验汇总：读 eval/baselines/<date>-shell-ab/ 下的每轮结果与 diagnostics，
 * 输出成功率、请求/tokens 的中位与范围、最差轮、shell 失败次数。
 *
 * 用法：node eval/ab-summary.mjs [baselinesDir]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "eval/baselines/2026-11-04-shell-ab");
const ARMS = ["base", "B", "C"];
const SPOT_TASKS = ["13-callback-to-promise", "20-fix-email-regex", "08-extract-duplication"];

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const range = (values) => `${Math.min(...values)}–${Math.max(...values)}`;

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function shellFailures(diagnosticsDir) {
  let calls = 0;
  let failures = 0;
  let files = [];
  try {
    files = await readdir(diagnosticsDir);
  } catch {
    return { calls, failures };
  }
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const record = await readJson(path.join(diagnosticsDir, file));
    for (const tool of record.tools ?? []) {
      if (tool.name !== "shell") continue;
      calls += 1;
      if (/^exit [1-9]/i.test(tool.resultHead ?? "")) failures += 1;
    }
  }
  return { calls, failures };
}

const rows = [];
for (const arm of ARMS) {
  const armDir = path.join(root, arm);
  const rounds = [];
  const shell = { calls: 0, failures: 0 };
  for (let index = 1; index <= 5; index += 1) {
    const tag = `round-${String(index).padStart(2, "0")}`;
    const record = await readJson(path.join(armDir, `${tag}.result.json`));
    const diag = await shellFailures(path.join(armDir, tag));
    shell.calls += diag.calls;
    shell.failures += diag.failures;
    rounds.push({
      tag,
      passed: record.passed,
      total: record.total,
      requests: record.totals.requests,
      tokens: record.totals.tokens,
      toolCalls: record.totals.toolCalls,
      elapsed: record.elapsed,
      shellFailures: diag.failures,
      tasks: Object.fromEntries(record.results.map((result) => [result.name, result])),
    });
  }
  const full = await readJson(path.join(armDir, "full.result.json"));
  const fullDiag = await shellFailures(path.join(armDir, "full"));
  rows.push({
    arm,
    rounds,
    shell,
    full,
    fullShellFailures: fullDiag.failures,
  });
}

const summarizeArm = (row) => {
  const requests = row.rounds.map((round) => round.requests);
  const tokens = row.rounds.map((round) => round.tokens);
  const passed = row.rounds.reduce((sum, round) => sum + round.passed, 0);
  const total = row.rounds.reduce((sum, round) => sum + round.total, 0);
  const spot = Object.fromEntries(
    SPOT_TASKS.map((name) => {
      const values = row.rounds.map((round) => round.tasks[name]);
      return [
        name,
        {
          requests: values.map((value) => value.requests),
          tokens: values.map((value) => value.tokens.total),
          failures: values.filter((value) => !value.ok).length,
        },
      ];
    }),
  );
  return {
    arm: row.arm,
    spotPass: `${passed}/${total}`,
    requestsMedian: median(requests),
    requestsRange: range(requests),
    tokensMedian: median(tokens),
    tokensRange: range(tokens),
    worstTokens: Math.max(...tokens),
    worstRequests: Math.max(...requests),
    shellFailures: row.shell.failures,
    shellCalls: row.shell.calls,
    fullPass: `${row.full.passed}/${row.full.total}`,
    fullRequests: row.full.totals.requests,
    fullTokens: row.full.totals.tokens,
    fullSeconds: row.full.elapsed,
    fullShellFailures: row.fullShellFailures,
    spot,
  };
};

const summary = rows.map(summarizeArm);
await writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(JSON.stringify(summary, null, 2));

// 表格：方便直接贴进报告。
console.log("\n| 臂 | 重点通过 | 请求 中位/范围 | tokens 中位/范围 | 最差轮 tokens | shell 失败 | 全量 | 全量请求/tokens/秒 |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const item of summary) {
  console.log(
    `| ${item.arm} | ${item.spotPass} | ${item.requestsMedian} / ${item.requestsRange} | ` +
      `${item.tokensMedian} / ${item.tokensRange} | ${item.worstTokens} | ${item.shellFailures}/${item.shellCalls} | ` +
      `${item.fullPass} | ${item.fullRequests} / ${item.fullTokens} / ${item.fullSeconds}s |`,
  );
}

console.log("\n| 任务 | " + ARMS.map((arm) => `${arm} 请求均值 | ${arm} tokens 均值`).join(" | ") + " |");
console.log("| --- | " + ARMS.map(() => "--- | ---").join(" ") + " |");
for (const task of SPOT_TASKS) {
  const cells = ARMS.map((arm) => {
    const entry = summary.find((item) => item.arm === arm).spot[task];
    const mean = (values) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    return `${mean(entry.requests)} | ${mean(entry.tokens)}`;
  });
  console.log(`| ${task} | ${cells.join(" | ")} |`);
}

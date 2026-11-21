#!/usr/bin/env node
/**
 * 比较两轮同口径评测。A 是基线，B 是候选；不兼容配置会明确拒绝给出可采信结论。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const metrics = ["requests", "summaryRequests", "toolCalls", "tokens", "cachedPromptTokens", "seconds"];

export function compareRuns(a, b) {
  const issues = [];
  const same = (label, left, right) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) issues.push(label + " differs");
  };
  same("suiteVersion", a.suiteVersion, b.suiteVersion);
  same("model", a.model, b.model);
  same("endpointHost", a.endpointHost ?? "unknown", b.endpointHost ?? "unknown");
  same("endpointPath", a.endpointPath ?? "unknown", b.endpointPath ?? "unknown");
  same("jobs", a.jobs ?? null, b.jobs ?? null);
  same("trace", a.trace ?? false, b.trace ?? false);
  same("keep", a.keep ?? false, b.keep ?? false);
  same("pricingSha256", a.pricingSha256 ?? "unknown", b.pricingSha256 ?? "unknown");
  same("costCurrency", a.totals?.cost?.currency ?? null, b.totals?.cost?.currency ?? null);
  same("taskSuiteSha256", a.taskSuiteSha256 ?? "unknown", b.taskSuiteSha256 ?? "unknown");
  same("taskNames", [...(a.taskNames ?? a.results.map((item) => item.name))].sort(),
    [...(b.taskNames ?? b.results.map((item) => item.name))].sort());
  same("runtime", runtimeKey(a.environment), runtimeKey(b.environment));
  if ((a.infraErrors ?? []).length > 0) issues.push("A run contains infrastructure errors");
  if ((b.infraErrors ?? []).length > 0) issues.push("B run contains infrastructure errors");

  const aResults = new Map((a.results ?? []).map((item) => [item.name, item]));
  const bResults = new Map((b.results ?? []).map((item) => [item.name, item]));
  const names = [...new Set([...aResults.keys(), ...bResults.keys()])].sort();
  if (names.length === 0) issues.push("no task results");
  const tasks = names.map((name) => {
    const left = aResults.get(name);
    const right = bResults.get(name);
    if (!left || !right) {
      issues.push("task set differs: " + name);
      return { name, status: "missing", a: left ?? null, b: right ?? null };
    }
    if (JSON.stringify(left.settings ?? {}) !== JSON.stringify(right.settings ?? {})) {
      issues.push("task settings differ: " + name);
    }
    if (left.failure === "environment" || left.failure === "infra" ||
        right.failure === "environment" || right.failure === "infra") {
      issues.push("task has environment or infrastructure failure: " + name);
    }
    const status = left.ok === right.ok ? "same" : right.ok ? "improved" : "regressed";
    const row = { name, status, aOk: left.ok, bOk: right.ok };
    for (const metric of metrics) {
      const leftValue = metric === "tokens" ? left.tokens?.total
        : metric === "cachedPromptTokens" ? left.tokens?.cachedPromptTokens : left[metric];
      const rightValue = metric === "tokens" ? right.tokens?.total
        : metric === "cachedPromptTokens" ? right.tokens?.cachedPromptTokens : right[metric];
      row[metric + "A"] = typeof leftValue === "number" ? leftValue : null;
      row[metric + "B"] = typeof rightValue === "number" ? rightValue : null;
      row[metric + "Delta"] = typeof leftValue === "number" && typeof rightValue === "number"
        ? rightValue - leftValue : null;
    }
    const aCost = left.cost?.amount;
    const bCost = right.cost?.amount;
    row.costDelta = left.cost?.complete === true && right.cost?.complete === true &&
      left.cost?.currency === right.cost?.currency &&
      typeof aCost === "number" && typeof bCost === "number" ? bCost - aCost : null;
    return row;
  });

  const aPassed = a.results?.filter((item) => item.ok).length ?? 0;
  const bPassed = b.results?.filter((item) => item.ok).length ?? 0;
  const aTotal = a.results?.length ?? 0;
  const bTotal = b.results?.length ?? 0;
  const totals = {
    passRateDeltaPoints: aTotal > 0 && bTotal > 0
      ? Number(((bPassed / bTotal - aPassed / aTotal) * 100).toFixed(2)) : null,
    requestsDelta: numericDelta(a.totals?.requests, b.totals?.requests),
    summaryRequestsDelta: numericDelta(a.totals?.summaryRequests, b.totals?.summaryRequests),
    toolCallsDelta: numericDelta(a.totals?.toolCalls, b.totals?.toolCalls),
    tokensDelta: numericDelta(a.totals?.tokens, b.totals?.tokens),
    cachedPromptTokensDelta: numericDelta(a.totals?.cachedPromptTokens, b.totals?.cachedPromptTokens),
    elapsedDelta: numericDelta(a.elapsed, b.elapsed),
    costDelta: a.totals?.cost?.complete === true && b.totals?.cost?.complete === true &&
      a.totals?.cost?.currency === b.totals?.cost?.currency
      ? numericDelta(a.totals?.cost?.amount, b.totals?.cost?.amount) : null,
    costCurrency: a.totals?.cost?.currency ?? null,
  };

  return {
    comparable: issues.length === 0,
    issues: [...new Set(issues)],
    suiteVersion: a.suiteVersion ?? "unknown",
    model: a.model ?? "unknown",
    a: { commit: a.commit ?? "unknown", branch: a.branch ?? "unknown", passed: aPassed, total: aTotal },
    b: { commit: b.commit ?? "unknown", branch: b.branch ?? "unknown", passed: bPassed, total: bTotal },
    totals,
    tasks,
  };
}

export function summarizeExperiment(comparisons) {
  if (!Array.isArray(comparisons) || comparisons.length === 0) {
    throw new Error("at least one paired comparison is required");
  }
  const valid = comparisons.filter((item) => item.comparable);
  const allTasks = valid.flatMap((item) => item.tasks);
  const deltaMedian = (key) => {
    const values = valid.map((item) => item.totals[key]).filter((value) => typeof value === "number");
    return values.length === 0 ? null : median(values);
  };
  return {
    rounds: comparisons.length,
    comparableRounds: valid.length,
    invalidRounds: comparisons.length - valid.length,
    improvedTasks: allTasks.filter((item) => item.status === "improved").length,
    regressedTasks: allTasks.filter((item) => item.status === "regressed").length,
    unchangedTasks: allTasks.filter((item) => item.status === "same").length,
    medianPassRateDeltaPoints: deltaMedian("passRateDeltaPoints"),
    medianRequestsDelta: deltaMedian("requestsDelta"),
    medianSummaryRequestsDelta: deltaMedian("summaryRequestsDelta"),
    medianToolCallsDelta: deltaMedian("toolCallsDelta"),
    medianTokensDelta: deltaMedian("tokensDelta"),
    medianCachedPromptTokensDelta: deltaMedian("cachedPromptTokensDelta"),
    medianElapsedDelta: deltaMedian("elapsedDelta"),
    medianCostDelta: deltaMedian("costDelta"),
    costCurrency: valid.find((item) => item.totals.costCurrency)?.totals.costCurrency ?? null,
  };
}

export function renderComparison(comparisons, summary = summarizeExperiment(comparisons)) {
  const lines = [
    "# Agent A/B experiment report",
    "",
    "A = baseline; B = candidate. Negative cost/token/time deltas mean B used less.",
    "",
    "| Item | Result |",
    "| --- | ---: |",
    "| Paired rounds | " + summary.rounds + " |",
    "| Comparable rounds | " + summary.comparableRounds + " |",
    "| Invalid rounds | " + summary.invalidRounds + " |",
    "| Improved tasks | " + summary.improvedTasks + " |",
    "| Regressed tasks | " + summary.regressedTasks + " |",
    "| Unchanged tasks | " + summary.unchangedTasks + " |",
    "| Median pass-rate delta | " + show(summary.medianPassRateDeltaPoints, " pp") + " |",
    "| Median business request delta | " + show(summary.medianRequestsDelta) + " |",
    "| Median summary request delta | " + show(summary.medianSummaryRequestsDelta) + " |",
    "| Median tool-call delta | " + show(summary.medianToolCallsDelta) + " |",
    "| Median token delta | " + show(summary.medianTokensDelta) + " |",
    "| Median cached input token delta | " + show(summary.medianCachedPromptTokensDelta) + " |",
    "| Median elapsed delta | " + show(summary.medianElapsedDelta, " s") + " |",
    "| Median cost delta | " + show(summary.medianCostDelta, summary.costCurrency ? " " + summary.costCurrency : "") + " |",
    "",
    "## Per-round validity",
    "",
  ];
  for (const [index, item] of comparisons.entries()) {
    lines.push("### Round " + (index + 1) + ": " + (item.comparable ? "comparable" : "invalid"));
    if (item.issues.length > 0) for (const issue of item.issues) lines.push("- " + issue);
    if (item.tasks.length > 0) {
      lines.push("", "| Task | Status | Token Δ | Request Δ | Tool Δ | Time Δ (s) | Cost Δ |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
      for (const task of item.tasks) {
        lines.push("| " + task.name + " | " + task.status + " | " +
          show(task.tokensDelta) + " | " + show(task.requestsDelta) + " | " +
          show(task.toolCallsDelta) + " | " + show(task.secondsDelta) + " | " +
          show(task.costDelta, item.totals.costCurrency ? " " + item.totals.costCurrency : "") + " |");
      }
    }
    lines.push("");
  }
  lines.push("## Decision notes", "", "- Do not adopt a change solely because tokens or time decreased.", "- Reject regressions in task success, safety, or required behavior.", "- Review quality scorecards and blocking findings before accepting a candidate.", "- Invalid rounds must be rerun; do not mix incompatible configurations.", "");
  return lines.join("\n");
}

function runtimeKey(environment) {
  if (!environment) return "legacy";
  return [environment.node, environment.platform, environment.arch, environment.osRelease].join("|");
}

function numericDelta(a, b) {
  return typeof a === "number" && typeof b === "number" ? b - a : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function show(value, suffix = "") {
  return typeof value === "number" ? String(Number(value.toFixed(3))) + suffix : "unknown";
}

async function cli() {
  const args = process.argv.slice(2);
  const positional = [];
  let output;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--out") output = args[++index];
    else positional.push(args[index]);
  }
  if (positional.length !== 2) throw new Error("usage: node eval/compare.mjs A.json B.json [--out report.md]");
  const [a, b] = await Promise.all(positional.map((file) =>
    readFile(path.resolve(file), "utf8").then(JSON.parse)));
  const comparison = compareRuns(a, b);
  const report = renderComparison([comparison]);
  console.log(report);
  if (output) {
    const destination = path.resolve(output);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, report, "utf8");
  }
  if (!comparison.comparable) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await cli();

#!/usr/bin/env node
/**
 * 比较两轮同口径评测。A 是基线，B 是候选；不兼容配置会明确拒绝给出可采信结论。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const metrics = [
  "requests", "summaryRequests", "toolCalls",
  "promptTokens", "completionTokens", "tokens", "cachedPromptTokens", "seconds",
];

export function compareRuns(a, b) {
  const issues = [];
  const warnings = [];
  const same = (label, left, right) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) issues.push(label + " differs");
  };
  if (typeof a.runId === "string" && a.runId.length > 0 &&
      typeof b.runId === "string" && b.runId.length > 0 && a.runId === b.runId) {
    issues.push("A and B must be distinct run IDs");
  }
  same("suiteVersion", a.suiteVersion, b.suiteVersion);
  same("model", a.model, b.model);
  same("endpointHost", a.endpointHost ?? "unknown", b.endpointHost ?? "unknown");
  same("endpointPath", a.endpointPath ?? "unknown", b.endpointPath ?? "unknown");
  same("jobs", a.jobs ?? null, b.jobs ?? null);
  same("trace", a.trace ?? false, b.trace ?? false);
  same("keep", a.keep ?? false, b.keep ?? false);
  const factorA = a.experiment?.factor ?? "unspecified";
  const factorB = b.experiment?.factor ?? "unspecified";
  same("experimentFactor", factorA, factorB);
  const experimentIdA = a.experiment?.id ?? null;
  const experimentIdB = b.experiment?.id ?? null;
  same("experimentId", experimentIdA, experimentIdB);
  const variantA = a.experiment?.variant ?? null;
  const variantB = b.experiment?.variant ?? null;
  if (variantA !== null || variantB !== null) {
    if (variantA !== "A" || variantB !== "B") {
      issues.push("expected A baseline and B candidate variants");
    }
  }
  if (!["unspecified", "agent-runtime", "system-prompt", "tool-definitions"].includes(factorA)) {
    issues.push("unknown experiment factor: " + factorA);
  }
  const compareHash = (label, left, right) => {
    if (left === undefined || right === undefined) {
      if (factorA !== "unspecified") issues.push(label + " fingerprint missing");
      return;
    }
    if (factorA === label) {
      if (left === right) issues.push(label + " factor did not change");
    } else if (left !== right) {
      issues.push(label + " changed outside the declared experiment factor");
    }
  };
  compareHash("system-prompt", a.promptSha256, b.promptSha256);
  compareHash("tool-definitions", a.toolDefinitionsSha256, b.toolDefinitionsSha256);
  if (factorA === "system-prompt" || factorA === "agent-runtime" || factorA === "tool-definitions") {
    if (!a.runtimeSourceSha256 || !b.runtimeSourceSha256) {
      issues.push("runtime source fingerprint missing");
    } else if (factorA === "system-prompt" && a.runtimeSourceSha256 !== b.runtimeSourceSha256) {
      issues.push("runtime source changed outside the system-prompt experiment");
    } else if ((factorA === "agent-runtime" || factorA === "tool-definitions") &&
      a.runtimeSourceSha256 === b.runtimeSourceSha256) {
      issues.push(factorA + " factor did not change runtime source");
    }
  } else if (factorA === "unspecified" &&
    a.runtimeSourceSha256 !== undefined && b.runtimeSourceSha256 !== undefined &&
    a.runtimeSourceSha256 !== b.runtimeSourceSha256) {
    issues.push("runtime source changed without a declared experiment factor");
  }
  same("pricingSha256", a.pricingSha256 ?? "unknown", b.pricingSha256 ?? "unknown");
  same("evalHarnessSha256", a.evalHarnessSha256 ?? null, b.evalHarnessSha256 ?? null);
  if (!a.evalHarnessSha256 || !b.evalHarnessSha256) issues.push("evaluation harness fingerprint missing");
  same("costCurrency", a.totals?.cost?.currency ?? null, b.totals?.cost?.currency ?? null);
  same("taskSuiteSha256", a.taskSuiteSha256 ?? "unknown", b.taskSuiteSha256 ?? "unknown");
  same("taskNames", [...(a.taskNames ?? a.results.map((item) => item.name))].sort(),
    [...(b.taskNames ?? b.results.map((item) => item.name))].sort());
  same("runtime", runtimeKey(a.environment), runtimeKey(b.environment));
  if ((a.infraErrors ?? []).length > 0) issues.push("A run contains infrastructure errors");
  if ((b.infraErrors ?? []).length > 0) issues.push("B run contains infrastructure errors");
  if (a.workingTreeClean !== true) warnings.push("A working tree is not confirmed clean; commit SHA may not describe all evaluated code");
  if (b.workingTreeClean !== true) warnings.push("B working tree is not confirmed clean; commit SHA may not describe all evaluated code");
  if (a.totals?.unknownResponses !== 0 || b.totals?.unknownResponses !== 0) {
    warnings.push("some model responses have unknown usage; token deltas are lower bounds and are omitted");
  }
  if (a.totals?.cacheUsageUnknown !== 0 || b.totals?.cacheUsageUnknown !== 0) {
    warnings.push("some model responses have unknown cache usage; cached-token deltas are omitted");
  }

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
    const tokenUsageComplete = left.tokens?.unknownResponses === 0 && right.tokens?.unknownResponses === 0;
    const cacheUsageComplete = left.tokens?.cacheUsageUnknown === 0 && right.tokens?.cacheUsageUnknown === 0;
    for (const metric of metrics) {
      const leftValue = metric === "tokens" ? left.tokens?.total
        : metric === "promptTokens" ? left.tokens?.prompt
        : metric === "completionTokens" ? left.tokens?.completion
        : metric === "cachedPromptTokens" ? left.tokens?.cachedPromptTokens : left[metric];
      const rightValue = metric === "tokens" ? right.tokens?.total
        : metric === "promptTokens" ? right.tokens?.prompt
        : metric === "completionTokens" ? right.tokens?.completion
        : metric === "cachedPromptTokens" ? right.tokens?.cachedPromptTokens : right[metric];
      const complete = metric === "tokens" || metric === "promptTokens" || metric === "completionTokens"
        ? tokenUsageComplete
        : metric === "cachedPromptTokens" ? cacheUsageComplete : true;
      row[metric + "A"] = complete && typeof leftValue === "number" ? leftValue : null;
      row[metric + "B"] = complete && typeof rightValue === "number" ? rightValue : null;
      row[metric + "Delta"] = complete && typeof leftValue === "number" && typeof rightValue === "number"
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
    promptTokensDelta: a.totals?.unknownResponses === 0 && b.totals?.unknownResponses === 0
      ? numericDelta(a.totals?.promptTokens, b.totals?.promptTokens) : null,
    completionTokensDelta: a.totals?.unknownResponses === 0 && b.totals?.unknownResponses === 0
      ? numericDelta(a.totals?.completionTokens, b.totals?.completionTokens) : null,
    tokensDelta: a.totals?.unknownResponses === 0 && b.totals?.unknownResponses === 0
      ? numericDelta(a.totals?.tokens, b.totals?.tokens) : null,
    cachedPromptTokensDelta: a.totals?.cacheUsageUnknown === 0 && b.totals?.cacheUsageUnknown === 0
      ? numericDelta(a.totals?.cachedPromptTokens, b.totals?.cachedPromptTokens) : null,
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
    factor: factorA,
    experimentId: experimentIdA,
    evalHarnessSha256: a.evalHarnessSha256 ?? null,
    a: {
      runId: a.runId ?? null,
      commit: a.commit ?? "unknown", branch: a.branch ?? "unknown",
      workingTreeClean: a.workingTreeClean ?? null, passed: aPassed, total: aTotal,
    },
    b: {
      runId: b.runId ?? null,
      commit: b.commit ?? "unknown", branch: b.branch ?? "unknown",
      workingTreeClean: b.workingTreeClean ?? null, passed: bPassed, total: bTotal,
    },
    totals,
    warnings: [...new Set(warnings)],
    tasks,
  };
}

export function summarizeExperiment(comparisons) {
  if (!Array.isArray(comparisons) || comparisons.length === 0) {
    throw new Error("at least one paired comparison is required");
  }
  const factors = new Set(comparisons.map((item) => item.factor ?? "unspecified"));
  if (factors.size > 1) throw new Error("cannot summarize comparisons from different experiment factors");
  const experimentIds = new Set(comparisons.map((item) => item.experimentId ?? null));
  if (experimentIds.size > 1) throw new Error("cannot summarize comparisons from different experiment IDs");
  const valid = comparisons.filter((item) => item.comparable);
  // A/B 轮次的 "可用于决策" 不能只数数组长度：重复放入同一轮结果绝不能冒充三次独立评测。
  const usedRunIds = new Set();
  let distinctRunRounds = 0;
  let duplicateRunRounds = 0;
  let missingRunIdRounds = 0;
  for (const comparison of valid) {
    const aId = comparison.a?.runId;
    const bId = comparison.b?.runId;
    if (typeof aId !== "string" || aId.length === 0 ||
        typeof bId !== "string" || bId.length === 0) {
      missingRunIdRounds++;
      continue;
    }
    if (aId === bId || usedRunIds.has(aId) || usedRunIds.has(bId)) {
      duplicateRunRounds++;
      continue;
    }
    usedRunIds.add(aId);
    usedRunIds.add(bId);
    distinctRunRounds++;
  }
  const allTasks = valid.flatMap((item) => item.tasks);
  const deltaMedian = (key) => {
    const values = valid.map((item) => item.totals[key]).filter((value) => typeof value === "number");
    return values.length === 0 ? null : median(values);
  };
  return {
    rounds: comparisons.length,
    factor: valid[0]?.factor ?? comparisons[0]?.factor ?? "unspecified",
    comparableRounds: valid.length,
    invalidRounds: comparisons.length - valid.length,
    distinctRunRounds,
    duplicateRunRounds,
    missingRunIdRounds,
    // 至少三轮相同口径、独立运行的 A/B 配对，才能标记为可用于决策。
    decisionReady: valid.length >= 3 && valid.length === comparisons.length &&
      distinctRunRounds === comparisons.length,
    improvedTasks: allTasks.filter((item) => item.status === "improved").length,
    regressedTasks: allTasks.filter((item) => item.status === "regressed").length,
    unchangedTasks: allTasks.filter((item) => item.status === "same").length,
    medianPassRateDeltaPoints: deltaMedian("passRateDeltaPoints"),
    medianRequestsDelta: deltaMedian("requestsDelta"),
    medianSummaryRequestsDelta: deltaMedian("summaryRequestsDelta"),
    medianToolCallsDelta: deltaMedian("toolCallsDelta"),
    medianPromptTokensDelta: deltaMedian("promptTokensDelta"),
    medianCompletionTokensDelta: deltaMedian("completionTokensDelta"),
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
    "| Experiment factor | " + (summary.factor ?? "unspecified") + " |",
    "| Paired rounds | " + summary.rounds + " |",
    "| Comparable rounds | " + summary.comparableRounds + " |",
    "| Invalid rounds | " + summary.invalidRounds + " |",
    "| Distinct paired runs | " + summary.distinctRunRounds + " |",
    "| Duplicate/reused runs | " + summary.duplicateRunRounds + " |",
    "| Runs missing IDs | " + summary.missingRunIdRounds + " |",
    "| Improved task-rounds | " + summary.improvedTasks + " |",
    "| Regressed task-rounds | " + summary.regressedTasks + " |",
    "| Unchanged task-rounds | " + summary.unchangedTasks + " |",
    "| Decision readiness | " + (summary.decisionReady ? "ready (>=3 independent valid paired rounds)" : "exploratory only; need 3 independent valid paired rounds") + " |",
    "| Median pass-rate delta | " + show(summary.medianPassRateDeltaPoints, " pp") + " |",
    "| Median business request delta | " + show(summary.medianRequestsDelta) + " |",
    "| Median summary request delta | " + show(summary.medianSummaryRequestsDelta) + " |",
    "| Median tool-call delta | " + show(summary.medianToolCallsDelta) + " |",
    "| Median input-token delta | " + show(summary.medianPromptTokensDelta) + " |",
    "| Median output-token delta | " + show(summary.medianCompletionTokensDelta) + " |",
    "| Median total-token delta | " + show(summary.medianTokensDelta) + " |",
    "| Median cached input token delta | " + show(summary.medianCachedPromptTokensDelta) + " |",
    "| Median elapsed delta | " + show(summary.medianElapsedDelta, " s") + " |",
    "| Median cost delta | " + show(summary.medianCostDelta, summary.costCurrency ? " " + summary.costCurrency : "") + " |",
    "",
    "## Per-round validity",
    "",
  ];
  for (const [index, item] of comparisons.entries()) {
    lines.push("### Round " + (index + 1) + ": " + (item.comparable ? "comparable" : "invalid"));
    lines.push("- A: " + item.a.branch + " @ " + item.a.commit + " · clean worktree: " + String(item.a.workingTreeClean));
    lines.push("- B: " + item.b.branch + " @ " + item.b.commit + " · clean worktree: " + String(item.b.workingTreeClean));
    if (item.issues.length > 0) for (const issue of item.issues) lines.push("- Invalid: " + issue);
    if (item.warnings.length > 0) for (const warning of item.warnings) lines.push("- Warning: " + warning);
    if (item.tasks.length > 0) {
      lines.push("", "| Task | Status | Input Δ | Output Δ | Total Δ | Request Δ | Tool Δ | Time Δ (s) | Cost Δ |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const task of item.tasks) {
        lines.push("| " + task.name + " | " + task.status + " | " +
          show(task.promptTokensDelta) + " | " + show(task.completionTokensDelta) + " | " +
          show(task.tokensDelta) + " | " + show(task.requestsDelta) + " | " +
          show(task.toolCallsDelta) + " | " + show(task.secondsDelta) + " | " +
          show(task.costDelta, item.totals.costCurrency ? " " + item.totals.costCurrency : "") + " |");
      }
    }
    lines.push("");
  }
  lines.push("## Decision notes", "", "- Fewer than three independent comparable paired rounds, reused or missing run IDs, or any invalid round, is exploratory evidence only.",
    "- Do not adopt a change solely because tokens or time decreased.", "- Reject regressions in task success, safety, or required behavior.", "- Review quality scorecards and blocking findings before accepting a candidate.", "- Invalid rounds must be rerun; do not mix incompatible configurations.", "");
  return lines.join("\n");
}

function runtimeKey(environment) {
  if (!environment) return "legacy";
  return [
    environment.node, environment.platform, environment.arch, environment.osRelease, environment.timezone,
  ].join("|");
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

import assert from "node:assert/strict";
import test from "node:test";
import { compareRuns, summarizeExperiment, renderComparison } from "../eval/compare.mjs";
import { experimentOrder } from "../eval/ab.mjs";

function run(overrides = {}) {
  return {
    suiteVersion: "suite-v1",
    model: "mock",
    commit: "commit",
    branch: "branch",
    endpointHost: "api.example.test",
    jobs: 1,
    environment: { node: "v22", platform: "linux", arch: "x64", osRelease: "kernel" },
    taskNames: ["one", "two"],
    taskSuiteSha256: "task-suite-hash",
    pricingSha256: "pricing-hash",
    trace: false,
    keep: false,
    passed: 2,
    total: 2,
    elapsed: 10,
    totals: { requests: 8, summaryRequests: 1, toolCalls: 7, tokens: 100, cachedPromptTokens: 20, cost: { amountUsd: 0.01, complete: true } },
    infraErrors: [],
    results: [
      { name: "one", ok: true, requests: 4, toolCalls: 3, tokens: { total: 50 }, seconds: 5, settings: { maxSteps: 30 } },
      { name: "two", ok: true, requests: 4, toolCalls: 4, tokens: { total: 50 }, seconds: 5, settings: { maxSteps: 30 } },
    ],
    ...overrides,
  };
}

test("A/B 对比：按任务计算回归、提升和资源差值", () => {
  const a = run();
  const b = run({
    passed: 1,
    elapsed: 8,
    totals: { requests: 6, summaryRequests: 2, toolCalls: 5, tokens: 80, cachedPromptTokens: 30, cost: { amountUsd: 0.008, complete: true } },
    results: [
      { name: "one", ok: true, requests: 3, toolCalls: 2, tokens: { total: 40 }, seconds: 4, settings: { maxSteps: 30 } },
      { name: "two", ok: false, requests: 3, toolCalls: 3, tokens: { total: 40 }, seconds: 4, settings: { maxSteps: 30 } },
    ],
  });
  const result = compareRuns(a, b);
  assert.equal(result.comparable, true);
  assert.equal(result.tasks[1].status, "regressed");
  assert.equal(result.totals.passRateDeltaPoints, -50);
  assert.equal(result.totals.tokensDelta, -20);
  assert.equal(result.totals.costDeltaUsd, -0.002);
});

test("A/B 对比：模型、环境、任务配置不一致时拒绝给出有效比较", () => {
  const result = compareRuns(run(), run({
    model: "other",
    environment: { node: "v23", platform: "linux", arch: "x64" },
    results: [
      { name: "one", ok: true, requests: 1, toolCalls: 1, tokens: { total: 1 }, seconds: 1, settings: { maxSteps: 20 } },
      { name: "two", ok: true, requests: 1, toolCalls: 1, tokens: { total: 1 }, seconds: 1, settings: { maxSteps: 30 } },
    ],
  }));
  assert.equal(result.comparable, false);
  assert.ok(result.issues.some((issue) => issue.includes("model differs")));
  assert.ok(result.issues.some((issue) => issue.includes("runtime differs")));
  assert.ok(result.issues.some((issue) => issue.includes("task settings differ")));
});

test("A/B 汇总：只统计可比较轮次，并输出回归提醒", () => {
  const comparison = compareRuns(run(), run({
    results: [
      { name: "one", ok: true, requests: 3, toolCalls: 2, tokens: { total: 40 }, seconds: 4, settings: { maxSteps: 30 } },
      { name: "two", ok: false, requests: 3, toolCalls: 3, tokens: { total: 40 }, seconds: 4, settings: { maxSteps: 30 } },
    ],
    passed: 1,
  }));
  const summary = summarizeExperiment([comparison, { ...comparison, comparable: false }]);
  assert.equal(summary.comparableRounds, 1);
  assert.equal(summary.invalidRounds, 1);
  assert.equal(summary.regressedTasks, 1);
  assert.match(renderComparison([comparison], summary), /Regressed tasks/);
});

test("A/B 运行顺序：每轮交替，降低时间顺序偏差", () => {
  assert.deepEqual(experimentOrder(1), ["A", "B"]);
  assert.deepEqual(experimentOrder(2), ["B", "A"]);
  assert.deepEqual(experimentOrder(3), ["A", "B"]);
  assert.throws(() => experimentOrder(0), /positive integer/);
});

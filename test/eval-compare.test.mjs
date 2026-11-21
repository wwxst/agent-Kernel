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
    promptSha256: "prompt-hash",
    toolDefinitionsSha256: "tools-hash",
    runtimeSourceSha256: "runtime-hash",
    evalHarnessSha256: "eval-harness-hash",
    experiment: { factor: "unspecified" },
    passed: 2,
    total: 2,
    elapsed: 10,
    totals: {
      requests: 8, summaryRequests: 1, toolCalls: 7, promptTokens: 80, completionTokens: 20, tokens: 100,
      cachedPromptTokens: 20, unknownResponses: 0, cacheUsageUnknown: 0,
      cost: { amount: 0.01, currency: "USD", complete: true },
    },
    infraErrors: [],
    results: [
      { name: "one", ok: true, requests: 4, toolCalls: 3, tokens: { prompt: 40, completion: 10, total: 50, unknownResponses: 0, cacheUsageUnknown: 0, cachedPromptTokens: 10 }, seconds: 5, settings: { maxSteps: 30 } },
      { name: "two", ok: true, requests: 4, toolCalls: 4, tokens: { prompt: 40, completion: 10, total: 50, unknownResponses: 0, cacheUsageUnknown: 0, cachedPromptTokens: 10 }, seconds: 5, settings: { maxSteps: 30 } },
    ],
    ...overrides,
  };
}

test("A/B 对比：按任务计算回归、提升和资源差值", () => {
  const a = run();
  const b = run({
    passed: 1,
    elapsed: 8,
    totals: {
      requests: 6, summaryRequests: 2, toolCalls: 5, promptTokens: 64, completionTokens: 16, tokens: 80,
      cachedPromptTokens: 30, unknownResponses: 0, cacheUsageUnknown: 0,
      cost: { amount: 0.008, currency: "USD", complete: true },
    },
    results: [
      { name: "one", ok: true, requests: 3, toolCalls: 2, tokens: { prompt: 32, completion: 8, total: 40, unknownResponses: 0, cacheUsageUnknown: 0, cachedPromptTokens: 15 }, seconds: 4, settings: { maxSteps: 30 } },
      { name: "two", ok: false, requests: 3, toolCalls: 3, tokens: { prompt: 32, completion: 8, total: 40, unknownResponses: 0, cacheUsageUnknown: 0, cachedPromptTokens: 15 }, seconds: 4, settings: { maxSteps: 30 } },
    ],
  });
  const result = compareRuns(a, b);
  assert.equal(result.comparable, true);
  assert.equal(result.tasks[1].status, "regressed");
  assert.equal(result.totals.passRateDeltaPoints, -50);
  assert.equal(result.totals.promptTokensDelta, -16);
  assert.equal(result.totals.completionTokensDelta, -4);
  assert.equal(result.totals.tokensDelta, -20);
  assert.equal(result.totals.costDelta, -0.002);
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

test("A/B 对比：用量未知时不把 Token 下限伪装成精确差值", () => {
  const a = run();
  const b = run({
    totals: {
      requests: 8, summaryRequests: 1, toolCalls: 7, promptTokens: 80, completionTokens: 20, tokens: 100,
      cachedPromptTokens: 20, unknownResponses: 1, cacheUsageUnknown: 1,
      cost: { amount: 0.01, currency: "USD", complete: false },
    },
    results: [
      { name: "one", ok: true, requests: 4, toolCalls: 3, tokens: { total: 50, unknownResponses: 1, cacheUsageUnknown: 1 }, seconds: 5, settings: { maxSteps: 30 } },
      { name: "two", ok: true, requests: 4, toolCalls: 4, tokens: { total: 50, unknownResponses: 0, cacheUsageUnknown: 0 }, seconds: 5, settings: { maxSteps: 30 } },
    ],
  });
  const result = compareRuns(a, b);
  assert.equal(result.comparable, true);
  assert.equal(result.totals.promptTokensDelta, null);
  assert.equal(result.totals.completionTokensDelta, null);
  assert.equal(result.totals.tokensDelta, null);
  assert.equal(result.totals.cachedPromptTokensDelta, null);
  assert.ok(result.warnings.some((warning) => warning.includes("unknown usage")));
});

test("A/B 对比：价格币种不同不能计算费用差值", () => {
  const result = compareRuns(run(), run({
    totals: {
      requests: 8, summaryRequests: 1, toolCalls: 7, tokens: 100,
      cachedPromptTokens: 20, unknownResponses: 0, cacheUsageUnknown: 0,
      cost: { amount: 0.01, currency: "CNY", complete: true },
    },
  }));
  assert.equal(result.comparable, false);
  assert.ok(result.issues.includes("costCurrency differs"));
  assert.equal(result.totals.costDelta, null);
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
  assert.equal(summary.decisionReady, false);
  assert.match(renderComparison([comparison], summary), /Regressed task-rounds/);
  assert.match(renderComparison([comparison], summary), /exploratory only/);
  const reusedRound = summarizeExperiment([comparison, comparison, comparison]);
  assert.equal(reusedRound.decisionReady, false);
  assert.equal(reusedRound.missingRunIdRounds, 3);
});

test("A/B 汇总：同一轮不能重复冒充三轮独立证据", () => {
  const pair = (aId, bId) => compareRuns(
    run({ runId: aId, experiment: { id: "same-experiment", variant: "A", factor: "unspecified" } }),
    run({ runId: bId, experiment: { id: "same-experiment", variant: "B", factor: "unspecified" } }),
  );
  const first = pair("a-1", "b-1");
  const second = pair("a-2", "b-2");
  const third = pair("a-3", "b-3");

  const realRounds = summarizeExperiment([first, second, third]);
  assert.equal(realRounds.comparableRounds, 3);
  assert.equal(realRounds.distinctRunRounds, 3);
  assert.equal(realRounds.decisionReady, true);

  const repeated = summarizeExperiment([first, first, first]);
  assert.equal(repeated.comparableRounds, 3);
  assert.equal(repeated.distinctRunRounds, 1);
  assert.equal(repeated.duplicateRunRounds, 2);
  assert.equal(repeated.decisionReady, false);
  assert.match(renderComparison([first, first, first], repeated), /Duplicate\/reused runs/);

  const crossReuse = summarizeExperiment([first, pair("a-1", "b-2"), third]);
  assert.equal(crossReuse.duplicateRunRounds, 1);
  assert.equal(crossReuse.decisionReady, false);

  const missingId = summarizeExperiment([first, second, compareRuns(run(), run())]);
  assert.equal(missingId.missingRunIdRounds, 1);
  assert.equal(missingId.decisionReady, false);
});

test("A/B 对比：同一运行不能同时作为 A 和 B", () => {
  const result = compareRuns(run({ runId: "same-id" }), run({ runId: "same-id" }));
  assert.equal(result.comparable, false);
  assert.ok(result.issues.includes("A and B must be distinct run IDs"));
});

test("A/B 因素约束：测试 System Prompt 时只允许 Prompt 指纹变化", () => {
  const result = compareRuns(
    run({ experiment: { factor: "system-prompt" } }),
    run({ promptSha256: "new-prompt", experiment: { factor: "system-prompt" } }),
  );
  assert.equal(result.comparable, true);
  assert.equal(result.factor, "system-prompt");

  const accidentalToolChange = compareRuns(
    run({ experiment: { factor: "system-prompt" } }),
    run({ promptSha256: "new-prompt", toolDefinitionsSha256: "changed-tools", experiment: { factor: "system-prompt" } }),
  );
  assert.equal(accidentalToolChange.comparable, false);
  assert.ok(accidentalToolChange.issues.some((issue) => issue.includes("tool-definitions changed outside")));
});

test("A/B 因素约束：测试工具定义时只允许工具指纹变化", () => {
  const result = compareRuns(
    run({ experiment: { factor: "tool-definitions" } }),
    run({ toolDefinitionsSha256: "new-tools", runtimeSourceSha256: "new-runtime", experiment: { factor: "tool-definitions" } }),
  );
  assert.equal(result.comparable, true);
  const noChange = compareRuns(
    run({ experiment: { factor: "tool-definitions" } }),
    run({ experiment: { factor: "tool-definitions" } }),
  );
  assert.equal(noChange.comparable, false);
  assert.ok(noChange.issues.some((issue) => issue.includes("factor did not change")));
});

test("A/B 因素约束：运行时实验不能顺带改变 Prompt 或工具说明", () => {
  const result = compareRuns(run(), run({ promptSha256: "changed-prompt" }));
  assert.equal(result.comparable, false);
  assert.ok(result.issues.some((issue) => issue.includes("system-prompt changed outside")));

  const runtimeChanged = compareRuns(
    run({ experiment: { factor: "agent-runtime" } }),
    run({ runtimeSourceSha256: "new-runtime", experiment: { factor: "agent-runtime" } }),
  );
  assert.equal(runtimeChanged.comparable, true);
  const runtimeDidNotChange = compareRuns(
    run({ experiment: { factor: "agent-runtime" } }),
    run({ experiment: { factor: "agent-runtime" } }),
  );
  assert.equal(runtimeDidNotChange.comparable, false);
  assert.ok(runtimeDidNotChange.issues.some((issue) => issue.includes("agent-runtime factor did not change")));
});

test("A/B 对比：评测执行器不同或缺少指纹时拒绝比较", () => {
  const changed = compareRuns(run(), run({ evalHarnessSha256: "other-evaluator" }));
  assert.equal(changed.comparable, false);
  assert.ok(changed.issues.includes("evalHarnessSha256 differs"));
  const missing = run();
  delete missing.evalHarnessSha256;
  const absent = compareRuns(run(), missing);
  assert.equal(absent.comparable, false);
  assert.ok(absent.issues.includes("evaluation harness fingerprint missing"));
});

test("A/B 对比：不同实验 ID 或相同候选标签不能组成一对", () => {
  const a = run({ experiment: { id: "experiment-1", variant: "A", factor: "system-prompt" } });
  const differentId = run({
    promptSha256: "new-prompt",
    experiment: { id: "experiment-2", variant: "B", factor: "system-prompt" },
  });
  const different = compareRuns(a, differentId);
  assert.equal(different.comparable, false);
  assert.ok(different.issues.includes("experimentId differs"));

  const sameVariant = compareRuns(a, run({
    promptSha256: "new-prompt",
    experiment: { id: "experiment-1", variant: "A", factor: "system-prompt" },
  }));
  assert.equal(sameVariant.comparable, false);
  assert.ok(sameVariant.issues.includes("expected A baseline and B candidate variants"));
});

test("A/B 汇总：拒绝把不同实验因素的轮次混在一起", () => {
  const prompt = compareRuns(
    run({ experiment: { factor: "system-prompt" } }),
    run({ promptSha256: "new-prompt", experiment: { factor: "system-prompt" } }),
  );
  const runtime = compareRuns(
    run({ experiment: { factor: "agent-runtime" } }),
    run({ runtimeSourceSha256: "new-runtime", experiment: { factor: "agent-runtime" } }),
  );
  assert.throws(() => summarizeExperiment([prompt, runtime]), /different experiment factors/);
});

test("A/B 汇总：拒绝把不同实验 ID 的轮次混在一起", () => {
  const first = compareRuns(
    run({ experiment: { id: "experiment-1", variant: "A", factor: "system-prompt" } }),
    run({ promptSha256: "prompt-b", experiment: { id: "experiment-1", variant: "B", factor: "system-prompt" } }),
  );
  const second = compareRuns(
    run({ experiment: { id: "experiment-2", variant: "A", factor: "system-prompt" } }),
    run({ promptSha256: "prompt-c", experiment: { id: "experiment-2", variant: "B", factor: "system-prompt" } }),
  );
  assert.throws(() => summarizeExperiment([first, second]), /different experiment IDs/);
});

test("A/B 对比：时区不同不能视为相同运行环境", () => {
  const result = compareRuns(
    run(),
    run({ environment: { ...run().environment, timezone: "Asia/Tokyo" } }),
  );
  assert.equal(result.comparable, false);
  assert.ok(result.issues.includes("runtime differs"));
});

test("A/B 运行顺序：每轮交替，降低时间顺序偏差", () => {
  assert.deepEqual(experimentOrder(1), ["A", "B"]);
  assert.deepEqual(experimentOrder(2), ["B", "A"]);
  assert.deepEqual(experimentOrder(3), ["A", "B"]);
  assert.throws(() => experimentOrder(0), /positive integer/);
});

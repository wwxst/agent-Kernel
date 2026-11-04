/**
 * 跨天运行器里唯一值得单测的部分：把同日多轮折成可对比的摘要。
 * git worktree / spawn 那层需要真实端点，留给跨天运行器本身。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeDay } from "../eval/cross-day.mjs";

function round({ at, passed = 20, tokens = [20_000, 12_000, 5_000], elapsed = 75, failure } = {}) {
  const names = ["13-callback-to-promise", "20-fix-email-regex", "08-extract-duplication"];
  return {
    at,
    model: "hy3",
    passed,
    total: 20,
    totals: { requests: 100, toolCalls: 99, tokens: tokens.reduce((a, b) => a + b, 0) },
    elapsed,
    results: names.map((name, index) => ({
      name,
      ok: failure === undefined || index !== 0,
      failure: failure === undefined ? undefined : "task",
      tokens: { total: tokens[index] },
    })),
  };
}

test("跨天摘要：聚合通过量、中位数和逐任务波动", () => {
  const records = [
    round({ at: "2026-11-05T02:00:00.000Z", tokens: [20_000, 12_000, 5_000], elapsed: 70 }),
    round({ at: "2026-11-05T02:10:00.000Z", tokens: [40_000, 8_000, 10_000], elapsed: 90 }),
    round({ at: "2026-11-05T02:20:00.000Z", tokens: [10_000, 16_000, 5_000], elapsed: 80 }),
  ];

  const summary = summarizeDay({ date: "2026-11-05", ref: "stability-2026-11-04", commit: "abc1234", records });

  assert.equal(summary.rounds, 3);
  assert.deepEqual(summary.aggregate, { passed: 60, total: 60 });
  assert.equal(summary.medians.requests, 100);
  assert.equal(summary.medians.toolCalls, 99);
  assert.equal(summary.medians.tokens, 37_000);
  assert.equal(summary.medians.elapsed, 80);

  const task13 = summary.perTask.find((task) => task.name === "13-callback-to-promise");
  assert.deepEqual(task13.tokens, [20_000, 40_000, 10_000]);
  assert.equal(task13.min, 10_000);
  assert.equal(task13.max, 40_000);
  assert.equal(task13.spread, 4);
});

test("跨天摘要：失败任务与失败类型保留在逐轮记录里", () => {
  const records = [
    round({ at: "2026-11-06T02:00:00.000Z" }),
    round({ at: "2026-11-06T02:10:00.000Z", passed: 19, failure: "task" }),
  ];

  const summary = summarizeDay({ date: "2026-11-06", ref: "stability-2026-11-04", commit: "abc1234", records });

  assert.deepEqual(summary.aggregate, { passed: 39, total: 40 });
  assert.deepEqual(summary.perRound[1].failures, [
    { name: "13-callback-to-promise", failure: "task", error: undefined },
  ]);
  assert.deepEqual(summary.perTask[0].failures, ["13-callback-to-promise"]);
});

test("跨天摘要：没有轮次就抛错，不能生成空基线", () => {
  assert.throws(
    () => summarizeDay({ date: "2026-11-07", ref: "stability-2026-11-04", commit: "abc1234", records: [] }),
    /at least one round/,
  );
});

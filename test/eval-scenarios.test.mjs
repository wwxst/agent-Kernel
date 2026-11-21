import assert from "node:assert/strict";
import test from "node:test";
import { runScenarios } from "../eval/scenarios/run.mjs";

test("离线专项评测：压缩、串行工具和工具错误反馈全部符合预期", async () => {
  const results = await runScenarios();
  assert.equal(results.length, 3);
  assert.deepEqual(results.filter((item) => !item.ok), []);
  const compact = results.find((item) => item.name === "context-compaction");
  assert.ok(compact.compactions >= 1);
  assert.ok(compact.summaryRequests >= 1);
});

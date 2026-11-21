import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBlindReviewPack, summarizeScorecards } from "../eval/quality-review.mjs";

async function fixture(root, variant, content) {
  const tasks = path.join(root, variant, "tasks");
  const workdir = path.join(root, variant, "workdir");
  await mkdir(path.join(tasks, "task-1", "files"), { recursive: true });
  await mkdir(workdir, { recursive: true });
  await writeFile(path.join(tasks, "task-1", "task.md"), "Implement a safe parser.\n");
  await writeFile(path.join(tasks, "task-1", "files", "input.mjs"), "export const value = 1;\n");
  await writeFile(path.join(workdir, "input.mjs"), content);
  return { tasks, workdir };
}

test("盲审包：隐藏 A/B 映射，保留共同任务和初始夹具", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-blind-review-"));
  try {
    const a = await fixture(root, "a", "export const value = 2;\n");
    const b = await fixture(root, "b", "export const value = 3;\n");
    const result = await createBlindReviewPack({
      aRun: { suiteVersion: "suite", model: "mock", commit: "a-commit", branch: "a-branch",
        results: [{ name: "task-1", ok: true, requests: 2, toolCalls: 1, tokens: { total: 20 }, seconds: 1, workdir: a.workdir }] },
      bRun: { suiteVersion: "suite", model: "mock", commit: "b-commit", branch: "b-branch",
        results: [{ name: "task-1", ok: true, requests: 3, toolCalls: 2, tokens: { total: 30 }, seconds: 2, workdir: b.workdir }] },
      taskName: "task-1", aTasksDir: a.tasks, bTasksDir: b.tasks,
      outputDir: path.join(root, "review-pack"),
    });
    const review = await readFile(path.join(result.outputDir, "REVIEW.md"), "utf8");
    assert.match(review, /candidate-1/);
    assert.doesNotMatch(review, /a-commit|b-commit|a-branch|b-branch/);
    assert.equal(await readFile(path.join(result.outputDir, "initial", "input.mjs"), "utf8"), "export const value = 1;\n");
    const first = await readFile(path.join(result.outputDir, "candidate-1", "input.mjs"), "utf8");
    const second = await readFile(path.join(result.outputDir, "candidate-2", "input.mjs"), "utf8");
    assert.notEqual(first, second);
    const key = JSON.parse(await readFile(result.answerKeyPath, "utf8"));
    assert.deepEqual(new Set([key.candidate1.commit, key.candidate2.commit]), new Set(["a-commit", "b-commit"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("盲审包：初始夹具不一致时拒绝比较", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-blind-review-"));
  try {
    const a = await fixture(root, "a", "A");
    const b = await fixture(root, "b", "B");
    await writeFile(path.join(b.tasks, "task-1", "files", "input.mjs"), "different");
    const makeRun = (workdir) => ({ suiteVersion: "suite", model: "mock", results: [{ name: "task-1", workdir }] });
    await assert.rejects(() => createBlindReviewPack({
      aRun: makeRun(a.workdir), bRun: makeRun(b.workdir), taskName: "task-1",
      aTasksDir: a.tasks, bTasksDir: b.tasks, outputDir: path.join(root, "review"),
    }), /initial task fixtures differ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("盲审评分：计算维度均分，并识别需要第三方裁决的分歧", () => {
  const card = (reviewerId, score, recommendation = "accept") => ({
    task: "task-1", candidate: "candidate-1", reviewerId,
    scores: { correctness: score, completeness: score, stabilitySecurity: score, maintainability: score, scope: score },
    evidence: {
      correctness: "src/file.mjs: behavior is correct",
      completeness: "all requested outputs exist",
      stabilitySecurity: "edge case test passes",
      maintainability: "small and clear implementation",
      scope: "only required files changed",
    },
    blockingFindings: [], recommendation,
  });
  const result = summarizeScorecards([card("reviewer-1", 4), card("reviewer-2", 2, "needs-discussion")]);
  assert.equal(result.groups[0].overallAverage, 3);
  assert.deepEqual(result.groups[0].disagreements, ["correctness", "completeness", "stabilitySecurity", "maintainability", "scope"]);
  assert.equal(result.groups[0].recommendationDisagreement, true);
  assert.equal(result.requiresAdjudication, true);
});

test("盲审评分：拒绝没有证据的分数", () => {
  const card = {
    task: "task-1", candidate: "candidate-1", reviewerId: "r1",
    scores: { correctness: 4, completeness: 4, stabilitySecurity: 4, maintainability: 4, scope: 4 },
    evidence: { correctness: "", completeness: "ok", stabilitySecurity: "ok", maintainability: "ok", scope: "ok" },
    blockingFindings: [], recommendation: "accept",
  };
  assert.throws(() => summarizeScorecards([card]), /missing evidence for correctness/);
});

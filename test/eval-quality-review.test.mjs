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
        evalHarnessSha256: "same-evaluator",
        results: [{ name: "task-1", ok: true, requests: 2, toolCalls: 1, tokens: { total: 20 }, seconds: 1, workdir: a.workdir }] },
      bRun: { suiteVersion: "suite", model: "mock", commit: "b-commit", branch: "b-branch",
        evalHarnessSha256: "same-evaluator",
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

test("盲审包：拒绝把本机环境文件和疑似密钥打包给审查者", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-blind-review-"));
  try {
    const a = await fixture(root, "a", "export const value = 2;\\n");
    const b = await fixture(root, "b", "export const value = 3;\\n");
    const makeRun = (workdir, commit) => ({
      suiteVersion: "suite", model: "mock", commit, branch: commit,
      evalHarnessSha256: "same-evaluator",
      results: [{ name: "task-1", ok: true, requests: 1, toolCalls: 0, tokens: { total: 1 }, seconds: 1, workdir }],
    });
    await writeFile(path.join(a.workdir, ".env.local"), "API_KEY=do-not-copy-this-value\\n");
    await assert.rejects(() => createBlindReviewPack({
      aRun: makeRun(a.workdir, "a"), bRun: makeRun(b.workdir, "b"),
      taskName: "task-1", aTasksDir: a.tasks, bTasksDir: b.tasks,
      outputDir: path.join(root, "review-env"),
    }), /sensitive file path/);
    await rm(path.join(a.workdir, ".env.local"));
    await writeFile(path.join(b.workdir, "input.mjs"), 'export const apiKey = "sk-proj-0123456789abcdefghijklmnopqrstuv";\\n');
    await assert.rejects(() => createBlindReviewPack({
      aRun: makeRun(a.workdir, "a"), bRun: makeRun(b.workdir, "b"),
      taskName: "task-1", aTasksDir: a.tasks, bTasksDir: b.tasks,
      outputDir: path.join(root, "review-token"),
    }), /possible openai-style-api-key/);
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
    const makeRun = (workdir) => ({
      suiteVersion: "suite", model: "mock", evalHarnessSha256: "same-evaluator",
      results: [{ name: "task-1", workdir }],
    });
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
  assert.equal(result.groups[0].insufficientReviewers, false);
  assert.deepEqual(result.pairs[0].missingCandidates, ["candidate-2"]);
  assert.equal(result.requiresAdjudication, true);
});

test("盲审评分：单人评分和缺失候选不能算完成的盲审", () => {
  const card = {
    task: "task-1", candidate: "candidate-1", reviewerId: "reviewer-1",
    scores: { correctness: 3, completeness: 3, stabilitySecurity: 3, maintainability: 3, scope: 3 },
    evidence: {
      correctness: "src/file.mjs: behavior matches the task",
      completeness: "all requested outputs exist",
      stabilitySecurity: "edge case is covered",
      maintainability: "implementation is easy to follow",
      scope: "only required files changed",
    },
    blockingFindings: [], recommendation: "accept",
  };
  const result = summarizeScorecards([card]);
  assert.equal(result.groups[0].reviewers, 1);
  assert.equal(result.groups[0].insufficientReviewers, true);
  assert.deepEqual(result.pairs[0].missingCandidates, ["candidate-2"]);
  assert.equal(result.requiresAdjudication, true);
});

test("盲审评分：同一审查者不能冒充两名独立审查者", () => {
  const card = {
    task: "task-1", candidate: "candidate-1", reviewerId: "same-reviewer",
    scores: { correctness: 3, completeness: 3, stabilitySecurity: 3, maintainability: 3, scope: 3 },
    evidence: {
      correctness: "src/file.mjs: behavior matches the task",
      completeness: "all requested outputs exist",
      stabilitySecurity: "edge case is covered",
      maintainability: "implementation is easy to follow",
      scope: "only required files changed",
    },
    blockingFindings: [], recommendation: "accept",
  };
  assert.throws(() => summarizeScorecards([card, { ...card }]), /duplicate independent reviewer/);
});

test("盲审评分：同一任务的两个候选必须使用同一组审查者", () => {
  const card = (candidate, reviewerId) => ({
    task: "task-1", candidate, reviewerId,
    scores: { correctness: 3, completeness: 3, stabilitySecurity: 3, maintainability: 3, scope: 3 },
    evidence: {
      correctness: "src/file.mjs: behavior matches the task",
      completeness: "all requested outputs exist",
      stabilitySecurity: "edge case is covered",
      maintainability: "implementation is easy to follow",
      scope: "only required files changed",
    },
    blockingFindings: [], recommendation: "accept",
  });
  const matched = summarizeScorecards([
    card("candidate-1", "reviewer-1"), card("candidate-1", "reviewer-2"),
    card("candidate-2", "reviewer-1"), card("candidate-2", "reviewer-2"),
  ]);
  assert.equal(matched.pairs[0].complete, true);
  assert.equal(matched.pairs[0].reviewerPanelMismatch, false);
  assert.equal(matched.requiresAdjudication, false);

  const mismatched = summarizeScorecards([
    card("candidate-1", "reviewer-1"), card("candidate-1", "reviewer-2"),
    card("candidate-2", "reviewer-1"), card("candidate-2", "reviewer-3"),
  ]);
  assert.equal(mismatched.pairs[0].reviewerPanelMismatch, true);
  assert.equal(mismatched.pairs[0].complete, false);
  assert.equal(mismatched.requiresAdjudication, true);
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

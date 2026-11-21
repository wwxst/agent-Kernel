#!/usr/bin/env node
/**
 * 生成匿名代码审查包，并汇总独立审查者的评分。
 * 审查包只包含任务、初始夹具、匿名候选工作区和评分规范；版本映射单独写入 answer-key。
 */
import { randomInt } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rubricPath = path.join(here, "quality-review", "rubric.md");
const templatePath = path.join(here, "quality-review", "scorecard.template.json");
const criteria = ["correctness", "completeness", "stabilitySecurity", "maintainability", "scope"];
const MAX_FILES = 2_000;
const MAX_BYTES = 20_000_000;

export async function createBlindReviewPack({ aRun, bRun, taskName, aTasksDir, bTasksDir, outputDir }) {
  if (!taskName || !outputDir) throw new Error("taskName and outputDir are required");
  if (aRun.suiteVersion !== bRun.suiteVersion) throw new Error("cannot blind-review runs from different task suite versions");
  if (aRun.model !== bRun.model) throw new Error("cannot blind-review runs using different models");
  const aTask = aRun.results?.find((item) => item.name === taskName);
  const bTask = bRun.results?.find((item) => item.name === taskName);
  if (!aTask || !bTask) throw new Error("task " + taskName + " must exist in both run records");
  if (typeof aTask.workdir !== "string" || typeof bTask.workdir !== "string") {
    throw new Error("both runs must preserve task workspaces with --keep");
  }

  const aTaskDir = path.join(aTasksDir, taskName);
  const bTaskDir = path.join(bTasksDir, taskName);
  const [aPrompt, bPrompt] = await Promise.all([
    readFile(path.join(aTaskDir, "task.md"), "utf8"),
    readFile(path.join(bTaskDir, "task.md"), "utf8"),
  ]);
  if (aPrompt !== bPrompt) throw new Error("task prompts differ; these results are not a valid blind pair");

  const [initialA, initialB, candidateA, candidateB] = await Promise.all([
    readTree(path.join(aTaskDir, "files")),
    readTree(path.join(bTaskDir, "files")),
    readTree(aTask.workdir),
    readTree(bTask.workdir),
  ]);
  if (!sameTree(initialA, initialB)) throw new Error("initial task fixtures differ between variants");

  const destination = path.resolve(outputDir);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await mkdir(destination);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("review output directory already exists; choose a new path");
    throw error;
  }

  const aIsFirst = randomInt(2) === 0;
  const first = aIsFirst ? candidateA : candidateB;
  const second = aIsFirst ? candidateB : candidateA;
  const answerKey = {
    task: taskName,
    candidate1: aIsFirst ? identifyRun(aRun, aTask) : identifyRun(bRun, bTask),
    candidate2: aIsFirst ? identifyRun(bRun, bTask) : identifyRun(aRun, aTask),
  };

  try {
    await writeFile(path.join(destination, "task.md"), aPrompt, "utf8");
    await writeTree(path.join(destination, "initial"), initialA);
    await writeTree(path.join(destination, "candidate-1"), first);
    await writeTree(path.join(destination, "candidate-2"), second);
    await writeFile(path.join(destination, "rubric.md"), await readFile(rubricPath, "utf8"), "utf8");
    await writeFile(path.join(destination, "scorecard.template.json"), await readFile(templatePath, "utf8"), "utf8");
    await writeFile(path.join(destination, "REVIEW.md"), [
      "# Blind review",
      "",
      "只根据任务要求、初始文件和两个匿名候选的最终文件评分。",
      "不要猜测候选来自哪个模型、分支或提交；不要查看 answer-key。",
      "两名审查者必须独立完成评分，评分后再比较。",
      "每个维度都要写具体证据；阻断问题单独列出。",
      "评分标准见 rubric.md，填写 scorecard.template.json 后另存为独立 JSON。",
      "",
      "## 文件",
      "- task.md：共同任务要求",
      "- initial/：共同初始工作区",
      "- candidate-1/ 与 candidate-2/：匿名最终工作区",
      "- rubric.md：评分规则",
      "- scorecard.template.json：评分模板",
      "",
    ].join("\n"), "utf8");
    await writeFile(destination + ".answer-key.json", JSON.stringify(answerKey, null, 2), "utf8");
  } catch (error) {
    throw new Error("could not create blind review pack: " + (error instanceof Error ? error.message : String(error)));
  }

  return { outputDir: destination, answerKeyPath: destination + ".answer-key.json", task: taskName };
}

export function summarizeScorecards(scorecards) {
  if (!Array.isArray(scorecards) || scorecards.length === 0) throw new Error("at least one scorecard is required");
  for (const [index, card] of scorecards.entries()) validateScorecard(card, index);
  const averages = Object.fromEntries(criteria.map((key) => [
    key,
    Number((scorecards.reduce((sum, card) => sum + card.scores[key], 0) / scorecards.length).toFixed(2)),
  ]));
  const disagreements = criteria.filter((key) => {
    const values = scorecards.map((card) => card.scores[key]);
    return Math.max(...values) - Math.min(...values) >= 2;
  });
  const recommendations = [...new Set(scorecards.map((card) => card.recommendation))];
  const blockingFindings = scorecards.flatMap((card) => card.blockingFindings.map((finding) => ({
    candidate: card.candidate, reviewerId: card.reviewerId, finding,
  })));
  return {
    reviewers: scorecards.length,
    averages,
    overallAverage: Number((Object.values(averages).reduce((sum, value) => sum + value, 0) / criteria.length).toFixed(2)),
    disagreements,
    recommendationDisagreement: recommendations.length > 1,
    recommendations,
    blockingFindings,
    requiresAdjudication: disagreements.length > 0 || recommendations.length > 1 || blockingFindings.length > 0,
  };
}

function validateScorecard(card, index) {
  if (card === null || typeof card !== "object" || Array.isArray(card)) throw new Error("scorecard " + (index + 1) + " must be an object");
  if (typeof card.task !== "string" || card.task === "" ||
      !["candidate-1", "candidate-2"].includes(card.candidate) ||
      typeof card.reviewerId !== "string" || card.reviewerId === "") {
    throw new Error("scorecard " + (index + 1) + " has invalid task, candidate, or reviewerId");
  }
  if (card.scores === null || typeof card.scores !== "object" ||
      card.evidence === null || typeof card.evidence !== "object") {
    throw new Error("scorecard " + (index + 1) + " must include scores and evidence");
  }
  for (const key of criteria) {
    const score = card.scores[key];
    if (!Number.isInteger(score) || score < 0 || score > 4) throw new Error("scorecard " + (index + 1) + " has invalid score for " + key);
    if (typeof card.evidence[key] !== "string" || card.evidence[key].trim() === "") {
      throw new Error("scorecard " + (index + 1) + " is missing evidence for " + key);
    }
  }
  if (!Array.isArray(card.blockingFindings) ||
      !["accept", "reject", "needs-discussion"].includes(card.recommendation)) {
    throw new Error("scorecard " + (index + 1) + " has invalid findings or recommendation");
  }
}

async function readTree(root) {
  const files = new Map();
  let totalBytes = 0;
  async function walk(directory, relative = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative === "" ? entry.name : path.join(relative, entry.name);
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("refusing symlink in review source: " + name);
      if (entry.isDirectory()) await walk(full, name);
      else if (entry.isFile()) {
        const info = await stat(full);
        totalBytes += info.size;
        if (files.size >= MAX_FILES || totalBytes > MAX_BYTES) throw new Error("review source exceeds file or size safety limit");
        files.set(name.split(path.sep).join("/"), await readFile(full));
      } else throw new Error("unsupported file type in review source: " + name);
    }
  }
  await walk(root);
  return files;
}

function sameTree(left, right) {
  if (left.size !== right.size) return false;
  for (const [name, content] of left) {
    const other = right.get(name);
    if (other === undefined || !content.equals(other)) return false;
  }
  return true;
}

async function writeTree(root, files) {
  await mkdir(root, { recursive: true });
  for (const [name, content] of files) {
    const target = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function identifyRun(run, task) {
  return {
    commit: run.commit ?? "unknown",
    model: run.model ?? "unknown",
    branch: run.branch ?? "unknown",
    ok: task.ok,
    requests: task.requests,
    toolCalls: task.toolCalls,
    totalTokens: task.tokens?.total ?? null,
    seconds: task.seconds,
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith("--")) throw new Error("unexpected argument: " + key);
    options[key.slice(2)] = args[++index];
  }
  if (options.scores) {
    const scorecards = JSON.parse(await readFile(path.resolve(options.scores), "utf8"));
    console.log(JSON.stringify(summarizeScorecards(scorecards), null, 2));
    return;
  }
  for (const key of ["a", "b", "task", "a-tasks-dir", "b-tasks-dir", "out"]) {
    if (!options[key]) throw new Error("missing --" + key);
  }
  const [aRun, bRun] = await Promise.all([
    readFile(path.resolve(options.a), "utf8").then(JSON.parse),
    readFile(path.resolve(options.b), "utf8").then(JSON.parse),
  ]);
  const result = await createBlindReviewPack({
    aRun, bRun, taskName: options.task,
    aTasksDir: path.resolve(options["a-tasks-dir"]),
    bTasksDir: path.resolve(options["b-tasks-dir"]),
    outputDir: options.out,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await cli();

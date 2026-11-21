import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const evalFiles = ["ab.mjs", "compare.mjs", "run.mjs", "selfcheck.mjs", "diagnostics.mjs", "cost.mjs"];

async function createVariant(root) {
  await cp(path.join(projectRoot, "src"), path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "eval", "tasks", "noop", "files"), { recursive: true });
  await writeFile(path.join(root, "eval", "tasks", "noop", "task.md"), "Finish this no-op task.\n");
  await writeFile(path.join(root, "eval", "tasks", "noop", "check.mjs"), "export default async function check() {}\n");
  for (const file of evalFiles) {
    await copyFile(path.join(projectRoot, "eval", file), path.join(root, "eval", file));
  }
}

test("A/B 实验：两轮交替运行，分别保存记录并生成可比较报告", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-ab-test-"));
  let requestCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestCount++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      }));
    });
  });

  try {
    const aDir = path.join(root, "A");
    const bDir = path.join(root, "B");
    await Promise.all([mkdir(aDir), mkdir(bDir)]);
    await Promise.all([createVariant(aDir), createVariant(bDir)]);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const child = spawn(process.execPath, [
      path.join(projectRoot, "eval", "ab.mjs"),
      "--a-dir", aDir,
      "--b-dir", bDir,
      "--rounds", "2",
      "--jobs", "1",
      "--task", "noop",
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        API_KEY: "test-key",
        OPENAI_API_KEY: "",
        BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
        MODEL: "mock-model",
        EVAL_PRICING_FILE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    assert.equal(exitCode, 0, stdout + stderr);
    assert.equal(requestCount, 4, "2 rounds × 2 variants should produce four model requests");
    const experiments = path.join(aDir, "eval", "results", "experiments");
    const [experimentId] = await readdir(experiments);
    const experimentDir = path.join(experiments, experimentId);
    const record = JSON.parse(await readFile(path.join(experimentDir, "experiment.json"), "utf8"));
    assert.equal(record.summary.rounds, 2);
    assert.equal(record.summary.comparableRounds, 2);
    assert.equal(record.summary.invalidRounds, 0);
    assert.equal(record.summary.factor, "agent-runtime");
    assert.equal(record.runFiles.length, 4);
    for (const comparison of record.comparisons) assert.equal(comparison.comparable, true);
    const report = await readFile(path.join(experimentDir, "report.md"), "utf8");
    assert.match(report, /Per-round validity/);
    assert.match(report, /noop/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

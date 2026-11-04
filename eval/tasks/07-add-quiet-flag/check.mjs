import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function check(root) {
  const script = path.join(root, "cli.mjs");

  const quiet = await run(process.execPath, [script, "--quiet"], { cwd: root });
  assert.equal(quiet.stdout.trim(), "done", "--quiet 时只应该输出 done");

  const loud = await run(process.execPath, [script], { cwd: root });
  assert.match(loud.stdout, /starting/, "不带 --quiet 时应该还有 starting");
  assert.match(loud.stdout, /done/, "不带 --quiet 时应该还有 done");
}

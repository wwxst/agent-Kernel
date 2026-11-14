import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function check(root) {
  const script = path.join(root, "cli.mjs");

  for (const args of [["--quiet"], ["alpha", "--quiet", "beta"], ["alpha", "beta", "--quiet"]]) {
    const quiet = await run(process.execPath, [script, ...args], { cwd: root });
    assert.equal(quiet.stdout.trim(), "done", `--quiet 必须在任意参数位置生效：${args.join(" ")}`);
  }

  const loud = await run(process.execPath, [script, "alpha", "beta"], { cwd: root });
  assert.match(loud.stdout, /starting/, "不带 --quiet 时应该还有 starting");
  assert.match(loud.stdout, /arg: alpha/, "不带 --quiet 时应该输出第一个参数");
  assert.match(loud.stdout, /arg: beta/, "不带 --quiet 时应该输出第二个参数");
  assert.match(loud.stdout, /done/, "不带 --quiet 时应该还有 done");
}

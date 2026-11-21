import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export default async function check(root, context = {}) {
  const taskDir = path.dirname(fileURLToPath(import.meta.url));
  const testsPath = path.join(root, "test", "format.test.mjs");
  const tests = await readFile(testsPath, "utf8");
  const originalTests = (await readFile(path.join(taskDir, "files", "test", "format.test.mjs"), "utf8")).trim();
  assert.ok(tests.includes(originalTests), "original formatting test must remain unchanged");
  assert.match(tests, /trims surrounding whitespace/, "whitespace test must be added");
  assert.match(tests, /rejects missing fields/, "missing-field test must be added");
  assert.match(tests, /rejects an invalid email/, "invalid-email test must be added");

  const moduleUrl = pathToFileURL(path.join(root, "src", "format.mjs")).href;
  const { formatUser } = await import(moduleUrl + "?check=" + Date.now());
  assert.equal(formatUser({ name: "  Ada Lovelace ", email: " ada@example.com " }), "Ada Lovelace <ada@example.com>");
  assert.throws(() => formatUser({ name: " ", email: "a@b" }), /name and email are required/);
  assert.throws(() => formatUser({ name: "Ada", email: " " }), /name and email are required/);
  assert.throws(() => formatUser({ name: 42, email: "ada@example.com" }), /name and email are required/);
  assert.throws(() => formatUser({ name: "Ada", email: 42 }), /name and email are required/);
  assert.throws(() => formatUser({ name: "Ada", email: "invalid" }), /email must contain @/);

  const result = spawnSync(process.execPath, ["--test", testsPath], {
    cwd: root, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const names = new Set(context.toolCallNames ?? []);
  assert.ok(names.has("read"), "the task must inspect source files with the read tool");
  assert.ok(names.has("shell"), "the task must run the requested test command with the shell tool");
  assert.ok(names.has("write") || names.has("edit"), "the task must modify files with write or edit");
  assert.ok(names.size >= 3, "the task must exercise at least three distinct tools");
}

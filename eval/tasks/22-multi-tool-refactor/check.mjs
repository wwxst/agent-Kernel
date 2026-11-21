import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const source = await readFile(path.join(root, "src", "format.mjs"), "utf8");
  const tests = await readFile(path.join(root, "test", "format.test.mjs"), "utf8");
  assert.match(tests, /formats a user/, "original formatting test must remain");
  assert.match(tests, /trims surrounding whitespace/, "whitespace test must be added");
  assert.match(tests, /rejects missing fields/, "missing-field test must be added");
  assert.match(tests, /rejects an invalid email/, "invalid-email test must be added");

  const moduleUrl = pathToFileURL(path.join(root, "src", "format.mjs")).href;
  const { formatUser } = await import(moduleUrl + "?check=" + Date.now());
  assert.equal(formatUser({ name: "  Ada Lovelace ", email: " ada@example.com " }), "Ada Lovelace <ada@example.com>");
  assert.throws(() => formatUser({ name: " ", email: "a@b" }), /name and email are required/);
  assert.throws(() => formatUser({ name: "Ada", email: " " }), /name and email are required/);
  assert.throws(() => formatUser({ name: "Ada", email: "invalid" }), /email must contain @/);

  const result = spawnSync(process.execPath, ["--test", path.join(root, "test", "format.test.mjs")], {
    cwd: root, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

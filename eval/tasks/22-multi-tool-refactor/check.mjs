import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// 夹具在 Windows 检出时是 CRLF，Linux CI 和模型写出的文件通常是 LF；
// 统一换行符后再比较，否则同一份内容会因平台不同被误判成「原测试被改动」。
const normalize = (text) => text.replace(/\r\n/g, "\n");

export default async function check(root, context = {}) {
  const taskDir = path.dirname(fileURLToPath(import.meta.url));
  const testsPath = path.join(root, "test", "format.test.mjs");
  const tests = normalize(await readFile(testsPath, "utf8")).trim();
  const originalTests = normalize(
    await readFile(path.join(taskDir, "files", "test", "format.test.mjs"), "utf8"),
  ).trim();
  assert.ok(tests.includes(originalTests), "original formatting test must remain unchanged");

  // 只要求原测试之外至少再有三条新增测试；标题措辞不限，但三种意图必须各出现一次。
  const countTests = (text) => (text.match(/\btest\s*\(/g) ?? []).length;
  assert.ok(
    countTests(tests) >= countTests(originalTests) + 3,
    "at least three additional tests must be added",
  );
  assert.match(tests, /trim|whitespace|空格|首尾/i, "a whitespace/trim test must be added");
  assert.match(tests, /missing|required|缺失|必填|not a string|non-string/i, "a missing-field test must be added");
  // @ 与 invalid/without/missing 等词必须同行，避免用原测试里的邮箱地址凑成「无效邮箱测试」；
  // 标题直接写 invalid email / 无效邮箱时也接受，因为断言里的 @ 可能出现在下一行。
  const invalidEmail = /(?:invalid|without|missing|不含|缺少)[^\n]*@|@[^\n]*(?:invalid|without|missing|不含|缺少)/i.test(tests)
    || /invalid[^\n]*(?:e-?mail|邮箱)|(?:e-?mail|邮箱)[^\n]*invalid|无效[^\n]*邮箱|邮箱[^\n]*无效/i.test(tests);
  assert.ok(invalidEmail, "an invalid-email test must be added");

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

  const names = new Set(context.successfulToolCallNames ?? []);
  assert.ok(names.has("read"), "the task must successfully inspect source files with the read tool");
  assert.ok(names.has("shell"), "the task must successfully run the requested test command with the shell tool");
  assert.ok(names.has("write") || names.has("edit"), "the task must successfully modify files with write or edit");
  assert.ok(names.size >= 3, "the task must successfully execute at least three distinct tools");
  assert.ok(
    (context.successfulShellCommands ?? []).some((command) =>
      /(?:^|&&|;|\n)\s*node\s+--test\s+(?:\.\/)?test\/format\.test\.mjs(?:\s|$)/.test(command)),
    "the Agent must successfully execute node --test test/format.test.mjs with the shell tool",
  );
}

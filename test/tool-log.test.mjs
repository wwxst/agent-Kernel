/**
 * 文件目的：测「工具调用日志」这个第一个真实 Hook 用户 —— 它要证明两件事：
 * 只登记后置事件就能得到一份能用的调用记录；日志写不进去时，工具结果一点都不受影响。
 *
 * 文件职责：一行日志的字段与顺序、超长截断、目录自动创建、写失败只提醒一次、被拦下的调用不留记录。
 * 不测 Hook 机制本身（`tool-hooks.test.mjs`）、不测工具实现（`workspace.test.mjs`）。
 *
 * 内容目录：
 *   - 辅助：`readLog()` 读回 JSONL；`call()` 造调用。
 *   - 记录：成功一行 `ok:true` 带结果原文；失败一行 `ok:false` 带原因；字段名固定。
 *   - 截断：参数与结果各自 2000 字符上限，并写明截掉多少。
 *   - 落盘：父目录不存在会自动建；路径写不进去时不抛、不改结果、只往 stderr 提醒一次。
 *   - 缺口：被前置 Hook 拦下的调用没有日志（它没有执行）。
 *
 * 模块关系：依赖 `src/core/tool-log.ts`、`src/core/tool-registry.ts`、`test/support/harness.mjs`
 * 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MAX_LOG_FIELD_CHARS, createToolLogHooks } from "../src/core/tool-log.ts";
import { ToolHooks } from "../src/core/tool-hooks.ts";
import { ToolRegistry } from "../src/core/tool-registry.ts";
import { echoTool, withWorkspace } from "./support/harness.mjs";

/** 构造一次工具调用（ToolCall 的线上形状）。 */
function call(name, args = {}, id = "call_1") {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** 读回日志：一行一条 JSON。 */
async function readLog(file) {
  const raw = await readFile(file, "utf8");
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/** 把日志登记项装成执行器：这就是调用方真实要做的那一步。 */
function logHooks(file) {
  return new ToolHooks(createToolLogHooks(file));
}

/** 一个总是失败的假工具。 */
function failingTool(message) {
  return {
    name: "boom",
    description: "Always fails.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      throw new Error(message);
    },
  };
}

test("成功的调用记一行：工具名、调用 id、ok、参数与结果都在", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry([echoTool()], logHooks(file));

    assert.equal(await registry.execute(call("echo", { value: "hi" }, "c7")), "echo hi");

    const [record] = await readLog(file);
    assert.equal(record.tool, "echo");
    assert.equal(record.id, "c7");
    assert.equal(record.ok, true);
    assert.equal(record.args, '{"value":"hi"}');
    assert.equal(record.detail, "echo hi");
    assert.equal(typeof record.ts, "number");
  });
});

test("失败的调用也记一行：ok 为 false，detail 是失败原因", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry([failingTool("disk on fire")], logHooks(file));

    assert.equal(await registry.execute(call("boom")), "ERROR: disk on fire");

    const [record] = await readLog(file);
    assert.equal(record.tool, "boom");
    assert.equal(record.ok, false);
    assert.equal(record.detail, "disk on fire");
  });
});

test("多次调用按顺序追加，父目录不存在会自动建", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "nested", "deeper", "calls.jsonl");
    const registry = new ToolRegistry([echoTool(), failingTool("nope")], logHooks(file));

    await registry.execute(call("echo", { value: "a" }, "c1"));
    await registry.execute(call("boom", {}, "c2"));
    await registry.execute(call("echo", { value: "b" }, "c3"));

    assert.deepEqual(
      (await readLog(file)).map((record) => [record.id, record.ok]),
      [["c1", true], ["c2", false], ["c3", true]],
    );
  });
});

test("参数与结果超长时截断，并写明截掉了多少", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const long = "x".repeat(MAX_LOG_FIELD_CHARS + 50);
    const registry = new ToolRegistry([echoTool()], logHooks(file));

    await registry.execute(call("echo", { value: long }));

    const [record] = await readLog(file);
    // 结果原文是 "echo " + 2050 个 x = 2055 字符，截到 2000 后还剩 55 个没记。
    assert.match(record.detail, /… \(\+55 chars\)$/);
    assert.equal(record.detail.length, MAX_LOG_FIELD_CHARS + "… (+55 chars)".length);
    assert.match(record.args, /… \(\+\d+ chars\)$/);
  });
});

test("日志写不进去：工具结果不变，只往 stderr 提醒一次", async () => {
  await withWorkspace(async (dir) => {
    // 把日志路径指向一个目录：追加写必然失败，而且是稳定的失败。
    const file = path.join(dir, "as-a-directory");
    await mkdir(file);
    const registry = new ToolRegistry([echoTool()], logHooks(file));

    const warnings = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      warnings.push(String(chunk));
      return true;
    };
    try {
      assert.equal(await registry.execute(call("echo", { value: "a" })), "echo a");
      assert.equal(await registry.execute(call("echo", { value: "b" })), "echo b");
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(warnings.length, 1, "同一个问题不该每次调用都刷一遍");
    assert.match(warnings[0], /^\[tool-log\] cannot write /);
  });
});

test("被前置 Hook 拦下的调用不留日志：它没有执行，也就没有结果", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    // 拼装方式和真实调用方一样：日志登记项 + 别的 Hook，一起交给 new ToolHooks(...)。
    const hooks = new ToolHooks({
      preToolUse: [() => ({ block: "not allowed" })],
      ...createToolLogHooks(file),
    });
    const registry = new ToolRegistry([echoTool()], hooks);

    assert.match(await registry.execute(call("echo", { value: "hi" })), /blocked by hook/);

    await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
  });
});

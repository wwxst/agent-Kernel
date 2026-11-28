/**
 * 文件目的：测「工具调用日志」这个第一个真实 Hook 用户 —— 它要证明两件事：
 * 只登记后置事件就能得到一份能用的调用记录；日志写不进去时，工具结果一点都不受影响。
 *
 * 文件职责：一行日志的字段与顺序、超长截断、目录自动创建、写失败只提醒一次、被拦下的调用不留记录，
 * 以及尽力脱敏的覆盖范围与日志文件权限。
 * 不测 Hook 机制本身（`tool-hooks.test.mjs`）、不测工具实现（`workspace.test.mjs`）。
 *
 * 内容目录：
 *   - 辅助：`readLog()` 读回 JSONL；`call()` 造调用。
 *   - 记录：成功一行 `ok:true` 带结果原文；失败一行 `ok:false` 带原因；字段名固定。
 *   - 截断：参数与结果各自 2000 字符上限，并写明截掉多少。
 *   - 落盘：父目录不存在会自动建；路径写不进去时不抛、不改结果、只往 stderr 提醒一次。
 *   - 脱敏：凭据字段递归覆盖、环境变量赋值、Bearer/Basic、常见 token 前缀、PEM 私钥块；
 *     安全文本原样保留；深度/数组/对象超限留下可见标记。
 *   - 权限：POSIX 上新建与已有文件都收紧到 0600（Windows 跳过）。
 *   - 缺口：被前置 Hook 拦下的调用没有日志（它没有执行）。
 *
 * 模块关系：依赖 `src/core/tool-log.ts`、`src/core/tool-registry.ts`、`test/support/harness.mjs`
 * 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MAX_LOG_FIELD_CHARS, createToolLogHooks } from "../src/core/tool-log.ts";
import { ToolHooks } from "../src/core/tool-hooks.ts";
import { ToolRegistry } from "../src/core/tool-registry.ts";
import { Workspace, createWorkspaceTools } from "../src/tools/workspace.ts";
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

test("日志：凭据字段与 Bearer token 脱敏，但工具返回原文不变", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const tool = {
      name: "echo-secret",
      description: "Echo secret-bearing args.",
      parameters: { type: "object", properties: { api_key: { type: "string" }, password: { type: "string" } } },
      run: async () => "Bearer abc.def.ghi",
    };
    const registry = new ToolRegistry([tool], logHooks(file));
    assert.equal(await registry.execute(call("echo-secret", {
      api_key: "top-secret", password: "hidden",
    })), "Bearer abc.def.ghi");
    const [record] = await readLog(file);
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /top-secret|hidden|abc\.def\.ghi/);
    assert.match(serialized, /REDACTED/);
    assert.equal(record.detail, "Bearer [REDACTED]", "Bearer token 必须从实际落盘内容中消失");
  });
});

test("脱敏：shell 命令里的 NAME=value 凭据保留名字、抹掉值", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry(createWorkspaceTools(new Workspace({ root: dir })), logHooks(file));

    const result = await registry.executeWithStatus(call("shell", {
      command: "echo OPENAI_API_KEY=supersecret123",
    }));
    assert.equal(result.isError, false, result.content);

    const [record] = await readLog(file);
    assert.match(record.args, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(record.args, /supersecret123/);
    // 命令输出同样会进 detail；环境变量赋值在两边都要被抹掉。
    assert.match(record.detail, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(record.detail, /supersecret123/);
  });
});

test("脱敏：Authorization: Bearer 头把整段凭据换成 REDACTED", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry([{
      name: "http",
      description: "Returns an authorization header.",
      parameters: { type: "object", properties: {} },
      run: async () => "Authorization: Bearer abc.def.ghi",
    }], logHooks(file));

    assert.equal(await registry.execute(call("http")), "Authorization: Bearer abc.def.ghi");

    const [record] = await readLog(file);
    assert.equal(record.detail, "Authorization: [REDACTED]");
    assert.doesNotMatch(record.detail, /abc\.def\.ghi/);
  });
});

test("脱敏：嵌套对象里的 api_key 整段抹掉，邻近安全字段保留", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry([{
      name: "configure",
      description: "Accepts an arbitrary config object.",
      parameters: { type: "object", properties: {} },
      run: async () => "ok",
    }], logHooks(file));

    await registry.execute(call("configure", {
      config: { api_key: "nested-secret" },
      label: "safe",
    }));

    const [record] = await readLog(file);
    assert.doesNotMatch(record.args, /nested-secret/);
    assert.match(record.args, /"api_key":"\[REDACTED\]"/);
    assert.match(record.args, /"label":"safe"/);
  });
});

test("脱敏：工具结果里的常见 token 前缀与 PEM 私钥块不会落盘", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const detail = [
      "openai sk-proj-abcdefghijklmnop",
      "github ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "aws AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAexample",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const registry = new ToolRegistry([{
      name: "leak",
      description: "Returns secrets of several shapes.",
      parameters: { type: "object", properties: {} },
      run: async () => detail,
    }], logHooks(file));

    assert.equal(await registry.execute(call("leak")), detail, "工具返回原文不变");

    const [record] = await readLog(file);
    for (const secret of ["sk-proj-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAIOSFODNN7EXAMPLE", "MIIEowIBAAKCAQEAexample", "BEGIN RSA PRIVATE KEY"]) {
      assert.doesNotMatch(record.detail, new RegExp(secret), `${secret} 不该落盘`);
    }
    assert.match(record.detail, /\[REDACTED\]/);
    assert.match(record.detail, /\[REDACTED PRIVATE KEY\]/);
  });
});

test("脱敏：不命中规则的安全文本原样保留", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry([echoTool()], logHooks(file));

    await registry.execute(call("echo", { value: "build finished in 42ms; path=src/core/tool-log.ts" }));

    const [record] = await readLog(file);
    assert.equal(record.detail, "echo build finished in 42ms; path=src/core/tool-log.ts");
    assert.match(record.args, /build finished in 42ms/);
    assert.doesNotMatch(record.args, /REDACTED/);
  });
});

test("脱敏：深度、数组与对象超出上限时留下可见标记", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry([{
      name: "blob",
      description: "Accepts a deeply nested blob.",
      parameters: { type: "object", properties: {} },
      run: async () => "ok",
    }], logHooks(file));

    let deep = "leaf";
    for (let index = 0; index < 10; index++) deep = { next: deep };
    const items = Array.from({ length: 101 }, (_, index) => index);
    const keys = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`k${index}`, index]));

    await registry.execute(call("blob", { deep, items, keys }));

    const [record] = await readLog(file);
    assert.match(record.args, /\[MAX_DEPTH\]/);
    assert.match(record.args, /\[\+1 more items\]/);
    assert.match(record.args, /\[\+1 more keys\]/);
  });
});

test("日志文件权限：POSIX 上新建与已有文件都收紧到 0600", { skip: process.platform === "win32" }, async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry([echoTool()], logHooks(file));

    await registry.execute(call("echo", { value: "new" }));
    assert.equal((await stat(file)).mode & 0o777, 0o600, "新建文件必须是 0600");

    // 模拟历史版本留下的宽权限文件：下一次写入必须把它收紧。
    await chmod(file, 0o644);
    assert.equal((await stat(file)).mode & 0o777, 0o644);
    await registry.execute(call("echo", { value: "existing" }));
    assert.equal((await stat(file)).mode & 0o777, 0o600, "已有文件也必须收紧到 0600");
  });
});

test("shell 非零退出记为失败：和 CLI / TUI 用同一套判断", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "calls.jsonl");
    const registry = new ToolRegistry(createWorkspaceTools(new Workspace({ root: dir })), logHooks(file));

    // shell 不抛异常，它用第一行的退出码报告失败 —— 所以「成功与否」不能只看有没有抛错。
    assert.equal((await registry.execute(call("shell", { command: "exit 3" }))).split("\n")[0], "exit 3");
    assert.equal((await registry.execute(call("shell", { command: "echo ok" }))).split("\n")[0], "exit 0");

    assert.deepEqual((await readLog(file)).map((record) => [record.tool, record.ok]), [
      ["shell", false],
      ["shell", true],
    ]);
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

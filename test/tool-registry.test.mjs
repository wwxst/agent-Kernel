/**
 * ToolRegistry 的单元测试：它是「工具失败必须折成文本」这条规矩唯一的执行点，
 * 所以每个失败分支都要在这里钉死 —— 漏一个，agent 就会被一个异常打断。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry } from "../src/tool-registry.ts";
import { echoTool } from "./support/harness.mjs";

/** 构造一次工具调用（ToolCall 的线上形状）。 */
function call(name, rawArguments = "{}", id = "call_1") {
  return { id, type: "function", function: { name, arguments: rawArguments } };
}

/** 一个记录收到什么参数的假工具。 */
function recordingTool() {
  const seen = [];
  return {
    seen,
    tool: {
      name: "record",
      description: "Record its arguments.",
      parameters: { type: "object", properties: {} },
      run: async (args) => {
        seen.push(args);
        return `ok ${JSON.stringify(args)}`;
      },
    },
  };
}

test("definitions：只投影说明书字段，run 不外泄", () => {
  const registry = new ToolRegistry([echoTool()]);

  const [definition] = registry.definitions;

  assert.deepEqual(Object.keys(definition).sort(), ["description", "name", "parameters"]);
  assert.equal(definition.name, "echo");
});

test("execute：命中工具就执行它", async () => {
  const registry = new ToolRegistry([echoTool()]);

  assert.equal(await registry.execute(call("echo", JSON.stringify({ value: "hi" }))), "echo hi");
});

test("execute：未知工具返回 ERROR，并列出可用工具", async () => {
  const registry = new ToolRegistry([echoTool()]);

  const result = await registry.execute(call("rm_rf", "{}"));

  assert.match(result, /^ERROR: unknown tool "rm_rf"/);
  assert.match(result, /available: echo/);
});

test("execute：坏 JSON 返回 ERROR，而不是抛异常", async () => {
  const registry = new ToolRegistry([echoTool()]);

  const result = await registry.execute(call("echo", "{not valid json"));

  assert.match(result, /^ERROR: invalid JSON arguments/);
});

test("execute：参数不是 JSON 对象时返回 ERROR", async () => {
  const registry = new ToolRegistry([echoTool()]);

  assert.match(await registry.execute(call("echo", "[]")), /arguments must be a JSON object/);
  assert.match(await registry.execute(call("echo", "42")), /arguments must be a JSON object/);
  assert.match(await registry.execute(call("echo", "null")), /arguments must be a JSON object/);
});

test("execute：空 arguments 当作空对象", async () => {
  const { tool, seen } = recordingTool();
  const registry = new ToolRegistry([tool]);

  assert.equal(await registry.execute(call("record", "")), "ok {}");
  assert.deepEqual(seen, [{}]);
});

test("execute：工具抛 Error 折成 ERROR 文本", async () => {
  const registry = new ToolRegistry([
    {
      name: "boom",
      description: "fails",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw new Error("disk on fire");
      },
    },
  ]);

  assert.equal(await registry.execute(call("boom")), "ERROR: disk on fire");
});

test("execute：工具抛非 Error 也能折成文本", async () => {
  const registry = new ToolRegistry([
    {
      name: "weird",
      description: "throws a string",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw 42;
      },
    },
  ]);

  assert.equal(await registry.execute(call("weird")), "ERROR: 42");
});

test("execute：缺少必填参数直接报错，不会带着空值去执行工具", async () => {
  const received = [];
  const registry = new ToolRegistry([
    {
      name: "write",
      description: "write a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      run: async (args) => {
        received.push(args);
        return "ok";
      },
    },
  ]);

  const result = await registry.execute(call("write", JSON.stringify({ path: "a.txt" })));

  assert.match(result, /^ERROR: invalid arguments: missing required argument "content"/);
  assert.deepEqual(received, [], "工具不该被调用 —— 少了 content 就等于清空文件");
});

test("execute：参数类型不对也直接报错", async () => {
  const registry = new ToolRegistry([
    {
      name: "read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      run: async () => "ok",
    },
  ]);

  const result = await registry.execute(call("read", JSON.stringify({ path: 42 })));

  assert.match(result, /^ERROR: invalid arguments: argument "path" must be a string/);
});

test("execute：参数齐全才真的执行", async () => {
  const received = [];
  const registry = new ToolRegistry([
    {
      name: "write",
      description: "write a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      run: async (args) => {
        received.push(args);
        return "ok";
      },
    },
  ]);

  const result = await registry.execute(call("write", JSON.stringify({ path: "a.txt", content: "" })));

  assert.equal(result, "ok");
  assert.deepEqual(received, [{ path: "a.txt", content: "" }], "空串是合法内容，缺字段不是");
});

test("execute：空错误消息也不能变成空的 ERROR", async () => {
  const registry = new ToolRegistry([
    {
      name: "boom",
      description: "throws an Error with no message",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw new Error("");
      },
    },
  ]);

  assert.equal(await registry.execute(call("boom")), "ERROR: Error");
});

test("execute：抛空字符串也有兜底文案", async () => {
  const registry = new ToolRegistry([
    {
      name: "boom",
      description: "throws a blank string",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw "   ";
      },
    },
  ]);

  assert.equal(await registry.execute(call("boom")), "ERROR: Unknown error (empty string thrown)");
});

test("execute：抛 undefined 也有兜底文案", async () => {
  const registry = new ToolRegistry([
    {
      name: "boom",
      description: "throws undefined",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw undefined;
      },
    },
  ]);

  assert.equal(await registry.execute(call("boom")), "ERROR: Unknown error (undefined)");
});

/** 一个只有 Schema、没有行为的工具：注册期校验用。 */
function schemaTool(parameters) {
  return { name: "t", description: "test", parameters, run: async () => "ok" };
}

test("注册：重名工具直接拒绝", () => {
  assert.throws(() => new ToolRegistry([echoTool(), echoTool()]), /duplicate tool name "echo"/);
});

test("注册：声明 array / object 参数直接拒绝（校验器不懂它们）", () => {
  assert.throws(
    () => new ToolRegistry([schemaTool({ type: "object", properties: { tags: { type: "array" } } })]),
    /parameter "tags" has unsupported type "array"/,
  );
  assert.throws(
    () => new ToolRegistry([schemaTool({ type: "object", properties: { cfg: { type: "object" } } })]),
    /parameter "cfg" has unsupported type "object"/,
  );
});

test("注册：parameters 必须是 object schema", () => {
  assert.throws(
    () => new ToolRegistry([schemaTool({ type: "array", properties: {} })]),
    /parameters\.type must be "object"/,
  );
  assert.throws(
    () => new ToolRegistry([schemaTool({ properties: {} })]),
    /parameters\.type must be "object"/,
  );
});

test("注册：required 必须声明在 properties 里，且是字符串数组", () => {
  assert.throws(
    () => new ToolRegistry([schemaTool({ type: "object", properties: { a: { type: "string" } }, required: ["b"] })]),
    /required parameter "b" is not declared/,
  );
  assert.throws(
    () => new ToolRegistry([schemaTool({ type: "object", properties: {}, required: "a" })]),
    /parameters\.required must be an array of strings/,
  );
});

test("注册：每个参数都必须声明受支持的类型", () => {
  assert.throws(
    () => new ToolRegistry([schemaTool({ type: "object", properties: { a: {} } })]),
    /parameter "a" must declare a type/,
  );
});

test("execute：number 参数拒绝 Infinity，boolean 参数拒绝字符串", async () => {
  const registry = new ToolRegistry([
    {
      name: "num",
      description: "number",
      parameters: {
        type: "object",
        properties: { n: { type: "number" }, flag: { type: "boolean" } },
        required: ["n"],
      },
      run: async (args) => `got ${String(args.n)} ${String(args.flag)}`,
    },
  ]);

  assert.match(
    await registry.execute(call("num", '{"n": 1e999}')),
    /invalid arguments: argument "n" must be a finite number/,
  );
  assert.match(
    await registry.execute(call("num", '{"n": 1, "flag": "true"}')),
    /argument "flag" must be a boolean/,
  );
  assert.equal(await registry.execute(call("num", '{"n": 1, "flag": true}')), "got 1 true");
});

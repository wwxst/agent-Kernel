/**
 * Toolbelt 的单元测试：它是「工具失败必须折成文本」这条规矩唯一的执行点，
 * 所以每个失败分支都要在这里钉死 —— 漏一个，agent 就会被一个异常打断。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Toolbelt } from "../src/toolbelt.ts";
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
  const registry = new Toolbelt([echoTool()]);

  const [definition] = registry.definitions;

  assert.deepEqual(Object.keys(definition).sort(), ["description", "name", "parameters"]);
  assert.equal(definition.name, "echo");
});

test("dispatch：命中工具就执行它", async () => {
  const registry = new Toolbelt([echoTool()]);

  assert.equal(await registry.dispatch(call("echo", JSON.stringify({ value: "hi" }))), "echo hi");
});

test("dispatch：未知工具返回 ERROR，并列出可用工具", async () => {
  const registry = new Toolbelt([echoTool()]);

  const result = await registry.dispatch(call("rm_rf", "{}"));

  assert.match(result, /^ERROR: unknown tool "rm_rf"/);
  assert.match(result, /available: echo/);
});

test("dispatch：坏 JSON 返回 ERROR，而不是抛异常", async () => {
  const registry = new Toolbelt([echoTool()]);

  const result = await registry.dispatch(call("echo", "{not valid json"));

  assert.match(result, /^ERROR: invalid JSON arguments/);
});

test("dispatch：参数不是 JSON 对象时返回 ERROR", async () => {
  const registry = new Toolbelt([echoTool()]);

  assert.match(await registry.dispatch(call("echo", "[]")), /arguments must be a JSON object/);
  assert.match(await registry.dispatch(call("echo", "42")), /arguments must be a JSON object/);
  assert.match(await registry.dispatch(call("echo", "null")), /arguments must be a JSON object/);
});

test("dispatch：空 arguments 当作空对象", async () => {
  const { tool, seen } = recordingTool();
  const registry = new Toolbelt([tool]);

  assert.equal(await registry.dispatch(call("record", "")), "ok {}");
  assert.deepEqual(seen, [{}]);
});

test("dispatch：工具抛 Error 折成 ERROR 文本", async () => {
  const registry = new Toolbelt([
    {
      name: "boom",
      description: "fails",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw new Error("disk on fire");
      },
    },
  ]);

  assert.equal(await registry.dispatch(call("boom")), "ERROR: disk on fire");
});

test("dispatch：工具抛非 Error 也能折成文本", async () => {
  const registry = new Toolbelt([
    {
      name: "weird",
      description: "throws a string",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw 42;
      },
    },
  ]);

  assert.equal(await registry.dispatch(call("weird")), "ERROR: 42");
});

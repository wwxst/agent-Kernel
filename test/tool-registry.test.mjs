/**
 * 文件目的：测工具箱 —— 它是「工具出错必须变成一句错误话」这条规矩唯一的执行点，
 * 所以每个出错分支都要在这里钉死：漏一个，程序就会被一个异常打断。
 *
 * 文件职责：测注册时的体检、参数校验、执行成功与四种失败折文本、以及那条不可折的例外。
 * 不测具体工具的实现（那是 `workspace.test.mjs`）。
 *
 * 内容目录：
 *   - `call()`：造一次工具调用；`recordingTool()`：记录收到的参数的假工具。
 *   - `definitions`：只投影说明书字段，`run` 不外泄；修改说明书不能绕过参数校验。
 *   - `execute` 正常路径：命中就执行、参数齐全才真的执行、空 `arguments` 当空对象。
 *   - `execute` 失败分支：未知工具、坏 JSON、参数非对象、缺必填（只认对象自身字段）、类型不对、
 *     工具抛任何东西，一律折成非空的 `ERROR:` 文本；只有 `ProcessCleanupError` 必须继续往外抛。
 *   - 注册体检：重名、`array` / `object` 参数、非法 schema、`required` 未声明、缺类型。
 *
 * 模块关系：依赖 `src/protocol/errors.ts`、`test/support/harness.mjs` 与 `node:test`，
 * 由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessCleanupError } from "../src/protocol/errors.ts";
import { echoTool, makeRegistry } from "./support/harness.mjs";

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
  const registry = makeRegistry([echoTool()]);

  const [definition] = registry.definitions;

  assert.deepEqual(Object.keys(definition).sort(), ["description", "name", "parameters"]);
  assert.equal(definition.name, "echo");
});

test("注册：外部修改原始 Tool Schema 不改变注册后的校验规则", async () => {
  const tool = {
    name: "guarded",
    description: "Guarded tool.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    run: async () => "ran",
  };
  const registry = makeRegistry([tool]);
  tool.parameters.required.length = 0;
  tool.parameters.properties.value.type = "number";
  assert.deepEqual(registry.definitions[0].parameters.required, ["value"]);
  assert.match(await registry.execute(call("guarded", {})), /missing required argument "value"/);
  assert.equal(await registry.execute(call("guarded", { value: "ok" })), "ran");
});

test("definitions：修改嵌套 Schema 不影响后续说明书与参数校验", async () => {
  const registry = makeRegistry([echoTool()]);
  const [definition] = registry.definitions;
  definition.parameters.required.length = 0;
  definition.parameters.properties.value.type = "object";

  assert.deepEqual(registry.definitions[0].parameters, {
    type: "object", properties: { value: { type: "string" } }, required: ["value"],
  });
  assert.equal(await registry.execute(call("echo", "{}")),
    'ERROR: invalid arguments: missing required argument "value"');
  assert.equal(await registry.execute(call("echo", '{"value":{}}')),
    'ERROR: invalid arguments: argument "value" must be a string');
});

test("execute：命中工具就执行它", async () => {
  const registry = makeRegistry([echoTool()]);

  assert.equal(await registry.execute(call("echo", JSON.stringify({ value: "hi" }))), "echo hi");
});

test("execute：未知工具返回 ERROR，并列出可用工具", async () => {
  const registry = makeRegistry([echoTool()]);

  const result = await registry.execute(call("rm_rf", "{}"));

  assert.match(result, /^ERROR: unknown tool "rm_rf"/);
  assert.match(result, /available: echo/);
});

test("execute：坏 JSON 返回 ERROR，而不是抛异常", async () => {
  const registry = makeRegistry([echoTool()]);

  const result = await registry.execute(call("echo", "{not valid json"));

  assert.match(result, /^ERROR: invalid JSON arguments/);
});

test("execute：参数不是 JSON 对象时返回 ERROR", async () => {
  const registry = makeRegistry([echoTool()]);

  assert.match(await registry.execute(call("echo", "[]")), /arguments must be a JSON object/);
  assert.match(await registry.execute(call("echo", "42")), /arguments must be a JSON object/);
  assert.match(await registry.execute(call("echo", "null")), /arguments must be a JSON object/);
});

test("execute：空 arguments 当作空对象", async () => {
  const { tool, seen } = recordingTool();
  const registry = makeRegistry([tool]);

  assert.equal(await registry.execute(call("record", "")), "ok {}");
  assert.deepEqual(seen, [{}]);
});

test("进程树清理未确认不可折成可恢复 ERROR：传播不可恢复异常", async () => {
  const registry = makeRegistry([{
    name: "shell", description: "test",
    parameters: { type: "object", properties: {} },
    run: async () => { throw new ProcessCleanupError("cleanup unverified"); },
  }]);
  await assert.rejects(() => registry.execute(call("shell")), ProcessCleanupError);
});

test("execute：工具抛 Error 折成 ERROR 文本", async () => {
  const registry = makeRegistry([
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
  const registry = makeRegistry([
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
  const registry = makeRegistry([
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
  const registry = makeRegistry([
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
  const registry = makeRegistry([
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

test("execute：required 只接受对象自身字段，不接受原型链继承", async () => {
  for (const key of ["constructor", "toString"]) {
    const rootSeen = [];
    const rootRegistry = makeRegistry([{
      name: "root", description: "root required field",
      parameters: { type: "object", properties: { [key]: { type: "string" } }, required: [key] },
      run: async (args) => { rootSeen.push(args); return "ok"; },
    }]);

    assert.equal(
      await rootRegistry.execute(call("root", "{}")),
      "ERROR: invalid arguments: missing required argument \"" + key + "\"",
    );
    assert.deepEqual(rootSeen, [], "缺少自有字段时不能执行根对象工具");
    assert.equal(await rootRegistry.execute(call("root", JSON.stringify({ [key]: "present" }))), "ok");
    assert.equal(rootSeen.length, 1);

    const nestedSeen = [];
    const nestedRegistry = makeRegistry([{
      name: "nested", description: "nested required field",
      parameters: {
        type: "object",
        properties: {
          cfg: {
            type: "object",
            properties: { [key]: { type: "string" } },
            required: [key],
          },
        },
        required: ["cfg"],
      },
      run: async (args) => { nestedSeen.push(args); return "ok"; },
    }]);

    assert.equal(
      await nestedRegistry.execute(call("nested", "{\"cfg\":{}}")),
      "ERROR: invalid arguments: missing required argument \"cfg." + key + "\"",
    );
    assert.deepEqual(nestedSeen, [], "缺少嵌套自有字段时不能执行工具");
    assert.equal(
      await nestedRegistry.execute(call("nested", JSON.stringify({ cfg: { [key]: "present" } }))),
      "ok",
    );
    assert.equal(nestedSeen.length, 1);
  }
});

test("execute：空错误消息也不能变成空的 ERROR", async () => {
  const registry = makeRegistry([
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
  const registry = makeRegistry([
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
  const registry = makeRegistry([
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
  assert.throws(() => makeRegistry([echoTool(), echoTool()]), /duplicate tool name "echo"/);
});

test("注册：array 缺 items 或对象必填字段未声明时拒绝", () => {
  assert.throws(() => makeRegistry([schemaTool({
    type: "object", properties: { tags: { type: "array" } },
  })]), /parameter "tags" must declare array items/);
  assert.throws(() => makeRegistry([schemaTool({
    type: "object", properties: { cfg: { type: "object", properties: {}, required: ["missing"] } },
  })]), /required parameter "cfg.missing" is not declared/);
  assert.throws(() => makeRegistry([schemaTool({
    type: "object", properties: { tags: { type: "array", items: { type: "null" } } },
  })]), /parameter "tags\[\]" has unsupported type "null"/);
});

test("execute：嵌套 array/object 必填及字段类型校验", async () => {
  const seen = [];
  const registry = makeRegistry([{
    name: "batch", description: "nested schema test",
    parameters: { type: "object", properties: { items: { type: "array", items: {
      type: "object", properties: { label: { type: "string" }, status: { type: "string" } },
      required: ["label", "status"],
    } } }, required: ["items"] },
    run: async (args) => { seen.push(args); return "ok"; },
  }]);
  assert.match(await registry.execute(call("batch", '{"items":{}}')), /argument "items" must be an array/);
  assert.match(await registry.execute(call("batch", '{"items":[null]}')), /argument "items\[0\]" must be an object/);
  assert.match(await registry.execute(call("batch", '{"items":[{"label":"a"}]}')),
    /missing required argument "items\[0\].status"/);
  assert.match(await registry.execute(call("batch", '{"items":[{"label":1,"status":"done"}]}')),
    /argument "items\[0\].label" must be a string/);
  assert.equal(seen.length, 0);
  assert.equal(await registry.execute(call("batch", '{"items":[{"label":"a","status":"done"}]}')), "ok");
  assert.equal(seen.length, 1);
});

test("注册：parameters 必须是 object schema", () => {
  assert.throws(
    () => makeRegistry([schemaTool({ type: "array", properties: {} })]),
    /parameters\.type must be "object"/,
  );
  assert.throws(
    () => makeRegistry([schemaTool({ properties: {} })]),
    /parameters\.type must be "object"/,
  );
});

test("注册：required 必须声明在 properties 里，且是字符串数组", () => {
  assert.throws(
    () => makeRegistry([schemaTool({ type: "object", properties: { a: { type: "string" } }, required: ["b"] })]),
    /required parameter "b" is not declared/,
  );
  assert.throws(
    () => makeRegistry([schemaTool({ type: "object", properties: {}, required: "a" })]),
    /parameters\.required must be an array of strings/,
  );
});

test("注册：对象 Schema 的 properties / required 形状不对时，报错带位置名", () => {
  // 根对象与嵌套对象共用一套字段体检，但文案的称呼不同：根叫 parameters，嵌套叫 parameter "cfg"。
  assert.throws(
    () => makeRegistry([schemaTool({ type: "object", properties: "nope" })]),
    /parameters\.properties must be an object/,
  );
  assert.throws(
    () => makeRegistry([schemaTool({
      type: "object", properties: { a: { type: "string" } }, required: ["a", 1],
    })]),
    /parameters\.required must contain only strings/,
  );
  assert.throws(
    () => makeRegistry([schemaTool({ type: "object", properties: { cfg: { type: "object", properties: "nope" } } })]),
    /parameter "cfg" properties must be an object/,
  );
  assert.throws(
    () => makeRegistry([schemaTool({
      type: "object", properties: { cfg: { type: "object", properties: {}, required: "a" } },
    })]),
    /parameter "cfg" required must be an array of strings/,
  );
});

test("注册：每个参数都必须声明受支持的类型", () => {
  assert.throws(
    () => makeRegistry([schemaTool({ type: "object", properties: { a: {} } })]),
    /parameter "a" must declare a type/,
  );
});

test("execute：number 参数拒绝 Infinity，boolean 参数拒绝字符串", async () => {
  const registry = makeRegistry([
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

/**
 * Agent 循环的单元测试：在 ChatClient 这条缝上驱动完整循环。
 *
 * 断言的都是外部行为：消息顺序、tool_call_id 配对、步数上限、错误是否被回灌。
 * 循环内部怎么组织，测试一概不关心 —— 重构不该让这些用例变红。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, DEFAULT_SYSTEM_PROMPT } from "../src/agent.ts";
import { Toolbelt } from "../src/toolbelt.ts";
import { callTool, createScriptedChat, echoTool, finalReply } from "./support/harness.mjs";

/** 只要角色序列，消息内容在别的断言里单独看。 */
function roles(messages) {
  return messages.map((message) => message.role);
}

test("一轮工具调用：结果在下一轮请求前入栈，且带对了 tool_call_id", async () => {
  const chat = createScriptedChat([
    callTool("c1", "echo", { value: "a" }),
    finalReply("done"),
  ]);
  const agent = new Agent({ llm: chat, toolbelt: new Toolbelt([echoTool()]) });

  const reply = await agent.run("do it");

  assert.equal(reply.content, "done");
  assert.equal(chat.requests.length, 2);

  // 第一次请求：system 在最前，然后是任务
  assert.deepEqual(roles(chat.requests[0].messages), ["system", "user"]);

  // 第二次请求：模型能看到刚才那次调用的结果
  const second = chat.requests[1].messages;
  assert.deepEqual(roles(second), ["system", "user", "assistant", "tool"]);
  assert.equal(second[3].tool_call_id, "c1");
  assert.equal(second[3].content, "echo a");

  // 循环结束后，记录里应该停在模型那句最终回复上
  assert.deepEqual(roles(agent.transcript), ["system", "user", "assistant", "tool", "assistant"]);
});

test("一轮多个工具调用：按模型给出的顺序串行执行", async () => {
  const chat = createScriptedChat([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "echo", arguments: JSON.stringify({ value: "first" }) } },
        { id: "c2", type: "function", function: { name: "echo", arguments: JSON.stringify({ value: "second" }) } },
      ],
    },
    finalReply("done"),
  ]);
  const agent = new Agent({ llm: chat, toolbelt: new Toolbelt([echoTool()]) });

  await agent.run("do it");

  const tools = chat.requests[1].messages.filter((message) => message.role === "tool");
  assert.deepEqual(tools.map((message) => message.tool_call_id), ["c1", "c2"]);
  assert.deepEqual(tools.map((message) => message.content), ["echo first", "echo second"]);
});

test("工具失败不会打断循环：ERROR 文本进历史，模型继续收尾", async () => {
  const broken = {
    name: "boom",
    description: "Always fails.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      throw new Error("kaboom");
    },
  };
  const chat = createScriptedChat([callTool("c1", "boom", {}), finalReply("recovered")]);
  const agent = new Agent({ llm: chat, toolbelt: new Toolbelt([broken]) });

  const reply = await agent.run("do it");

  assert.equal(reply.content, "recovered");
  const toolMessage = chat.requests[1].messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.content, "ERROR: kaboom");
});

test("步数上限：模型一直要调工具时抛错，且只请求了 maxSteps 次", async () => {
  const chat = createScriptedChat([callTool("loop", "echo", { value: "x" })]);
  const agent = new Agent({ llm: chat, toolbelt: new Toolbelt([echoTool()]), maxSteps: 2 });

  await assert.rejects(() => agent.run("never finishes"), /step limit 2 reached/);
  assert.equal(chat.requests.length, 2);
  // 失败也要留下全过程，方便事后调试
  assert.deepEqual(roles(agent.transcript), ["system", "user", "assistant", "tool", "assistant", "tool"]);
});

test("没有工具调用就立刻收尾，不会多发请求", async () => {
  const chat = createScriptedChat([finalReply("no tools needed")]);
  const agent = new Agent({ llm: chat, toolbelt: new Toolbelt([echoTool()]) });

  const reply = await agent.run("just answer");

  assert.equal(reply.content, "no tools needed");
  assert.equal(chat.requests.length, 1);
});

test("onToolResult 对每条工具结果各回调一次", async () => {
  const seen = [];
  const chat = createScriptedChat([callTool("c1", "echo", { value: "a" }), finalReply("done")]);
  const agent = new Agent({
    llm: chat,
    toolbelt: new Toolbelt([echoTool()]),
    onToolResult: (call, result) => seen.push([call.id, result]),
  });

  await agent.run("do it");

  assert.deepEqual(seen, [["c1", "echo a"]]);
});

test("系统提示词：默认放一条 system 消息，也可以整条替换", async () => {
  const defaults = createScriptedChat([finalReply("ok")]);
  await new Agent({ llm: defaults, toolbelt: new Toolbelt([]) }).run("task");
  assert.equal(defaults.requests[0].messages[0].content, DEFAULT_SYSTEM_PROMPT);

  const custom = createScriptedChat([finalReply("ok")]);
  await new Agent({ llm: custom, toolbelt: new Toolbelt([]), systemPrompt: "be terse" }).run("task");
  assert.equal(custom.requests[0].messages[0].content, "be terse");
});

test("发给模型的工具清单只有说明书，没有 run", async () => {
  const chat = createScriptedChat([finalReply("ok")]);
  await new Agent({ llm: chat, toolbelt: new Toolbelt([echoTool()]) }).run("task");

  const [spec] = chat.requests[0].tools;
  assert.equal(spec.name, "echo");
  assert.equal("run" in spec, false);
});

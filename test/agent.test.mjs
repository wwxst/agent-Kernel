/**
 * Agent 循环的单元测试：在 ChatClient 这条缝上驱动完整循环。
 *
 * 断言的都是外部行为：消息顺序、tool_call_id 配对、步数上限、错误是否被回灌。
 * 循环内部怎么组织，测试一概不关心 —— 重构不该让这些用例变红。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, DEFAULT_SYSTEM_PROMPT } from "../src/agent.ts";
import { ChatResponseError } from "../src/errors.ts";
import { callTool, createScriptedChat, echoTool, finalReply, makeRegistry } from "./support/harness.mjs";

/** 只要角色序列，消息内容在别的断言里单独看。 */
function roles(messages) {
  return messages.map((message) => message.role);
}

test("一轮工具调用：结果在下一轮请求前入栈，且带对了 tool_call_id", async () => {
  const chat = createScriptedChat([
    callTool("c1", "echo", { value: "a" }),
    finalReply("done"),
  ]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]) });

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
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]) });

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
  const agent = new Agent({ llm: chat, tools: makeRegistry([broken]) });

  const reply = await agent.run("do it");

  assert.equal(reply.content, "recovered");
  const toolMessage = chat.requests[1].messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.content, "ERROR: kaboom");
});

test("步数上限：模型一直要调工具时抛错，最后一批工具不执行", async () => {
  const chat = createScriptedChat([callTool("loop", "echo", { value: "x" })]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]), maxSteps: 2 });

  await assert.rejects(
    () => agent.run("never finishes"),
    /step limit 2 reached after executing 1 tool call\(s\); the final model response asked for 1 more/,
  );
  assert.equal(chat.requests.length, 2);
  // 失败也要留下全过程，方便事后调试；最后一条 tool 消息写明「没跑」。
  assert.deepEqual(roles(agent.transcript), ["system", "user", "assistant", "tool", "assistant", "tool"]);
  assert.equal(agent.transcript.at(-1).content, "ERROR: not run: no model request left to verify the result");
});

test("没有工具调用就立刻收尾，不会多发请求", async () => {
  const chat = createScriptedChat([finalReply("no tools needed")]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]) });

  const reply = await agent.run("just answer");

  assert.equal(reply.content, "no tools needed");
  assert.equal(chat.requests.length, 1);
});

test("onToolResult 对每条工具结果各回调一次", async () => {
  const seen = [];
  const chat = createScriptedChat([callTool("c1", "echo", { value: "a" }), finalReply("done")]);
  const agent = new Agent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    onToolResult: (call, result) => seen.push([call.id, result]),
  });

  await agent.run("do it");

  assert.deepEqual(seen, [["c1", "echo a"]]);
});

test("系统提示词：默认放一条 system 消息，也可以整条替换", async () => {
  const defaults = createScriptedChat([finalReply("ok")]);
  await new Agent({ llm: defaults, tools: makeRegistry([]) }).run("task");
  assert.equal(defaults.requests[0].messages[0].content, DEFAULT_SYSTEM_PROMPT);

  const custom = createScriptedChat([finalReply("ok")]);
  await new Agent({ llm: custom, tools: makeRegistry([]), systemPrompt: "be terse" }).run("task");
  assert.equal(custom.requests[0].messages[0].content, "be terse");
});

test("系统提示词：函数在每次请求前求值，切换后不重复 system 消息", async () => {
  const chat = createScriptedChat([finalReply("first"), finalReply("second")]);
  let prompt = "prompt: read-only";
  const agent = new Agent({ llm: chat, tools: makeRegistry([]), systemPrompt: () => prompt });

  await agent.run("first");
  prompt = "prompt: full-access";
  await agent.run("second");

  assert.equal(chat.requests[0].messages[0].content, "prompt: read-only");
  assert.equal(chat.requests[1].messages[0].content, "prompt: full-access");
  assert.equal(chat.requests[1].messages.filter((message) => message.role === "system").length, 1);
  assert.equal(agent.transcript.filter((message) => message.role === "system").length, 1);
  assert.deepEqual(
    chat.requests[1].messages.map((message) => message.role),
    ["system", "user", "assistant", "user"],
  );
});

test("系统提示词：同一个 Run 的后续 Step 也使用最新提示", async () => {
  const requests = [];
  let prompt = "prompt: old";
  const chat = {
    async chat(messages) {
      requests.push(structuredClone({ messages }));
      if (requests.length === 1) {
        prompt = "prompt: new";
        return { message: callTool("c1", "echo", { value: "a" }) };
      }
      return { message: finalReply("done") };
    },
  };
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]), systemPrompt: () => prompt });

  await agent.run("task");

  assert.equal(requests[0].messages[0].content, "prompt: old");
  assert.equal(requests[1].messages[0].content, "prompt: new");
  assert.equal(requests[1].messages.filter((message) => message.role === "system").length, 1);
});

test("发给模型的工具清单只有说明书，没有 run", async () => {
  const chat = createScriptedChat([finalReply("ok")]);
  await new Agent({ llm: chat, tools: makeRegistry([echoTool()]) }).run("task");

  const [spec] = chat.requests[0].tools;
  assert.equal(spec.name, "echo");
  assert.equal("run" in spec, false);
});

test("transcript 返回深拷贝：改消息内容和嵌套的 tool_calls 都不影响内部记录", async () => {
  const chat = createScriptedChat([callTool("c1", "echo", { value: "a" }), finalReply("done")]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]) });

  await agent.run("task");

  const snapshot = agent.transcript;
  snapshot.push({ role: "user", content: "spoof" });
  snapshot[2].content = "tampered";
  snapshot[2].tool_calls[0].function.name = "evil";

  const after = agent.transcript;
  assert.equal(after.length, snapshot.length - 1, "push 不该改到内部数组");
  assert.notEqual(after[2].content, "tampered", "改 Message 不该改到内部记录");
  assert.equal(after[2].tool_calls[0].function.name, "echo", "改嵌套的 tool_calls 也不该改到内部记录");
});

test("空回复不算完成：模型什么都没说时必须报错", async () => {
  const chat = createScriptedChat([finalReply("   ")]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([]) });

  await assert.rejects(() => agent.run("task"), /model returned an empty final answer/);
});

test("取消：信号在任务开始前已 abort 时，一次模型请求都不发", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop now"));
  const chat = createScriptedChat([finalReply("never")]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]), signal: controller.signal });

  await assert.rejects(() => agent.run("task"), /cancelled: stop now/);
  assert.equal(chat.requests.length, 0);
  assert.deepEqual(roles(agent.transcript), ["system"], "取消发生在 user 消息入栈之前");
});

test("取消：中途 abort 后不再执行工具，剩下的调用留下 not run 结果", async () => {
  const controller = new AbortController();
  const chat = createScriptedChat([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "echo", arguments: JSON.stringify({ value: "a" }) } },
        { id: "c2", type: "function", function: { name: "echo", arguments: JSON.stringify({ value: "b" }) } },
      ],
    },
  ]);
  const interruptAfterFirst = {
    ...echoTool(),
    run: async (args) => {
      controller.abort(new Error("user interrupt"));
      return `echo ${String(args.value)}`;
    },
  };
  const agent = new Agent({
    llm: chat,
    tools: makeRegistry([interruptAfterFirst]),
    signal: controller.signal,
  });

  await assert.rejects(() => agent.run("task"), /cancelled: user interrupt/);
  assert.equal(chat.requests.length, 1, "取消后不能再发模型请求");

  // 配对必须完整：c2 没跑，但也要有一条 tool 结果说明它没跑。
  const toolMessages = agent.transcript.filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ["c1", "c2"]);
  assert.equal(toolMessages[0].content, "echo a");
  assert.equal(toolMessages[1].content, "ERROR: not run: task cancelled");
});

test("工具预算：一批调用会超限时整批都不执行", async () => {
  const chat = createScriptedChat([
    {
      role: "assistant",
      content: null,
      tool_calls: ["a", "b", "c"].map((value, index) => ({
        id: `c${index + 1}`,
        type: "function",
        function: { name: "echo", arguments: JSON.stringify({ value }) },
      })),
    },
  ]);
  const executed = [];
  const tool = {
    ...echoTool(),
    run: async (args) => {
      executed.push(args.value);
      return `echo ${String(args.value)}`;
    },
  };
  const agent = new Agent({ llm: chat, tools: makeRegistry([tool]), maxToolCalls: 2 });

  await assert.rejects(
    () => agent.run("task"),
    /tool call budget 2 exceeded: 0 already executed in this Run, this batch asks for 3; none of them were run/,
  );
  assert.deepEqual(executed, [], "执行到一半才发现超限就太晚了");
  assert.equal(chat.requests.length, 1);

  const toolMessages = agent.transcript.filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ["c1", "c2", "c3"]);
  assert.ok(toolMessages.every((message) => message.content === "ERROR: not run: tool call budget 2 would be exceeded"));
});

test("工具预算：跨批次累计，超限后不再启动新批次", async () => {
  const chat = createScriptedChat([
    callTool("c1", "echo", { value: "a" }),
    callTool("c2", "echo", { value: "b" }),
    finalReply("done"),
  ]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]), maxToolCalls: 1 });

  await assert.rejects(
    () => agent.run("task"),
    /tool call budget 1 exceeded: 1 already executed in this Run, this batch asks for 1; none of them were run/,
  );
  assert.equal(chat.requests.length, 2);

  const toolMessages = agent.transcript.filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ["c1", "c2"]);
  assert.equal(toolMessages[0].content, "echo a");
  assert.equal(toolMessages[1].content, "ERROR: not run: tool call budget 1 would be exceeded");
});

test("最后一步：模型仍要工具时不执行无法验证的副作用", async () => {
  let ran = 0;
  const tool = {
    ...echoTool(),
    run: async () => {
      ran += 1;
      return "ran";
    },
  };
  const chat = createScriptedChat([callTool("c1", "echo", { value: "x" }), finalReply("done")]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([tool]), maxSteps: 1 });

  await assert.rejects(() => agent.run("task"), /step limit 1 reached after executing 0 tool call\(s\)/);
  assert.equal(ran, 0, "没有后续请求验证的工具不该执行");
  assert.equal(chat.requests.length, 1);
});

test("会话：第二个 Run 继承 transcript，stats 只描述本次 Run", async () => {
  const chat = createScriptedChat([finalReply("first"), finalReply("second")]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([]) });

  await agent.run("first task");
  await agent.run("second task");

  assert.equal(chat.requests.length, 2);
  // 第二次请求能看到第一轮的全部历史：system → user → assistant → 新的 user。
  assert.deepEqual(
    chat.requests[1].messages.map((message) => message.role),
    ["system", "user", "assistant", "user"],
  );
  assert.equal(agent.stats.requests, 1, "stats 是本次 Run 的账");
  assert.equal(agent.sessionStats.runs, 2);
  assert.equal(agent.sessionStats.requests, 2);
  assert.equal(agent.transcript.length, 5);
});

test("会话：预算按 Run 重新计算，第二轮不继承第一轮的花费", async () => {
  const chat = createScriptedChat([
    callTool("c1", "echo", { value: "a" }),
    finalReply("first"),
    callTool("c2", "echo", { value: "b" }),
    finalReply("second"),
  ]);
  // 一次 Run 只允许一个工具：第二轮如果继承了第一轮的计数，这里就会抛错。
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]), maxToolCalls: 1 });

  await agent.run("one");
  await agent.run("two");

  assert.equal(agent.stats.toolCalls, 1);
  assert.equal(agent.sessionStats.toolCalls, 2);
});

test("会话：token 预算也只算本次 Run", async () => {
  const usage = { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 };
  const chat = createScriptedChat([
    { message: finalReply("first"), usage },
    { message: finalReply("second"), usage },
  ]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([]), maxTotalTokens: 100 });

  await agent.run("one");
  await agent.run("two");

  assert.equal(agent.stats.usage.totalTokens, 70);
  assert.equal(agent.sessionStats.usage.totalTokens, 140);
  assert.equal(agent.stats.tokenBudget.exceeded, false);
});

test("生命周期：并发 run() 时后一个立刻被拒绝", async () => {
  const chat = createScriptedChat([finalReply("ok")]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([]) });

  const first = agent.run("first");
  const second = agent.run("second");

  await assert.rejects(second, /already running/);
  await first;
  assert.equal(chat.requests.length, 1);
});

test("生命周期：任务失败后会话还能继续，失败的历史留在 transcript 里", async () => {
  const chat = createScriptedChat([finalReply("   "), finalReply("recovered")]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([]) });

  await assert.rejects(() => agent.run("fail"), /empty final answer/);
  const failedLength = agent.transcript.length;

  const reply = await agent.run("retry");
  assert.equal(reply.content, "recovered");
  assert.equal(agent.transcript.length > failedLength, true);
  assert.equal(agent.sessionStats.runs, 2);
});

test("token 统计：累计 prompt / completion / total 与请求数", async () => {
  const chat = createScriptedChat([
    {
      message: callTool("c1", "echo", { value: "a" }),
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    },
    {
      message: finalReply("done"),
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    },
  ]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]) });

  await agent.run("task");

  assert.deepEqual(agent.stats, {
    requests: 2,
    toolCalls: 1,
    usage: { promptTokens: 150, completionTokens: 15, totalTokens: 165, reported: 2, unknown: 0 },
    tokenBudget: { limit: undefined, exceeded: false },
  });
});

test("token 统计：usage 缺失时标记 unknown，不补 0", async () => {
  const chat = createScriptedChat([
    {
      message: callTool("c1", "echo", { value: "a" }),
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    },
    finalReply("done"),
  ]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]) });

  await agent.run("task");

  assert.equal(agent.stats.usage.totalTokens, 11);
  assert.equal(agent.stats.usage.reported, 1);
  assert.equal(agent.stats.usage.unknown, 1, "缺 usage 的那一轮必须单独计数");
});

test("token 预算：已知合计达到上限时不再发请求，也不执行未验证的工具", async () => {
  const chat = createScriptedChat([
    {
      message: callTool("c1", "echo", { value: "a" }),
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
    },
    finalReply("should not happen"),
  ]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]), maxTotalTokens: 100 });

  await assert.rejects(
    () => agent.run("task"),
    /token budget 100 reached: 100 tokens counted over 1 request\(s\) with usage/,
  );
  assert.equal(chat.requests.length, 1);
  const toolMessage = agent.transcript.filter((message) => message.role === "tool").at(-1);
  assert.equal(toolMessage.content, "ERROR: not run: token budget 100 reached");
});

test("token 预算：usage 未知时只声称「已统计到多少」", async () => {
  const chat = createScriptedChat([
    callTool("c1", "echo", { value: "a" }),
    {
      message: callTool("c2", "echo", { value: "b" }),
      usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
    },
  ]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([echoTool()]), maxTotalTokens: 100 });

  await assert.rejects(
    () => agent.run("task"),
    /token budget 100 reached: at least 100 tokens counted over 1 request\(s\) with usage; 1 request\(s\) have no usage/,
  );
  assert.equal(agent.stats.usage.unknown, 1);
  assert.equal(agent.stats.tokenBudget.exceeded, true);
});

test("token 预算：软预算 —— 最终答复顶穿上限时仍返回成功，但状态可见", async () => {
  const chat = createScriptedChat([
    {
      message: finalReply("done"),
      usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
    },
  ]);
  const agent = new Agent({ llm: chat, tools: makeRegistry([]), maxTotalTokens: 100 });

  const reply = await agent.run("task");

  assert.equal(reply.content, "done");
  assert.equal(chat.requests.length, 1);
  assert.deepEqual(agent.stats.tokenBudget, { limit: 100, exceeded: true });
});

test("token 统计：请求失败但带回 usage 时也要记账", async () => {
  const llm = {
    async chat() {
      throw new ChatResponseError("invalid response", {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
      });
    },
  };
  const agent = new Agent({ llm, tools: makeRegistry([]) });

  await assert.rejects(() => agent.run("task"), /invalid response/);
  assert.equal(agent.stats.requests, 1);
  assert.deepEqual(agent.stats.usage, {
    promptTokens: 7,
    completionTokens: 3,
    totalTokens: 10,
    reported: 1,
    unknown: 0,
  });
});

test("token 统计：请求失败且没有 usage 时记为未知，不丢账", async () => {
  const llm = {
    async chat() {
      throw new Error("network down");
    },
  };
  const agent = new Agent({ llm, tools: makeRegistry([]) });

  await assert.rejects(() => agent.run("task"), /network down/);
  assert.equal(agent.stats.requests, 1);
  assert.equal(agent.stats.usage.reported, 0);
  assert.equal(agent.stats.usage.unknown, 1);
  assert.equal(agent.stats.usage.totalTokens, 0);
});

test("系统提示词：关键歧义可以问，禁止编造验证结果，shell 一次一条", () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /Ask when an ambiguity affects correctness/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Never claim to have run a command or test that you did not run/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Run one shell command per call with simple syntax/);
  assert.equal(DEFAULT_SYSTEM_PROMPT.includes("Do not ask questions"), false);
});

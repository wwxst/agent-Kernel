/**
 * 文件目的：测工具执行的三个 Hook 事件 —— 它们存在的理由是「所有工具自动经过、Hook 坏了也不影响工具」，
 * 所以两件事必须在这里钉死：每个事件在什么时候触发、Hook 自己出事时工具结果还能不能保持原样。
 *
 * 文件职责：`ToolRegistry.execute` 这处缝上的 Hook 行为，外加一次真实 Run 的集成检查。
 * 不测具体工具实现（`workspace.test.mjs`）、不测参数校验本身（`tool-registry.test.mjs`）。
 *
 * 内容目录：
 *   - 基本顺序：成功时 Pre → Post；失败时 Pre → PostToolUseFailure；多个 Hook 按登记顺序；异步 Hook 被等待。
 *   - 上下文：拿到工具名、参数、结果、原始错误；拿到的是副本，改不动真实调用。
 *   - 阻止：返回 `{ block }` 后工具不执行、结果是带原因的 `ERROR` 文本、后面的前置 Hook 不再跑；
 *     原因写空、写 `false` 时怎么判定。
 *   - 故障隔离：Hook 同步抛错、返回 rejected Promise、决定字段 getter 抛错、上下文复制失败、工具也失败时，
 *     结果与错误文本都不变，只记失败次数。
 *   - 边界：未知工具、坏 JSON、参数不合法不触发任何事件；`ProcessCleanupError` 先通知再照旧抛出；
 *     没有登记 Hook 时行为与以前一致。
 *   - 接入面：九个内置工具全部经过同一个入口；一次完整 `Agent.run` 的 Transcript 不受 Hook 影响。
 *   - 真实 shell：非零退出只走 `PostToolUseFailure`，错误消息就是未改动的结果原文；成功只走 `PostToolUse`。
 *
 * 模块关系：依赖 `src/core/tool-hooks.ts`、`src/core/tool-registry.ts`、`src/tools/workspace.ts`、
 * `src/protocol/errors.ts`、`test/support/harness.mjs` 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/core/agent.ts";
import { ToolHooks } from "../src/core/tool-hooks.ts";
import { ToolRegistry } from "../src/core/tool-registry.ts";
import { ProcessCleanupError } from "../src/protocol/errors.ts";
import { Workspace, createWorkspaceTools } from "../src/tools/workspace.ts";
import { callTool, createScriptedChat, echoTool, finalReply, withWorkspace } from "./support/harness.mjs";

/** 构造一次工具调用（ToolCall 的线上形状）。 */
function call(name, args = {}, id = "call_1") {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("安全性：前置 Hook 的决定读取异常时 fail-closed，不执行工具或后续 Hook", async () => {
  let ran = false;
  let later = false;
  const hooks = new ToolHooks({ preToolUse: [
    () => ({ get block() { throw new Error("bad decision"); } }),
    () => { later = true; },
  ] });
  const registry = new ToolRegistry([{
    ...echoTool(), run: async () => { ran = true; return "should not run"; },
  }], hooks);
  assert.equal(await registry.execute(call("echo", { value: "hi" })),
    'ERROR: tool "echo" blocked by hook: pre-tool hook failed; execution blocked');
  assert.equal(ran, false);
  assert.equal(later, false);
  assert.equal(hooks.failureCount, 1);
});

/** 一个总是失败的假工具，用来验证失败事件。 */
function failingTool(message = "disk on fire") {
  return {
    name: "boom",
    description: "Always fails.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      throw new Error(message);
    },
  };
}

test("成功：Pre 在工具执行前、Post 在之后，各触发一次并拿到结果", async () => {
  const events = [];
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [(context) => {
      events.push(["pre", context.call.function.name, context.args.value]);
    }],
    postToolUse: [(context) => {
      events.push(["post", context.call.function.name, context.result]);
    }],
  }));

  const result = await registry.execute(call("echo", { value: "hi" }));

  assert.equal(result, "echo hi");
  assert.deepEqual(events, [["pre", "echo", "hi"], ["post", "echo", "echo hi"]]);
});

test("失败：Pre 之后触发 PostToolUseFailure，拿到的是原始错误对象", async () => {
  const events = [];
  let failureContext;
  const registry = new ToolRegistry([failingTool()], new ToolHooks({
    preToolUse: [() => {
      events.push("pre");
    }],
    postToolUse: [() => {
      events.push("post");
    }],
    postToolUseFailure: [(context) => {
      events.push("failure");
      failureContext = context;
    }],
  }));

  const result = await registry.execute(call("boom"));

  assert.equal(result, "ERROR: disk on fire");
  assert.deepEqual(events, ["pre", "failure"], "失败时不该触发 PostToolUse");
  // Hook 的异常会被有意隔离；断言放在回调外，否则上下文错了也可能被当作 Hook 故障吞掉。
  assert.ok(failureContext.error instanceof Error);
  assert.equal(failureContext.error.message, "disk on fire");
  assert.equal(failureContext.call.function.name, "boom");
});

test("多个 Hook 按登记顺序执行：先登记的先跑", async () => {
  const order = [];
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [
      () => {
        order.push("pre-1");
      },
      () => {
        order.push("pre-2");
      },
    ],
    postToolUse: [
      () => {
        order.push("post-1");
      },
      () => {
        order.push("post-2");
      },
    ],
  }));

  await registry.execute(call("echo", { value: "hi" }));

  assert.deepEqual(order, ["pre-1", "pre-2", "post-1", "post-2"]);
});

test("异步 Hook 会被等待：慢 Hook 跑完才轮到下一个", async () => {
  const order = [];
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("slow");
      },
      () => {
        order.push("fast");
      },
    ],
    postToolUse: [async () => {
      await Promise.resolve();
      order.push("post");
    }],
  }));

  await registry.execute(call("echo", { value: "hi" }));

  assert.deepEqual(order, ["slow", "fast", "post"]);
});

test("PreToolUse 返回 block：工具不执行，结果是带原因的 ERROR 文本", async () => {
  let ran = false;
  const registry = new ToolRegistry([{
    name: "echo",
    description: "Runs only if nothing blocks it.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    run: async () => {
      ran = true;
      return "echo hi";
    },
  }], new ToolHooks({
    preToolUse: [() => ({ block: "this command is not allowed here" })],
  }));

  const result = await registry.execute(call("echo", { value: "hi" }));

  assert.equal(result, 'ERROR: tool "echo" blocked by hook: this command is not allowed here');
  assert.equal(ran, false, "被拦下的调用不能真的执行");
});

test("阻止后整条链停下：后面的前置 Hook 与两个后置事件都不触发", async () => {
  const order = [];
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [
      () => {
        order.push("first");
        return { block: "stop" };
      },
      () => {
        order.push("second");
      },
    ],
    postToolUse: [() => order.push("post")],
    postToolUseFailure: [() => order.push("failure")],
  }));

  await registry.execute(call("echo", { value: "hi" }));

  assert.deepEqual(order, ["first"]);
});

test("阻止原因写空也照样拦：兜底文案非空，不让模型读到一个空 ERROR", async () => {
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [() => ({ block: "   " })],
  }));

  const result = await registry.execute(call("echo", { value: "hi" }));

  assert.equal(result, 'ERROR: tool "echo" blocked by hook: blocked by hook (no reason given)');
});

test("返回 block:false 或不返回任何东西都算放行", async () => {
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [
      () => ({ block: false }),
      () => {},
    ],
  }));

  assert.equal(await registry.execute(call("echo", { value: "hi" })), "echo hi");
});

test("Hook 同步抛错：前置失败阻止工具，后置失败仍隔离", async () => {
  const hooks = new ToolHooks({
    preToolUse: [() => {
      throw new Error("pre hook failed");
    }],
    postToolUse: [() => {
      throw new Error("post hook failed");
    }],
  });
  const registry = new ToolRegistry([echoTool()], hooks);

  assert.equal(await registry.execute(call("echo", { value: "hi" })),
    'ERROR: tool "echo" blocked by hook: pre-tool hook failed; execution blocked');
  assert.equal(hooks.failureCount, 1, "前置 Hook 失败即短路，后置 Hook 不运行");
});

test("Hook 返回 rejected Promise：前置失败阻止工具", async () => {
  const hooks = new ToolHooks({
    preToolUse: [async () => {
      throw new Error("async pre failed");
    }],
    postToolUse: [async () => {
      throw new Error("async post failed");
    }],
  });
  const registry = new ToolRegistry([echoTool()], hooks);

  assert.equal(await registry.execute(call("echo", { value: "hi" })),
    'ERROR: tool "echo" blocked by hook: pre-tool hook failed; execution blocked');
  assert.equal(hooks.failureCount, 1);
});

test("Hook 抛错时工具也失败：ERROR 文本仍是工具自己的原因", async () => {
  const hooks = new ToolHooks({
    postToolUseFailure: [() => {
      throw new Error("hook exploded");
    }],
  });
  const registry = new ToolRegistry([failingTool("disk on fire")], hooks);

  assert.equal(await registry.execute(call("boom")), "ERROR: disk on fire");
  assert.equal(hooks.failureCount, 1);
});

test("Hook 拿到的是副本：改参数、改工具名都影响不到真实执行", async () => {
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [(context) => {
      context.args.value = "hacked";
      context.call.function.name = "other";
    }],
  }));

  assert.equal(await registry.execute(call("echo", { value: "real" })), "echo real");
});

test("没有执行就没有事件：未知工具、坏 JSON、参数不合法都不触发 Hook", async () => {
  const events = [];
  const record = (context) => {
    events.push(context.call.function.name);
  };
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [record],
    postToolUse: [record],
    postToolUseFailure: [record],
  }));

  assert.match(await registry.execute(call("nope")), /^ERROR: unknown tool/);
  assert.match(
    await registry.execute({ id: "c2", type: "function", function: { name: "echo", arguments: "{oops" } }),
    /^ERROR: invalid JSON arguments/,
  );
  assert.match(await registry.execute(call("echo", {})), /^ERROR: invalid arguments/);

  assert.deepEqual(events, [], "校验没过等于没执行，不能假装工具开始过");
});

test("ProcessCleanupError：先触发失败事件，异常照旧抛出", async () => {
  const seen = [];
  const registry = new ToolRegistry([{
    name: "shell",
    description: "Cleanup cannot be verified.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      throw new ProcessCleanupError("cleanup unverified");
    },
  }], new ToolHooks({
    postToolUseFailure: [(context) => {
      seen.push(context.error);
    }],
  }));

  await assert.rejects(() => registry.execute(call("shell")), ProcessCleanupError);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof ProcessCleanupError, "Hook 看到的必须是原始错误，不是折过的文本");
});

test("不登记 Hook：行为与以前一致，失败计数为 0", async () => {
  const hooks = new ToolHooks();
  const registry = new ToolRegistry([echoTool(), failingTool()], hooks);

  assert.equal(await registry.execute(call("echo", { value: "hi" })), "echo hi");
  assert.equal(await registry.execute(call("boom")), "ERROR: disk on fire");
  assert.equal(hooks.failureCount, 0);
});

test("九个内置工具全部经过同一个入口：每个都触发一次 Pre 和一次 Post", async () => {
  await withWorkspace(async (dir) => {
    const seen = [];
    const hooks = new ToolHooks({
      preToolUse: [(context) => {
        seen.push(`pre ${context.call.function.name}`);
      }],
      postToolUse: [(context) => {
        seen.push(`post ${context.call.function.name}`);
      }],
    });
    const registry = new ToolRegistry(createWorkspaceTools(new Workspace({ root: dir })), hooks);

    const steps = [
      ["write", { path: "a.txt", content: "hello\n" }],
      ["read", { path: "a.txt" }],
      ["edit", { path: "a.txt", old_string: "hello", new_string: "hi" }],
      ["glob", { pattern: "**/*.txt" }],
      ["grep", { pattern: "hi" }],
      ["ls", { path: "." }],
      ["shell", { command: "echo hi" }],
    ];
    for (const [name, args] of steps) {
      const result = await registry.execute(call(name, args));
      assert.doesNotMatch(result, /^ERROR:/, `${name} 不该失败：${result}`);
    }

    // 后台三件套必须连着跑：编号从 shell 的结果里拿，另外两个工具都靠它。
    const started = await registry.execute(
      call("shell", { command: 'node -e "setInterval(()=>{},1000)"', background: true }),
    );
    const jobId = /started (job-\d+)/.exec(started)?.[1];
    assert.ok(jobId, `后台任务应该返回编号：${started}`);
    await registry.execute(call("shell-output", { job_id: jobId }));
    await registry.execute(call("shell-kill", { job_id: jobId }));

    assert.deepEqual(seen, [
      "pre write", "post write",
      "pre read", "post read",
      "pre edit", "post edit",
      "pre glob", "post glob",
      "pre grep", "post grep",
      "pre ls", "post ls",
      "pre shell", "post shell",
      "pre shell", "post shell",
      "pre shell-output", "post shell-output",
      "pre shell-kill", "post shell-kill",
    ]);
  });
});

test("真实 shell：非零退出只触发 PostToolUseFailure，成功命令只触发 PostToolUse", async () => {
  await withWorkspace(async (dir) => {
    const events = [];
    let failureContext;
    const registry = new ToolRegistry(createWorkspaceTools(new Workspace({ root: dir })), new ToolHooks({
      postToolUse: [(context) => {
        events.push(["post", context.call.function.name, context.result]);
      }],
      postToolUseFailure: [(context) => {
        events.push(["failure", context.call.function.name]);
        failureContext = context;
      }],
    }));

    const failed = await registry.executeWithStatus(call("shell", {
      command: `node -e "console.log('boom'); process.exitCode = 3"`,
    }));
    assert.equal(failed.isError, true);
    assert.ok(failed.content.startsWith("exit 3"), failed.content);

    const ok = await registry.executeWithStatus(call("shell", { command: "echo ok" }));
    assert.equal(ok.isError, false);

    assert.deepEqual(events, [["failure", "shell"], ["post", "shell", ok.content]]);
    // 结构化失败没有原始异常对象：Hook 拿到的是用结果原文合成的 Error，原文一字不改。
    assert.ok(failureContext.error instanceof Error);
    assert.equal(failureContext.error.message, failed.content);
    assert.equal(failed.content.split("\n")[1], "boom");
  });
});

test("一次完整 Run：Hook 正常触发，Transcript 与工具结果一字不改", async () => {
  const events = [];
  const chat = createScriptedChat([callTool("c1", "echo", { value: "a" }), finalReply("done")]);
  const registry = new ToolRegistry([echoTool()], new ToolHooks({
    preToolUse: [() => {
      events.push("pre");
    }],
    postToolUse: [(context) => {
      events.push(context.result);
    }],
  }));

  const reply = await new Agent({ llm: chat, tools: registry }).run("do it");

  assert.equal(reply.content, "done");
  assert.deepEqual(events, ["pre", "echo a"]);
  assert.deepEqual(
    chat.requests[1].messages.filter((message) => message.role === "tool")
      .map((message) => [message.tool_call_id, message.content]),
    [["c1", "echo a"]],
  );
});

/**
 * 构造「JSON 能解析、structuredClone 会爆栈」的参数：额外塞一条 3000 层嵌套的未声明字段。
 *
 * 直接拼 JSON 文本，不经过 `JSON.stringify`：这个深度上某些 Node 版本（Windows + Node 22）
 * 会先在 `JSON.stringify` 里爆栈，用例就变成在测序列化而不是测 Hook 的副本。
 * 3000 层是实测值：`JSON.parse` 接受，`structuredClone` 抛 RangeError: Maximum call stack size exceeded。
 * 未声明字段默认被忽略（没开 strictArguments），所以工具能正常执行 —— 差别只在 Hook 的副本。
 */
function deepToolCall(id, name) {
  const depth = 3000;
  const args = '{"extra":' + '{"next":'.repeat(depth) + '"leaf"' + '}'.repeat(depth) + '}';
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

test("一次完整 Run：后置 Hook 的上下文复制失败不改变工具结果，Transcript 配对完整", async () => {
  let sideEffects = 0;
  const notifications = [];
  const hooks = new ToolHooks({
    postToolUse: [
      () => {
        notifications.push("post-1");
      },
      () => {
        notifications.push("post-2");
      },
    ],
  });
  const registry = new ToolRegistry([{
    name: "touch",
    description: "Records one side effect.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      sideEffects++;
      return "side effect done";
    },
  }], hooks);
  const chat = createScriptedChat([deepToolCall("c1", "touch"), finalReply("done")]);
  const agent = new Agent({ llm: chat, tools: registry });

  const reply = await agent.run("do it");

  assert.equal(reply.content, "done");
  assert.equal(sideEffects, 1, "工具已经跑过且只跑一次");
  assert.deepEqual(notifications, [], "上下文复制失败时后置 Hook 拿不到上下文");
  assert.equal(hooks.failureCount, 2, "两个后置 Hook 的复制失败各记一次");
  const messages = agent.transcript;
  const assistantCall = messages.find((message) => message.role === "assistant" && message.tool_calls?.length > 0);
  const toolResult = messages.find((message) => message.role === "tool");
  assert.ok(assistantCall, "Transcript 里应有发起工具调用的 assistant 消息");
  assert.ok(toolResult, "Transcript 里应有配对的工具结果");
  assert.equal(toolResult.tool_call_id, assistantCall.tool_calls[0].id);
  assert.equal(toolResult.content, "side effect done");
});

test("失败 Run：失败 Hook 的上下文复制失败不外泄，isError 结果原样保留", async () => {
  let sideEffects = 0;
  const notifications = [];
  const observed = [];
  const hooks = new ToolHooks({
    postToolUseFailure: [(context) => {
      notifications.push(context.error);
    }],
  });
  const registry = new ToolRegistry([{
    name: "touch",
    description: "Fails after one side effect.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      sideEffects++;
      return { content: "ERROR: tool failed", isError: true };
    },
  }], hooks);
  const chat = createScriptedChat([deepToolCall("c1", "touch"), finalReply("done")]);
  const agent = new Agent({
    llm: chat,
    tools: registry,
    onToolResult: (call, content, isError) => {
      observed.push([call.id, content, isError]);
    },
  });

  const reply = await agent.run("do it");

  assert.equal(reply.content, "done");
  assert.equal(sideEffects, 1, "工具已经跑过且只跑一次");
  assert.deepEqual(notifications, [], "上下文复制失败时失败 Hook 拿不到通知");
  assert.equal(hooks.failureCount, 1);
  const messages = agent.transcript;
  const assistantCall = messages.find((message) => message.role === "assistant" && message.tool_calls?.length > 0);
  const toolResult = messages.find((message) => message.role === "tool");
  assert.ok(assistantCall, "Transcript 里应有发起工具调用的 assistant 消息");
  assert.ok(toolResult, "工具结果必须留在 Transcript 里");
  assert.equal(toolResult.tool_call_id, assistantCall.tool_calls[0].id);
  assert.equal(toolResult.content, "ERROR: tool failed");
  assert.deepEqual(observed, [["c1", "ERROR: tool failed", true]], "宿主侧看到的仍是 isError 结果");
});

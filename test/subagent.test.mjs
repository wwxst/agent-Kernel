/**
 * 文件目的：钉住「主 Agent 委派一件子任务」这一层的外部行为 —— 参数怎么校验、
 * 结果怎么排版、角色能拿哪些工具、子 Agent 的上下文为什么不会串味。
 *
 * 为什么单独一个文件：委派是第六课新增的一条缝，它同时碰工具、上下文、预算和进程安全，
 * 塞进 `agent.test.mjs` 会让那个文件既讲循环又讲委派，出事时不知道该看哪。
 *
 * 文件职责：`src/tools/subagent.ts` 这一处缝 —— 参数校验、结果格式（完成/失败/取消/截断）、
 * 两种角色的工具清单、Worker 的 shell 是否真的只能前台、进程清理未确认时必须抛错，
 * 以及用真实 `Agent` 跑一次委派时上下文与结果条数是否正确。
 * 不测 `cli.ts` 的装配（那是 `cli.test.mjs` 的端到端用例），不测循环与工具执行（各有单元测试）。
 *
 * 内容目录：
 *   - 夹具：`subagentStats()` 造统计、`toolCall()` 造调用、`registryWith()` 装一个只有委派工具的注册表。
 *   - 参数校验：空任务、超长任务、非法 mode、默认 explore、任务首尾空白。
 *   - 结果格式：完成带统计、失败带「不回滚」提醒、取消、预算提示、超长截断。
 *   - 角色工具：Explorer 只有四个只读工具；Worker 多出写/改/shell/todo_write，且 shell 没有 background。
 *   - 上下文隔离：子 Agent 第一次请求只有自己的 system 与任务；两次委派互不可见。
 *   - 预算、失败与取消：子 Agent 到步数/token 上限就停，失败不伪装成功，共用 signal 取消后不再发请求。
 *   - 委派状态：完成/失败/取消分别映射到 `isError`，失败走 `PostToolUseFailure`、工具日志记 `ok:false`。
 *   - 进程安全：进程树未确认时抛 `ProcessCleanupError`，不被折成普通失败文本。
 *
 * 模块关系：依赖 `src/core/agent.ts`（真实 Agent）、`src/core/tool-registry.ts`、
 * `src/core/tool-hooks.ts` 与 `src/core/tool-log.ts`（验证失败状态真的传下去）、
 * `src/tools/subagent.ts`、`src/tools/workspace.ts`、`src/protocol/errors.ts`，
 * 以及 `test/support/harness.mjs` 的假模型与临时工作区。由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../src/core/agent.ts";
import { ToolHooks } from "../src/core/tool-hooks.ts";
import { createToolLogHooks } from "../src/core/tool-log.ts";
import { ToolRegistry } from "../src/core/tool-registry.ts";
import { isToolResultFailure } from "../src/core/tool-result-status.ts";
import { ProcessCleanupError } from "../src/protocol/errors.ts";
import { Workspace, createWorkspaceTools } from "../src/tools/workspace.ts";
import {
  DEFAULT_SUBAGENT_MODE,
  SUBAGENT_GUIDANCE,
  SUBAGENT_RESULT_MAX_CHARS,
  SUBAGENT_TASK_MAX_CHARS,
  WORKER_SUBAGENT_GUIDANCE,
  createExplorerSystemPrompt,
  createSubagentTool,
  formatSubagentResult,
  subagentWorkspaceContext,
  throwIfProcessesUnverified,
  toolsForSubagentRole,
} from "../src/tools/subagent.ts";
import { callTool, createScriptedChat, echoTool, finalReply, withWorkspace } from "./support/harness.mjs";

/** 一份完整的子 Agent 统计；用例只覆盖自己关心的字段。 */
function subagentStats(overrides = {}) {
  return {
    mode: "explore",
    requests: 2,
    toolCalls: 1,
    tokens: 1200,
    unknownUsage: 0,
    budgetExceeded: false,
    ...overrides,
  };
}

/** 一次 `run_subagent` 调用；id 默认固定，便于断言 tool_call_id 配对。 */
function subagentCall(args, id = "call-sub") {
  return {
    id,
    type: "function",
    function: { name: "run_subagent", arguments: JSON.stringify(args) },
  };
}

/** 只装委派工具的注册表：参数校验与「失败折成文本」都由它统一处理。 */
function registryWith(runSubagent) {
  return new ToolRegistry([createSubagentTool(runSubagent)]);
}

test("委派参数：空任务被拒绝，不会创建一个没有任务的子 Agent", async () => {
  let called = 0;
  const registry = registryWith(async () => {
    called++;
    return { status: "completed", content: "should not run", stats: subagentStats() };
  });

  const empty = await registry.execute(subagentCall({ task: "   " }));
  assert.match(empty, /^ERROR: task must not be empty/);
  const missing = await registry.execute(subagentCall({ mode: "explore" }));
  assert.match(missing, /^ERROR: invalid arguments: missing required argument "task"/);
  assert.equal(called, 0, "参数不合法时不能真的去跑子 Agent");
});

test("委派参数：任务超过 8000 字符被拒绝，并说出上限和实际长度", async () => {
  const registry = registryWith(async () => ({ status: "completed", content: "unused", stats: subagentStats() }));
  const tooLong = "x".repeat(SUBAGENT_TASK_MAX_CHARS + 1);

  const result = await registry.execute(subagentCall({ task: tooLong }));
  assert.match(result, /^ERROR: task must be at most 8000 characters, got 8001/);
});

test("委派参数：mode 只接受 explore 与 execute，默认是 explore", async () => {
  const seen = [];
  const registry = registryWith(async (request) => {
    seen.push(request);
    return { status: "completed", content: "ok", stats: subagentStats() };
  });

  const bad = await registry.execute(subagentCall({ task: "look around", mode: "review" }));
  assert.match(bad, /^ERROR: mode must be "explore" or "execute", got "review"/);
  assert.equal(seen.length, 0);

  await registry.execute(subagentCall({ task: "  look around  " }));
  await registry.execute(subagentCall({ task: "change a file", mode: "execute" }));

  assert.equal(DEFAULT_SUBAGENT_MODE, "explore");
  assert.deepEqual(seen, [
    { task: "look around", mode: "explore" },
    { task: "change a file", mode: "execute" },
  ]);
});

test("委派结果：完成时带统计，正文就是子 Agent 的最终报告", () => {
  const text = formatSubagentResult({
    status: "completed",
    content: "auth lives in src/auth/index.ts",
    stats: subagentStats({ mode: "explore", requests: 4, toolCalls: 3, tokens: 12000 }),
  });

  assert.match(text, /^\[Subagent completed\]/);
  assert.match(text, /mode: explore/);
  assert.match(text, /requests: 4/);
  assert.match(text, /tool_calls: 3/);
  assert.match(text, /tokens: 12000/);
  assert.match(text, /unknown_usage: 0/);
  assert.match(text, /Final report:\nauth lives in src\/auth\/index\.ts$/);
});

test("委派结果：失败说清原因，并提醒已改的文件不会自动回滚", () => {
  const text = formatSubagentResult({
    status: "failed",
    reason: "step limit 20 reached after executing 19 tool call(s)",
    stats: subagentStats({ mode: "execute", requests: 20, toolCalls: 19 }),
  });

  assert.match(text, /^\[Subagent failed\]/);
  assert.match(text, /mode: execute/);
  assert.match(text, /reason: step limit 20 reached/);
  assert.match(text, /does not roll back the file changes it already made/);
  assert.doesNotMatch(text, /\[Subagent completed\]/);
});

test("委派结果：取消明确写成取消，不留一份假报告", () => {
  const text = formatSubagentResult({
    status: "cancelled",
    reason: "cancelled: received SIGINT",
    stats: subagentStats({ requests: 1, toolCalls: 0 }),
  });

  assert.match(text, /^\[Subagent cancelled\]/);
  assert.match(text, /reason: cancelled: received SIGINT/);
  assert.match(text, /produced no complete final report/);
});

test("委派结果：预算顶穿但仍完成时给出提示，usage 缺失时不把已统计的说成全部", () => {
  const text = formatSubagentResult({
    status: "completed",
    content: "partial but useful",
    stats: subagentStats({ tokens: 100000, unknownUsage: 2, budgetExceeded: true }),
  });

  assert.match(text, /tokens: 100000/);
  assert.match(text, /unknown_usage: 2/);
  assert.match(text, /reached its token budget/);
});

test("委派结果：超长报告被截断，并写明丢了多少字符", () => {
  const long = "A".repeat(SUBAGENT_RESULT_MAX_CHARS + 500);
  const text = formatSubagentResult({
    status: "completed",
    content: long,
    stats: subagentStats(),
  });

  assert.ok(text.length < long.length, "截断之后必须比原文短");
  assert.match(text, /\[\.\.\. subagent result truncated: 500 chars omitted\]$/);
  // 标记本身不能伪装成「原文就长这样」：前面必须是真正的正文开头。
  assert.match(text, /Final report:\nAAAA/);
});

test("委派结果：截断点落在代理对中间时不留半个字符", () => {
  // 前面加 1 个字符，让 12000 这个偶数上限正好切在一个 emoji 的两个代码单元之间。
  const content = "x" + "😀".repeat(SUBAGENT_RESULT_MAX_CHARS);
  const text = formatSubagentResult({ status: "completed", content, stats: subagentStats() });
  const body = text.split("Final report:\n")[1].split("\n\n[... subagent")[0];

  // 孤立的高位代理编码成 UTF-8 会变成替换字符：模型读到的是一段坏掉的正文。
  assert.doesNotMatch(body, /[\uD800-\uDBFF]$/, "截断不能停在半个 emoji 上");
  // 少一个代码单元是可以接受的代价，但「丢了多少」必须如实算进去。
  assert.match(text, /subagent result truncated: \d+ chars omitted\]$/);
});

test("角色工具：Explorer 只有四个只读工具，Worker 多出写、改、前台 shell", async () => {
  await withWorkspace(async (root) => {
    const all = createWorkspaceTools(new Workspace({ root }));

    assert.deepEqual(
      toolsForSubagentRole(all, "explore").map((tool) => tool.name),
      ["read", "glob", "grep", "ls"],
    );
    assert.deepEqual(
      toolsForSubagentRole(all, "execute").map((tool) => tool.name),
      ["read", "write", "edit", "glob", "grep", "ls", "shell"],
    );
    // 两种角色都没有 run_subagent：子 Agent 不能再往下委派。
    for (const mode of ["explore", "execute"]) {
      assert.ok(!toolsForSubagentRole(all, mode).some((tool) => tool.name === "run_subagent"));
    }
  });
});

test("角色工具：Worker 的 shell 拿掉了 background，传了也按前台执行", async () => {
  await withWorkspace(async (root) => {
    const registry = new ToolRegistry(toolsForSubagentRole(createWorkspaceTools(new Workspace({ root })), "execute"));
    const shell = registry.definitions.find((tool) => tool.name === "shell");

    assert.equal(Object.hasOwn(shell.parameters.properties, "background"), false);
    assert.doesNotMatch(shell.description, /background/i);
    // 只删 background：timeout 参数还在 Schema 里，说明书就不能假装它不存在，
    // 否则模型不知道慢构建、慢测试可以把超时调长，只会把「等超时」当成失败。
    assert.equal(Object.hasOwn(shell.parameters.properties, "timeout"), true);
    assert.match(shell.description, /timeout/);

    // 模型硬塞 background:true 也只能前台跑完：结果是退出码，不是任务编号。
    const result = await registry.execute({
      id: "call-shell",
      type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command: "echo foreground-only", background: true }) },
    });
    assert.match(result, /^exit 0/);
    assert.match(result, /foreground-only/);
    assert.doesNotMatch(result, /started job-/);
  });
});

test("提示词：Explorer 只描述只读角色与交付物，不给操作步骤", () => {
  const prompt = createExplorerSystemPrompt();

  assert.match(prompt, /^You are an independent exploration subagent/);
  // 角色能力：四个只读工具，不能改文件、不能跑 shell、不能再委派。
  assert.match(prompt, /read-only tools \(read, glob, grep, ls\)/);
  assert.match(prompt, /You cannot modify files, run shell commands, or create another subagent\./);
  // 交付要求：结论 + 依据 + 建议，且只报核实过的。
  assert.match(prompt, /Return your conclusion, the key evidence behind it/);
  // 只读角色绝不能被告知「你可以改文件、跑命令」—— 那是默认编码提示里的话。
  assert.doesNotMatch(prompt, /You may read, create, modify, and delete files/);
  // 工作区路径只在共享函数里写一次；这里再写一份就是白烧 token。
  assert.doesNotMatch(prompt, /The workspace root for this task is/);
  // 不给步骤：不出现「先做什么、再做几次」这类流程规定。
  assert.doesNotMatch(prompt, /Before calling read|at most once|first, then|step \d/i);
});

test("提示词：Worker 保留授权边界，但不规定执行步骤", () => {
  // 安全约束必须留着：提交、推送、合并这类动作要任务明确授权。
  assert.match(WORKER_SUBAGENT_GUIDANCE, /Do not commit, push, merge, rebase, reset, clean, or stash/);
  assert.match(WORKER_SUBAGENT_GUIDANCE, /unless the task explicitly authorizes that exact action/);
  // 自主执行：不需要逐步确认。
  assert.match(WORKER_SUBAGENT_GUIDANCE, /You do not need to ask for step-by-step confirmation/);
  // 不再规定先看 git status、跑哪个测试、重跑几次这类流程。
  assert.doesNotMatch(WORKER_SUBAGENT_GUIDANCE, /git status|git diff --check|narrowest relevant tests/);
});

test("提示词：主 Agent 的委派规矩给判断依据，不给强制流程", () => {
  assert.match(SUBAGENT_GUIDANCE, /Decide yourself when to delegate/);
  // 失败不回滚这条事实必须保留：主 Agent 据此才会自己去查工作区。
  assert.match(SUBAGENT_GUIDANCE, /file changes are not rolled back/);
  // 不强制委派：简单任务自己做。
  assert.match(SUBAGENT_GUIDANCE, /Handle simple or tightly coupled work yourself/);
  // 不再规定「必须默认 explore」「一次只能一个」这类流程条款。
  assert.doesNotMatch(SUBAGENT_GUIDANCE, /Use explore by default|Run only one subagent at a time/);
});

test("提示词：共享的工作区说明带上真实路径，并管住相对路径与范围", () => {
  const root = "D:\\work\\demo";
  const block = subagentWorkspaceContext(root);

  // 路径原样写进去（JSON 转义后），模型才不用猜。
  assert.ok(block.includes(JSON.stringify(root)), `提示里应含 ${JSON.stringify(root)}`);
  assert.match(block, /Resolve relative file paths from this exact directory\./);
  assert.match(block, /Stay within this workspace unless the delegated task explicitly requires an external path\./);
  // 说明只讲行为，不能冒充沙箱。
  assert.doesNotMatch(block, /sandbox|restricted|denied/i);
});

test("上下文隔离：子 Agent 第一次请求只有自己的 system 和自己的任务", async () => {
  const childChat = createScriptedChat([
    callTool("child-1", "echo", { value: "child step" }),
    finalReply("child report"),
  ]);
  const parentChat = createScriptedChat([
    callTool("parent-1", "echo", { value: "parent step" }),
    callTool("call-sub", "run_subagent", { task: "investigate the auth module", mode: "explore" }),
    finalReply("parent done"),
  ]);

  let childTools;
  const parent = new Agent({
    llm: parentChat,
    tools: new ToolRegistry([
      echoTool(),
      createSubagentTool(async (request) => {
        // 每次委派都是新实例：新 messages[]、新注册表、新统计。
        const child = new Agent({
          llm: childChat,
          tools: new ToolRegistry([echoTool()]),
          systemPrompt: "CHILD SYSTEM PROMPT",
        });
        childTools = child;
        const reply = await child.run(request.task);
        return {
          status: "completed",
          content: reply.content,
          stats: subagentStats({ requests: child.stats.requests, toolCalls: child.stats.toolCalls }),
        };
      }),
    ]),
  });

  await parent.run("parent task");

  // 子 Agent 真的跑了多轮、也调了工具 —— 但父 Agent 一条都看不到。
  assert.equal(childChat.requests.length, 2);
  assert.equal(childTools.stats.toolCalls, 1);

  const childFirst = childChat.requests[0].messages;
  assert.deepEqual(childFirst.map((message) => message.role), ["system", "user"]);
  assert.equal(childFirst[0].content, "CHILD SYSTEM PROMPT");
  assert.equal(childFirst[1].content, "investigate the auth module");

  const leaked = JSON.stringify(childFirst);
  assert.doesNotMatch(leaked, /parent task/, "父 Agent 的用户任务不能进子 Agent");
  assert.doesNotMatch(leaked, /parent step/, "父 Agent 的工具调用历史不能进子 Agent");
  assert.doesNotMatch(leaked, /parent-1/, "父 Agent 的 tool_call id 不能进子 Agent");

  // 父 Agent 只收到一条工具结果，不是子 Agent 的完整 Transcript。
  const subResults = parent.transcript.filter(
    (message) => message.role === "tool" && message.tool_call_id === "call-sub",
  );
  assert.equal(subResults.length, 1);
  assert.match(subResults[0].content, /^\[Subagent completed\]/);
  assert.match(subResults[0].content, /child report/);
  assert.doesNotMatch(subResults[0].content, /child step/, "子 Agent 的工具输出不能混进结果");
});

test("生命周期：两次委派各建一个子 Agent，第二次看不到第一次的对话", async () => {
  const chats = [];
  const parentChat = createScriptedChat([
    callTool("call-1", "run_subagent", { task: "first subtask" }),
    callTool("call-2", "run_subagent", { task: "second subtask" }),
    finalReply("both done"),
  ]);

  const parent = new Agent({
    llm: parentChat,
    tools: new ToolRegistry([
      createSubagentTool(async (request) => {
        const chat = createScriptedChat([finalReply(`report for ${request.task}`)]);
        chats.push(chat);
        const child = new Agent({ llm: chat, tools: new ToolRegistry([echoTool()]) });
        const reply = await child.run(request.task);
        return { status: "completed", content: reply.content, stats: subagentStats({ requests: 1, toolCalls: 0 }) };
      }),
    ]),
  });

  await parent.run("parent");

  assert.equal(chats.length, 2, "每次委派都要新建一个子 Agent");
  assert.equal(chats[1].requests[0].messages.length, 2);
  assert.equal(chats[1].requests[0].messages[1].content, "second subtask");
  assert.doesNotMatch(JSON.stringify(chats[1].requests[0].messages), /first subtask/);

  // 顺序执行：两次委派之间没有交叉（子 Agent 是同步跑完才返回的）。
  assert.equal(chats[0].requests.length, 1);
  assert.equal(chats[1].requests.length, 1);
});

test("预算：子 Agent 到步数上限就停，失败不伪装成成功", async () => {
  const chat = createScriptedChat([callTool("loop", "echo", { value: "again" })]);
  const child = new Agent({ llm: chat, tools: new ToolRegistry([echoTool()]), maxSteps: 2 });

  await assert.rejects(child.run("loop forever"), /step limit 2 reached/);
  assert.equal(child.stats.requests, 2, "上限是硬闸门：第 3 次请求不会再发出去");
});

test("预算：子 Agent 的 token 预算顶穿后不再发新请求", async () => {
  const usage = { prompt_tokens: 60, completion_tokens: 60, total_tokens: 120 };
  const chat = createScriptedChat([{ message: callTool("over", "echo", { value: "x" }), usage }]);
  const child = new Agent({ llm: chat, tools: new ToolRegistry([echoTool()]), maxTotalTokens: 100 });

  await assert.rejects(child.run("spend the budget"), /token budget 100 reached/);
  assert.equal(child.stats.tokenBudget.exceeded, true);
  assert.equal(child.stats.usage.totalTokens, 120);
});

test("取消：子 Agent 共用父 Agent 的 signal，取消之后一次请求都不发", async () => {
  const controller = new AbortController();
  const chat = createScriptedChat([finalReply("should not run")]);
  // 父子用同一个 signal，这是「按 Ctrl+C 父子一起停」的实现方式。
  const child = new Agent({ llm: chat, tools: new ToolRegistry([echoTool()]), signal: controller.signal });
  controller.abort(new Error("received SIGINT"));

  await assert.rejects(child.run("do work"), /cancelled: received SIGINT/);
  assert.equal(chat.requests.length, 0, "取消之后不能再发模型请求");
});

test("进程安全：进程树未确认时抛 ProcessCleanupError，不会被折成普通失败文本", async () => {
  // 未确认 → 必须抛；确认过 → 安静放行。
  assert.throws(() => throwIfProcessesUnverified("execute", true), ProcessCleanupError);
  throwIfProcessesUnverified("execute", false);

  const registry = registryWith(async () => {
    throwIfProcessesUnverified("execute", true);
    return { status: "completed", content: "unreachable", stats: subagentStats() };
  });

  // 关键：它必须穿透注册表，而不是变成一条 `ERROR: ...` 让父 Agent 继续干活。
  await assert.rejects(registry.executeWithStatus(subagentCall({ task: "run a command", mode: "execute" })), ProcessCleanupError);
});

// ── 委派状态：失败和取消不能被当成成功 ────────────────────────────────────────
// 为什么要有这组：工具只回一段写着 "[Subagent failed]" 的文本时，注册表一律当成成功，
// Hook 走 PostToolUse、TUI 显示 ✓、工具日志记 ok:true —— 三处都在骗人。

test("委派状态：完成是成功，失败和取消都标记为 isError", async () => {
  const cases = [
    { outcome: { status: "completed", content: "ok", stats: subagentStats() }, isError: false, header: "[Subagent completed]" },
    { outcome: { status: "failed", reason: "step limit 20 reached", stats: subagentStats() }, isError: true, header: "[Subagent failed]" },
    { outcome: { status: "cancelled", reason: "cancelled: SIGINT", stats: subagentStats() }, isError: true, header: "[Subagent cancelled]" },
  ];

  for (const item of cases) {
    const registry = registryWith(async () => item.outcome);
    const result = await registry.executeWithStatus(subagentCall({ task: "do it" }));
    assert.equal(result.isError, item.isError, item.header + " 的 isError 不对");
    // 报告正文照旧保留，状态不是靠正文「暗示」的。
    assert.ok(result.content.startsWith(item.header), "正文应以 " + item.header + " 开头");
  }
});

test("委派状态：失败的委派走 PostToolUseFailure，而不是 PostToolUse", async () => {
  const events = [];
  const hooks = new ToolHooks({
    postToolUse: [() => events.push("PostToolUse")],
    postToolUseFailure: [() => events.push("PostToolUseFailure")],
  });
  const registry = new ToolRegistry([
    createSubagentTool(async () => ({ status: "failed", reason: "budget", stats: subagentStats() })),
  ], hooks);

  await registry.execute(subagentCall({ task: "do it" }));
  assert.deepEqual(events, ["PostToolUseFailure"]);
});

test("委派状态：失败的委派在工具日志里记 ok:false", async () => {
  await withWorkspace(async (root) => {
    const log = path.join(root, "tool-log.jsonl");
    const registry = new ToolRegistry([
      createSubagentTool(async () => ({ status: "failed", reason: "budget", stats: subagentStats() })),
    ], new ToolHooks(createToolLogHooks(log)));

    await registry.execute(subagentCall({ task: "do it" }));

    const record = JSON.parse((await readFile(log, "utf8")).trim());
    assert.equal(record.tool, "run_subagent");
    assert.equal(record.ok, false);
  });
});

test("委派状态：界面判断失败以 isError 为准，不看正文前缀", async () => {
  const registry = registryWith(async () => ({ status: "failed", reason: "budget", stats: subagentStats() }));
  const call = subagentCall({ task: "do it" });
  const result = await registry.executeWithStatus(call);

  // 报告正文不以 "ERROR:" 开头，界面仍必须判成失败 —— 依据是宿主侧的 isError。
  assert.equal(isToolResultFailure(call, result.content, result.isError), true);
  // 修复前就是这个样子：状态丢了，同一段正文被当成成功，界面显示 ✓。
  assert.equal(isToolResultFailure(call, result.content, false), false);
});

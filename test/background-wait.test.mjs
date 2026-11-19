/**
 * 文件目的：把「后台任务等待」这条链按真实装配跑一遍 —— 真的 Workspace、真的 shell 进程、
 * 真的 `createWorkspaceTools` 与 `ToolRegistry`、真的 Agent 循环，只有模型换成按剧本回话的假客户端。
 *
 * 为什么单独一个文件：这条链有三个模块各说一句话，单元测试只能各测一段。
 *   - Workspace 决定「这次读取算不算一次有效等待」；
 *   - 工具把结构化状态翻译成 `isWaiting`；
 *   - Agent 用整批结果决定要不要豁免无进展检测。
 * 任何一段走样，症状都出现在另一段：`wait: 0` 被当成等待，会让重复轮询永远绕开熔断；
 * 有新输出被当成等待，会让真正的进展换到豁免；任务结束仍标等待，会让循环空转到步数上限。
 * 这些症状只有把三段接起来才看得见，所以这里的断言都打在 `Agent.run` 的外部行为上。
 *
 * 文件职责：验证四类状态各自的判定与它们对重复检测的影响 ——
 * 立即返回（`wait: 0`）、真的等待、拿到新输出、任务结束；外加混合工具批次、取消与步数上限。
 * 不负责测读取的增量/截断细节（那是 `workspace.test.mjs`），也不重复 Agent 单元层的签名规范化。
 *
 * 内容目录：
 *   - `createSteppedChat()`：按步骤回放的假模型；每一步可以在「模型被问到之前」先做一件事，
 *     用来在两次轮询之间触发后台任务的输出。
 *   - `createAgent()`：把真实工具表装进 ToolRegistry，再交给 Agent；`onToolCall` 用来数真实执行次数。
 *   - `stopJob()`：finally 里收掉后台进程，失败不盖住真正的断言。
 *   - 用例：`wait: 0` 不豁免 / 有效等待豁免 / 新输出不豁免 / 任务结束不豁免 /
 *     混入普通工具不豁免 / 整批都等待才豁免 / 等待受 maxSteps 约束 / 等待期间取消。
 *
 * 模块关系：依赖 `src/core/agent.ts`、`src/core/tool-registry.ts`、`src/tools/workspace.ts`
 * 与 `test/support/harness.mjs` 的 `callTool` / `finalReply` / `withWorkspace`。
 * 已登记在 `package.json` 的 `test` 脚本里，`npm test` 会跑它。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-registry.ts";
import { createWorkspaceTools, Workspace } from "../src/tools/workspace.ts";
import { callTool, finalReply, withWorkspace } from "./support/harness.mjs";

/** 一个后台任务在测试里最多活这么久：够跑完用例，又不会在失败时留下长命进程。 */
const JOB_LIFETIME_MS = 30_000;

/**
 * 按步骤回放的假模型。
 *
 * 和 `harness.mjs` 的 `createScriptedChat` 的区别只有一个：每一步可以带 `before`，
 * 在返回这条消息之前先跑一段副作用。轮询测试需要「在两次读取之间」放行后台任务，
 * 而这个时机只有模型请求发生的那一刻最稳 —— 不用 sleep 去赌调度。
 */
function createSteppedChat(steps) {
  const requests = [];
  let turn = 0;
  return {
    requests,
    async chat(messages, tools) {
      requests.push(structuredClone({ messages, tools }));
      const step = steps[Math.min(turn++, steps.length - 1)];
      if (step.before !== undefined) await step.before();
      return { message: structuredClone(step.message) };
    },
  };
}

/** 真实工具表 + 真实注册表 + Agent；只有模型是假的。 */
function createAgent(workspace, chat, options = {}) {
  return new Agent({ llm: chat, tools: new ToolRegistry(createWorkspaceTools(workspace)), maxSteps: 12, ...options });
}

/** 起一个不会自己结束的后台任务，给「没有新输出」的场景用。 */
function startIdleJob(workspace) {
  return workspace.run(`node -e "setTimeout(()=>{},${JOB_LIFETIME_MS})"`, { background: true });
}

/** 等 go.txt 出现才打一行然后退出；测试用 `before` 放行，避免靠时间窗口。 */
function startTriggeredJob(workspace, line) {
  const script = [
    "const fs=require('fs')",
    `const t=setInterval(()=>{if(fs.existsSync('go.txt')){clearInterval(t);console.log('${line}');process.exit(0)}},20)`,
    `setTimeout(()=>{},${JOB_LIFETIME_MS})`,
  ].join(";");
  return workspace.run(`node -e "${script}"`, { background: true });
}

/**
 * 每出现一个新的 `go-N.txt` 就打一行**完全相同**的内容。
 * 用来构造「确实有新输出，但读出来的文本一模一样」——这时不能豁免重复检测。
 *
 * 让测试每次新建一个文件、而不是复用同一个标记：后台进程删标记会与原子写撞上
 * （写入方会在提交前发现目标已被换掉），那属于测试自己在制造竞态。
 */
function startRepeatingJob(workspace, line) {
  const script = [
    "const fs=require('fs')",
    "const seen=new Set()",
    `setInterval(()=>{for(const f of fs.readdirSync('.')){` +
      `if(f.startsWith('go-')&&f.endsWith('.txt')&&!seen.has(f)){seen.add(f);console.log('${line}')}}},20)`,
    `setTimeout(()=>{},${JOB_LIFETIME_MS})`,
  ].join(";");
  return workspace.run(`node -e "${script}"`, { background: true });
}

/** 后台任务必须在 finally 里停掉：进程活着会占住工作区目录，Windows 上清理会抛 EBUSY。 */
async function stopJob(workspace, jobId = "job-1") {
  try {
    await workspace.killJob(jobId);
  } catch {
    // 可能已经自己退出，或清理未确认；收尾失败不该盖住测试真正想证明的事。
  }
}

test("集成：wait=0 立即返回不构成等待，重复轮询照样被无进展检测拦下", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await startIdleJob(workspace);
    const chat = createSteppedChat(Array.from({ length: 4 }, (_, index) => ({
      message: callTool(`poll-${index + 1}`, "shell-output", { job_id: "job-1", wait: 0 }),
    })));
    let executions = 0;
    const agent = createAgent(workspace, chat, { onToolCall: () => { executions++; } });
    try {
      await assert.rejects(() => agent.run("看看后台输出"), /identical tool batches.*no progress/);
      // 进程确实还在跑，但「立即返回」不是等待：第 4 批必须在执行前被拦下。
      assert.equal(executions, 3, "只有前三批真的执行了");
      const lastTool = agent.transcript.filter((message) => message.role === "tool").at(-1);
      assert.match(lastTool.content, /repeated identical tool batch made no progress/);
    } finally {
      await stopJob(workspace);
    }
  });
});

test("集成：真的等到预算用完、没有新输出且仍在运行时，重复轮询继续到任务结束", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await startTriggeredJob(workspace, "ready");
    // 前四次都是「仍在运行 + 没有新输出」，结果逐字相同：没有豁免的话第 4 批就会被拦下。
    const polls = Array.from({ length: 4 }, (_, index) => ({
      message: callTool(`wait-${index + 1}`, "shell-output", { job_id: "job-1", wait: 250 }),
    }));
    const chat = createSteppedChat([
      ...polls,
      {
        // 第五次读取之前放行后台任务：这一次会拿到新输出，必须照常进入下一轮。
        before: () => workspace.write("go.txt", ""),
        message: callTool("final-read", "shell-output", { job_id: "job-1", wait: 2_000 }),
      },
      { message: finalReply("后台任务已完成") },
    ]);
    let executions = 0;
    const agent = createAgent(workspace, chat, { onToolCall: () => { executions++; } });
    try {
      const reply = await agent.run("等后台任务跑完");
      assert.equal(reply.content, "后台任务已完成");
      assert.equal(executions, 5, "四次等待必须都执行，第五次读取拿到最终输出");
      assert.equal(chat.requests.length, 6);
      const toolResults = agent.transcript.filter((message) => message.role === "tool");
      assert.equal(toolResults.length, 5);
      for (const result of toolResults.slice(0, 4)) {
        assert.match(result.content, /\(no new output\)/);
      }
      assert.match(toolResults[4].content, /ready/);
      // 拿到新输出就不该再是「没有新输出」：这一批按普通结果参与判定。
      assert.doesNotMatch(toolResults[4].content, /\(no new output\)/);
    } finally {
      await stopJob(workspace);
    }
  });
});

test("集成：拿到新输出不算等待，同样的输出重复三次仍然会被拦下", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await startRepeatingJob(workspace, "same-line");
    const chat = createSteppedChat(Array.from({ length: 4 }, (_, index) => ({
      // 每次轮询之前新建一个标记文件，保证这一轮**确实**拿到新输出。
      before: () => workspace.write(`go-${index + 1}.txt`, ""),
      message: callTool(`tick-${index + 1}`, "shell-output", { job_id: "job-1", wait: 1_000 }),
    })));
    let executions = 0;
    const agent = createAgent(workspace, chat, { onToolCall: () => { executions++; } });
    try {
      await assert.rejects(() => agent.run("轮询日志"), /identical tool batches.*no progress/);
      assert.equal(executions, 3, "新输出不是等待，第 4 批不能再豁免");
      const toolResults = agent.transcript.filter((message) => message.role === "tool");
      for (const result of toolResults.slice(0, 3)) {
        assert.match(result.content, /same-line/, "前三批都真的读到了新内容");
      }
    } finally {
      await stopJob(workspace);
    }
  });
});

test("集成：任务已经结束时重复读取不再豁免，会被无进展检测拦下", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.run('node -e "process.exit(0)"', { background: true });
    // 先等它真的退出，后面的读取才会拿到稳定的「exited」状态行。
    const settled = await workspace.readJobOutput("job-1", 5_000);
    assert.equal(settled.status, "exited");
    assert.equal(settled.isWaiting, false, "任务结束不是等待");

    const chat = createSteppedChat(Array.from({ length: 4 }, (_, index) => ({
      message: callTool(`after-${index + 1}`, "shell-output", { job_id: "job-1", wait: 100 }),
    })));
    let executions = 0;
    const agent = createAgent(workspace, chat, { onToolCall: () => { executions++; } });
    try {
      await assert.rejects(() => agent.run("再看一眼"), /identical tool batches.*no progress/);
      assert.equal(executions, 3);
      const toolResults = agent.transcript.filter((message) => message.role === "tool");
      for (const result of toolResults.slice(0, 3)) {
        assert.match(result.content, /exited with code 0/);
      }
    } finally {
      await stopJob(workspace);
    }
  });
});

test("集成：一批里混进普通工具时，等待状态不能豁免整批", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("note.txt", "fixed\n");
    await startIdleJob(workspace);

    // 同一批里两个调用：一个在有效等待，一个每次返回同样的内容。整批不算等待。
    const batch = (id) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `${id}-wait`,
          type: "function",
          function: { name: "shell-output", arguments: JSON.stringify({ job_id: "job-1", wait: 200 }) },
        },
        {
          id: `${id}-read`,
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) },
        },
      ],
    });
    const chat = createSteppedChat(Array.from({ length: 4 }, (_, index) => ({ message: batch(`b${index + 1}`) })));
    let executions = 0;
    const agent = createAgent(workspace, chat, { onToolCall: () => { executions++; } });
    try {
      await assert.rejects(() => agent.run("一边等一边读"), /identical tool batches.*no progress/);
      assert.equal(executions, 6, "三批各两个调用；第四批在执行前被拦下");
    } finally {
      await stopJob(workspace);
    }
  });
});

test("集成：整批工具都在有效等待时，重复批次才允许继续", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await startIdleJob(workspace);
    await workspace.run(`node -e "setTimeout(()=>{},${JOB_LIFETIME_MS})"`, { background: true });
    // 两个任务都没有输出，两个调用都是有效等待：整批豁免，继续到模型收尾。
    const batch = (id) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `${id}-a`,
          type: "function",
          function: { name: "shell-output", arguments: JSON.stringify({ job_id: "job-1", wait: 150 }) },
        },
        {
          id: `${id}-b`,
          type: "function",
          function: { name: "shell-output", arguments: JSON.stringify({ job_id: "job-2", wait: 150 }) },
        },
      ],
    });
    const chat = createSteppedChat([
      ...Array.from({ length: 4 }, (_, index) => ({ message: batch(`w${index + 1}`) })),
      { message: finalReply("还在跑，先这样") },
    ]);
    let executions = 0;
    const agent = createAgent(workspace, chat, { onToolCall: () => { executions++; } });
    try {
      const reply = await agent.run("同时等两个后台任务");
      assert.equal(reply.content, "还在跑，先这样");
      assert.equal(executions, 8, "四批 × 两个调用都要真的执行");
      assert.equal(chat.requests.length, 5);
    } finally {
      await stopJob(workspace, "job-1");
      await stopJob(workspace, "job-2");
    }
  });
});

test("集成：有效等待不绕过 maxSteps，步数用完仍然收尾", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await startIdleJob(workspace);
    // 脚本会一直重复最后一条：模型永远在等，只有步数闸门能停住它。
    const chat = createSteppedChat([
      { message: callTool("wait-1", "shell-output", { job_id: "job-1", wait: 150 }) },
    ]);
    let executions = 0;
    const agent = createAgent(workspace, chat, {
      maxSteps: 5,
      onToolCall: () => { executions++; },
    });
    try {
      await assert.rejects(() => agent.run("一直等"), /step limit 5 reached after executing 4 tool call\(s\)/);
      assert.equal(executions, 4, "最后一次请求只留给收尾，工具不再执行");
      assert.equal(chat.requests.length, 5);
    } finally {
      await stopJob(workspace);
    }
  });
});

test("集成：等待期间取消，Run 及时以取消结束且配对完整", async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController();
    const workspace = new Workspace({ root, signal: controller.signal });
    await startIdleJob(workspace);
    const chat = createSteppedChat([
      { message: callTool("wait", "shell-output", { job_id: "job-1", wait: 30_000 }) },
    ]);
    const agent = createAgent(workspace, chat, { signal: controller.signal, maxSteps: 5 });
    const timer = setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    try {
      await assert.rejects(() => agent.run("等后台任务"), /cancelled/);
      assert.ok(Date.now() - started < 5_000, "取消必须打断等待，不能等完 30 秒");

      const transcript = agent.transcript;
      const assistant = transcript.find((message) => message.role === "assistant" && message.tool_calls !== undefined);
      const tool = transcript.find((message) => message.role === "tool");
      assert.equal(tool.tool_call_id, assistant.tool_calls[0].id, "取消不能破坏 assistant / tool 配对");
      assert.match(tool.content, /cancelled by signal/);
      assert.equal(chat.requests.length, 1, "取消之后不再发新的模型请求");
    } finally {
      clearTimeout(timer);
      await stopJob(workspace);
    }
  });
});

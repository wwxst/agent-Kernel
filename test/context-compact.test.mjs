/**
 * 文件目的：第 8 课 Context Compact 的验收测试 —— 预算、工具结果裁剪、历史摘要、
 * 原子替换、溢出恢复、长任务回放。这些行为单独一个文件，是因为它们围着同一条缝
 * （`Agent.run`）验同一件事：压缩之后，Agent 还能不能准确继续干活。
 *
 * 文件职责：只用假模型驱动 `Agent.run`，断言外部可观察行为 —— 发出去的请求里有什么、
 * 存档里有什么、统计报了什么。不测私有函数，不 mock 自己的模块。
 * 不负责界面排版（归 `test/tui.test.mjs`）、不负责工具本身（归 `test/workspace.test.mjs`）。
 *
 * 内容目录：
 *   - `createModel()`：记录每次请求的假客户端；可注入业务请求失败、可控制摘要正文。
 *   - `summaryWith()`：造一份形状合格、带标记的摘要，用来验证「替换而不是追加」。
 *   - 预算：短对话不压、工具定义计入体积、字符路径与 token 路径分开。
 *   - 工具结果：最新批次完整、旧结果先裁剪、超大结果先存档再预览、存档失败不替换、
 *     换了预览却没省空间、存档成功后立刻取消、登记存档时抛错，都回滚刚写的存档。
 *   - 历史摘要：折叠旧轮次、单轮多步、多次替换、失败/不合格/取消都不提交；
 *     摘要以 system 之后的一条 user 消息承载（不抬高指令等级、不被当成用户轮次）；
 *     存档失败与候选被拒都回滚存档，不留孤儿文件。
 *   - 提交原子性：在提交块唯一的失败点注入异常，验证「要么全提交、要么全不提交」，
 *     以及成功提交后存档清单、摘要消息、上下文与磁盘文件一一对应。
 *   - 摘要请求自己的预算：序列化后的真实体积、输出预留为 0 时的合法结构下限、装不下就不发。
 *   - 溢出：只认明确的上下文超限、最多重发一次、不重跑工具、压不动就报错。
 *   - 隔离与回放：子 Agent 互不影响、长任务多轮压缩后仍能完成。
 *
 * 模块关系：依赖 `src/core/agent.ts`、`src/core/tool-registry.ts`、`src/protocol/errors.ts`
 * 与 `test/support/harness.mjs`。由 `package.json` 的 `test` 脚本执行。
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
// 整个模块导入：这条用例要验证的正是「摘要长度下限与九节结构一致」。写成命名导入的话，
// 旧版本缺这个导出时整个文件会加载失败，反而看不出是哪条断言不成立。
import * as compact from "../src/core/context-compact.ts";
import { ModelHttpError, ProcessCleanupError } from "../src/protocol/errors.ts";
import {
  CANNED_SUMMARY,
  SUMMARY_PROMPT_MARKER,
  callTool,
  echoTool,
  finalReply,
  makeRegistry,
  withWorkspace,
} from "./support/harness.mjs";

/**
 * 压缩用例只关心压缩机制，不关心默认系统提示写了什么。
 *
 * 长度刻意对齐 ADR-0032 之前的默认提示（1086 字符）：这些用例的预算、触发线、
 * 「先裁哪一刀」都是按那个体积调出来的，换成任意短提示会让压力消失，断言就不再测原来的东西。
 * 显式传了 `systemPrompt` 的用例仍然用自己那份：展开顺序保证 options 覆盖默认值。
 */
const TEST_SYSTEM_PROMPT = "t".repeat(1_086);

function makeAgent(options) {
  return new Agent({ systemPrompt: TEST_SYSTEM_PROMPT, ...options });
}

/**
 * 独立模拟 Llm.chat 发出的请求体积。
 *
 * 不调用生产代码的 requestChars()：假后端必须有自己的测量逻辑，
 * 否则生产预算少算时，模拟后端也会跟着少算，测试就发现不了超窗。
 */
function serializedWireRequestChars(messages, tools) {
  const wireTools = tools.map(({ name, description, parameters }) => ({
    type: "function",
    function: { name, description, parameters },
  }));
  return JSON.stringify(messages).length + (wireTools.length > 0 ? JSON.stringify(wireTools).length : 0);
}

/**
 * 记录每次请求的假模型。
 *
 * 摘要请求按系统提示里的标记识别，不消耗 `replies` 的下标 —— 否则「第几次业务请求回什么」
 * 会被摘要请求挤掉，测试就变成在数请求，而不是在验行为。
 * `failures[i]` 让第 i 次业务请求直接抛错，用来模拟上游错误。
 * `maxRequestChars` 让假后端按字符数拒绝超窗请求（3 字符/token 的确定性口径），
 * 用来复现「摘要请求自己先被窗口拒绝」。
 * `summary` 可以是函数：拿到 `(第几次摘要请求, 这次的消息)`，用来造「照提示词上限写摘要」的假模型。
 */
function createModel(options = {}) {
  const requests = [];
  const summaryRequests = [];
  let business = 0;
  return {
    requests,
    summaryRequests,
    get businessRequests() {
      return requests.filter((request) => !request.summary);
    },
    async chat(messages, tools) {
      const isSummary = messages.length > 0 && messages[0].role === "system" &&
        String(messages[0].content ?? "").includes(SUMMARY_PROMPT_MARKER);
      requests.push(structuredClone({ messages, tools, summary: isSummary }));
      if (options.maxRequestChars !== undefined) {
        const size = serializedWireRequestChars(messages, tools);
        if (size > options.maxRequestChars) {
          throw new ModelHttpError(400, `fake backend: request of ${size} chars exceeds ${options.maxRequestChars}`);
        }
      }
      if (isSummary) {
        summaryRequests.push(structuredClone({ messages, tools }));
        const content = typeof options.summary === "function"
          ? options.summary(summaryRequests.length, messages)
          : (options.summary ?? CANNED_SUMMARY);
        if (content instanceof Error) throw content;
        if (options.beforeSummaryReply !== undefined) options.beforeSummaryReply(summaryRequests.length);
        return {
          message: { role: "assistant", content },
          usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
        };
      }
      const index = business++;
      const failure = options.failures?.[index];
      if (failure !== undefined) throw failure;
      const replies = options.replies ?? [finalReply("done")];
      const message = structuredClone(replies[Math.min(index, replies.length - 1)]);
      // 默认不带 usage（模拟端点不报用量）；需要精确核对记账时再显式给。
      return options.businessUsage === undefined ? { message } : { message, usage: options.businessUsage };
    },
  };
}

/** 形状合格、带唯一标记的摘要：九节齐全，够长，能过检查。 */
function summaryWith(tag) {
  return [
    `## Primary Request and Intent`,
    `Goal recorded in ${tag}.`,
    `## Key Technical Concepts`,
    "None yet.",
    `## Files and Code Sections`,
    `src/core/agent.ts`,
    `## Errors and fixes`,
    `${tag} fixed nothing yet.`,
    `## Problem Solving`,
    `${tag} decided to keep the change small.`,
    `## All user messages`,
    `Carry on with ${tag}.`,
    `## Pending Tasks`,
    "Finish the current task.",
    `## Current Work`,
    `Progress noted by ${tag}.`,
    `## Optional Next Step`,
    `Continue after ${tag}.`,
  ].join("\n");
}

/** 一条 assistant 消息：带工具调用，同时带一段正文（模型在解释自己要干什么）。 */
function callToolWithNotes(id, name, args, notes) {
  return { ...callTool(id, name, args), content: notes };
}

/**
 * 取出摘要消息，并断言它确实按「上下文数据」的方式承载。
 *
 * 位置与角色都是契约的一部分：system 之后一条 user 消息。摘要来自历史（含工具输出），
 * 放进 system 就等于把工具输出里的祈使句抬到系统规则之上（设计文档 §8.4）。
 */
function memoryMessage(messages) {
  const [system, memory] = messages;
  assert.equal(system?.role, "system");
  assert.equal(memory?.role, "user", "摘要必须以 user 角色承载，不能进 system");
  assert.match(String(memory?.content ?? ""), /conversation memory/i);
  return memory;
}

/** 整个 Transcript 里有没有摘要消息 —— 用来断言「这次没有提交摘要」。 */
function hasMemoryMessage(messages) {
  return messages.some((message) => /conversation memory/i.test(String(message.content ?? "")));
}

/**
 * 一份「刚好装得下九节结构」的摘要：每节一行标题 + 一句最短正文。
 *
 * 用来验证「摘要长度下限必须容得下合法九节」—— 比这更短就不可能九节齐全。
 * 正文刻意留 24 字符：短到仍是合法结构，长到前 120 字符里塞不下四节。
 */
function compactNineSections() {
  return [
    "Primary Request and Intent",
    "Key Technical Concepts",
    "Files and Code Sections",
    "Errors and fixes",
    "Problem Solving",
    "All user messages",
    "Pending Tasks",
    "Current Work",
    "Optional Next Step",
  ].map((section) => `## ${section}\n` + "b".repeat(24)).join("\n");
}

/**
 * 照提示词写摘要的假模型：九节齐全，但一旦超出「under N characters」就截断
 * （提示词明说更长的摘要会被丢弃）。
 *
 * 这就是真实模型的处境：上限小于九节结构本身时，它无论怎么写都不合格 ——
 * 于是「摘要请求发出去了、回复也回来了，但永远提交不了」。
 */
function summaryWithinStatedLimit(_count, messages) {
  const stated = /under (\d+) characters/.exec(String(messages[0].content ?? ""));
  const limit = stated === null ? Number.POSITIVE_INFINITY : Number(stated[1]);
  const full = compactNineSections();
  return full.length <= limit ? full : full.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 预算：什么时候压、按什么尺子量
// ---------------------------------------------------------------------------

test("预算：短对话不压缩，也不调用摘要模型", async () => {
  const chat = createModel({ replies: [finalReply("ok")] });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    contextWindowTokens: 8_000,
    outputTokenReserve: 1_000,
  });

  await agent.run("say ok");

  assert.equal(chat.businessRequests.length, 1);
  assert.equal(chat.summaryRequests.length, 0, "空间够就不该为压缩付一次模型调用");
  assert.equal(agent.stats.summaryRequests, 0);
  assert.equal(agent.compactionStats.compactions, 0);
});

test("预算：工具定义按实际发送给模型的包装结构计算", () => {
  const message = { role: "user", content: "hello" };
  const definition = {
    name: "echo",
    description: "Echo the value back.",
    parameters: { type: "object", properties: { value: { type: "string" } } },
  };
  const wireTools = [{
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  }];
  const expected = JSON.stringify([message]).length + JSON.stringify(wireTools).length;

  assert.equal(compact.requestChars([message], [definition]), expected);
  assert.equal(serializedWireRequestChars([message], [definition]), expected,
    "假后端必须独立按模型实际收到的工具包装结构计算体积");
});

test("预算：工具定义与系统提示都算进请求体积", async () => {
  const bigEcho = { ...echoTool(), run: async () => "z".repeat(5_000) };
  const bulky = {
    name: "bulky",
    description: "d".repeat(12_000),
    parameters: { type: "object", properties: {} },
    run: async () => "ok",
  };
  const tiny = { name: "tiny", description: "t", parameters: { type: "object", properties: {} }, run: async () => "ok" };
  const script = [callTool("c1", "echo", { value: "a" }), finalReply("ok")];

  // 同样的对话、同样的预算，只差工具说明书的大小：只有大的那份该触发裁剪。
  const withBulky = createModel({ replies: script });
  const bulkyAgent = makeAgent({
    llm: withBulky,
    tools: makeRegistry([bigEcho, bulky]),
    contextWindowTokens: 8_000,
    outputTokenReserve: 1_000,
  });
  await bulkyAgent.run("first");
  await bulkyAgent.run("second");

  const withTiny = createModel({ replies: script });
  const tinyAgent = makeAgent({
    llm: withTiny,
    tools: makeRegistry([bigEcho, tiny]),
    contextWindowTokens: 8_000,
    outputTokenReserve: 1_000,
  });
  await tinyAgent.run("first");
  await tinyAgent.run("second");

  const bulkyResult = withBulky.businessRequests.at(-1).messages.find((message) => message.role === "tool");
  const tinyResult = withTiny.businessRequests.at(-1).messages.find((message) => message.role === "tool");
  assert.match(bulkyResult.content, /context compacted/, "长工具 Schema 占的空间也必须计入预算");
  assert.equal(tinyResult.content, "z".repeat(5_000), "工具说明书很小时不该误伤工具结果");
});

test("预算：没有窗口只按字符数，配了窗口才按 token 估算", async () => {
  // 一条 9000 字符的最终答复：字符路径远没到 120000，token 路径已经越过 2000 的触发线。
  const script = [finalReply("answer " + "x".repeat(9_000))];

  const loose = createModel({ replies: script });
  const looseAgent = makeAgent({ llm: loose, tools: makeRegistry([]), maxTranscriptChars: 120_000 });
  await looseAgent.run("first");
  await looseAgent.run("second");
  assert.equal(loose.summaryRequests.length, 0, "字符预算足够时不该压缩");
  assert.equal(loose.businessRequests.at(-1).messages.length, 4, "历史原样保留：system + 两轮 + 新的 user");

  const tight = createModel({ replies: script });
  const tightAgent = makeAgent({
    llm: tight,
    tools: makeRegistry([]),
    contextWindowTokens: 3_000,
    outputTokenReserve: 500,
  });
  await tightAgent.run("first");
  await tightAgent.run("second");
  assert.equal(tight.summaryRequests.length, 1, "窗口 3000 装不下 9000 字符的历史");
  // 摘要以 user 角色跟在 system 后面；宿主生成的存档清单仍然留在 system 里。
  assert.equal(tightAgent.transcript[1].role, "user");
  assert.match(tightAgent.transcript[0].content, /Archived originals/);
});

// ---------------------------------------------------------------------------
// 工具结果：先处理最占空间的内容
// ---------------------------------------------------------------------------

test("工具结果：最新一批装不进窗口时，先存档再给可读预览", async () => {
  await withWorkspace(async (root) => {
    const archiveRoot = path.join(root, "archive");
    const bigTool = { ...echoTool(), run: async () => "y".repeat(20_000) };
    const chat = createModel({ replies: [callTool("big-1", "echo", { value: "x" }), finalReply("done")] });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([bigTool]),
      maxTranscriptChars: 4_000,
      contextArchiveDir: archiveRoot,
    });

    await agent.run("read the big thing");

    const delivered = chat.businessRequests[1].messages.find((message) => message.role === "tool");
    assert.match(delivered.content, /context compacted/, "装不下时必须换成预览，而不是硬发超限请求");
    assert.ok(delivered.content.length < 2_000);
    assert.equal(delivered.tool_call_id, "big-1", "预览仍要挂在原来那条调用上");

    const archived = /full text: (.+?)\]/.exec(delivered.content)?.[1];
    assert.ok(archived !== undefined, "预览必须给出原文路径");
    assert.ok(chat.businessRequests[1].messages[0].content.includes(archived), "收到预览的同一请求就要包含存档清单");
    assert.equal(await readFile(archived, "utf8"), "y".repeat(20_000), "存档必须是完整原文");
  });
});

test("工具结果：同批产生十三份存档时，当次请求列出最新十二份并报告余数", async () => {
  await withWorkspace(async root => {
    const calls = Array.from({ length: 13 }, (_, i) => callTool("c" + i, "echo", { value: String(i) }).tool_calls[0]);
    const batch = { role: "assistant", content: null, tool_calls: calls };
    const chat = createModel({ replies: [batch, finalReply("done")] });
    const agent = makeAgent({
      llm: chat, tools: makeRegistry([{ ...echoTool(), run: async () => "z".repeat(4_000) }]),
      contextArchiveDir: root, maxTranscriptChars: 3_000,
    });
    await agent.run("read");
    const sent = chat.businessRequests.at(-1).messages;
    const listed = [...sent[0].content.matchAll(/^- (.+?) \(\d+ chars\)$/gm)].map(match => match[1]);
    const paths = sent.filter(m => m.role === "tool").map(m => /full text: (.+?)\]/.exec(m.content)[1]);
    assert.equal(listed.length, 12);
    assert.deepEqual(listed, paths.slice(1));
    assert.match(sent[0].content, /1 older archive\(s\) not listed/);
    assert.equal(await readFile(paths[0], "utf8"), "z".repeat(4_000));
  });
});

test("溢出降级：自定义客户端返回空工具数组时，折叠仍保留上一轮回答", async () => {
  const chat = createModel({
    replies: [finalReply("retain-this-answer " + "x".repeat(6_000)), finalReply("done")],
    failures: [undefined, contextOverflowError()], summary: "invalid",
  });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([]), maxTranscriptChars: 20_000 });
  await agent.run("first");
  await agent.run("next");
  assert.match(memoryMessage(chat.businessRequests.at(-1).messages).content,
    /Earlier assistant answer: retain-this-answer/);
});

test("工具结果：存档失败时不做有损替换", async () => {
  await withWorkspace(async (root) => {
    // 把一个普通文件当存档目录：建目录会失败，存档也就失败。
    const notADirectory = path.join(root, "not-a-directory");
    await writeFile(notADirectory, "x");
    const bigTool = { ...echoTool(), run: async () => "y".repeat(20_000) };
    const chat = createModel({ replies: [callTool("big-1", "echo", { value: "x" }), finalReply("done")] });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([bigTool]),
      maxTranscriptChars: 4_000,
      contextArchiveDir: notADirectory,
    });

    await agent.run("read the big thing");

    const delivered = chat.businessRequests[1].messages.find((message) => message.role === "tool");
    assert.equal(delivered.content, "y".repeat(20_000), "没有存档就不许把原文换成预览");
    assert.ok(agent.compactionStats.archiveFailures > 0, "存档失败要计数，不能无声吞掉");
  });
});

test("工具结果：存档成功后立刻取消，刚写的 archive 被回滚，原结果保持完整", async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController();
    const bigTool = { ...echoTool(), run: async () => "y".repeat(20_000) };
    const chat = createModel({
      replies: [callTool("big-1", "echo", { value: "x" }), finalReply("first"), finalReply("second")],
    });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([bigTool]),
      maxTranscriptChars: 4_000,
      contextArchiveDir: path.join(root, "archive"),
      signal: controller.signal,
    });

    // 20000 字符的结果一进来就超过硬上限，下一次请求前必须走「先存档、再给预览」。
    // 在「文件已经写盘、还没走到 checkCancelled()」之间按下 Ctrl-C：这个窗口没有别的外部入口，
    // 只能在真实 save 外面包一层。包装只作用于这个实例，不影响其他用例。
    const archive = agent.context.archive;
    const realSave = archive.save.bind(archive);
    archive.save = async (...args) => {
      const ref = await realSave(...args);
      controller.abort();
      return ref;
    };

    await assert.rejects(() => agent.run("read the big thing"), /cancelled/);

    // 原结果没有被换成预览，配对也没变。
    const results = agent.transcript.filter((message) => message.role === "tool");
    assert.equal(results.length, 1);
    assert.equal(results[0].tool_call_id, "big-1");
    assert.equal(results[0].content, "y".repeat(20_000), "取消时不能提交预览");
    // 存档清单与登记表都没有新增引用。
    assert.doesNotMatch(agent.transcript[0].content, /Archived originals/);
    assert.equal(agent.context.archivedOriginals.length, 0, "取消的存档不能进登记表");
    assert.equal(agent.context.archiveCount, 0);
    // 刚写的文件必须删掉，否则就是没人引用的孤儿。
    assert.deepEqual(await readdir(archive.directory), [], "存档成功后取消，文件要被回滚");
    // 取消不是存档写入失败，不能算进 archiveFailures。
    assert.equal(agent.compactionStats.archiveFailures, 0);
  });
});

test("工具结果：登记存档时抛错，文件被回滚且 prunedSources 不留悬空引用", async () => {
  await withWorkspace(async (root) => {
    const bigTool = { ...echoTool(), run: async () => "y".repeat(20_000) };
    const chat = createModel({
      replies: [callTool("big-1", "echo", { value: "x" }), finalReply("done")],
    });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([bigTool]),
      maxTranscriptChars: 4_000,
      contextArchiveDir: path.join(root, "archive"),
    });

    // 让登记存档那一步的 push 抛错 —— 它是裁剪提交里唯一可能失败的语句。
    // 白盒注入：这个失败点没有别的外部入口。
    const context = agent.context;
    context.archivedOriginals.push = () => { throw new Error("prune boom"); };

    await assert.rejects(() => agent.run("read the big thing"), /prune boom/);

    // 用内部消息对象核对 prunedSources：transcript 是深拷贝，拿它查 WeakMap 永远是 undefined，
    // 那样这条断言就白写了。
    const tool = context.messages.find((message) => message.role === "tool");
    assert.equal(tool.content, "y".repeat(20_000), "没提交就不能把原文换成预览");
    assert.equal(tool.tool_call_id, "big-1", "配对不变");
    // system 清单没有新增引用，登记表与计数也没动。
    assert.doesNotMatch(context.messages[0].content, /Archived originals/);
    assert.equal(context.archivedOriginals.length, 0);
    assert.equal(context.archiveCount, 0);
    // 最要紧的一条：登记失败时不能先写 prunedSources，否则会留下指向已删除文件的引用。
    assert.equal(context.prunedSources.get(tool), undefined,
      "prunedSources 不能留下指向已删除文件的引用");
    // 刚写的文件被回滚，不留孤儿。
    assert.deepEqual(await readdir(context.archive.directory), []);
    assert.equal(agent.compactionStats.archiveFailures, 0, "这不是存档写入失败");
  });
});

test("历史压缩：存档失败时不提交替换，原始历史与请求都保持完整", async () => {
  await withWorkspace(async (root) => {
    // 把一个普通文件当存档目录：建目录会失败，历史压缩的存档也就失败。
    const notADirectory = path.join(root, "not-a-directory");
    await writeFile(notADirectory, "x");
    // 刻意不放工具结果：这样存档目录里唯一可能出现的写入就是这次历史压缩，
    // 失败一定来自 `compactHistory`，不会被「工具结果裁剪」那条路径先挡下来。
    const chat = createModel({
      replies: [finalReply("first answer " + "a".repeat(3_000)), finalReply("done")],
    });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([]),
      maxTranscriptChars: 3_000,
      contextArchiveDir: notADirectory,
    });

    await agent.run("first task");
    const before = agent.transcript.length;
    await agent.run("second task");

    assert.equal(agent.compactionStats.compactions, 0, "原文没有第二份，就不能提交有损替换");
    assert.equal(agent.compactionStats.archiveFailures, 1, "存档失败要计数，且只该发生这一次");
    assert.match(agent.compactionStats.lastError, /archive failed/);
    // 存档没成功就不该再花钱请模型写摘要：那份摘要将没有任何原文可追溯。
    assert.equal(chat.summaryRequests.length, 0, "存档失败后不能发摘要请求");
    // 原始历史必须原样留在上下文里，并且照常发给模型。
    assert.equal(agent.transcript.length, before + 2, "旧轮次一条都不能少（只多了新的一问一答）");
    assert.ok(agent.transcript.some((message) => message.content === "first task"));
    assert.ok(chat.businessRequests.at(-1).messages.some((message) =>
      String(message.content ?? "").startsWith("first answer ")));
  });
});

test("工具结果：模型复用同一个调用 id 时，两份原文各自存档", async () => {
  await withWorkspace(async (root) => {
    const tool = { ...echoTool(), run: async (args) => String(args.value).repeat(12_000) };
    // 两次响应都用 id `reused`：协议只要求一次响应内唯一，跨响应复用是合法的。
    const chat = createModel({
      replies: [
        callTool("reused", "echo", { value: "A" }),
        finalReply("first"),
        callTool("reused", "echo", { value: "B" }),
        finalReply("second"),
        finalReply("third"),
      ],
    });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([tool]),
      maxTranscriptChars: 5_000,
      contextArchiveDir: path.join(root, "archive"),
    });

    await agent.run("first task");
    await agent.run("second task");
    await agent.run("third task");

    const results = chat.businessRequests.at(-1).messages.filter((message) => message.role === "tool");
    assert.equal(results.length, 2, "两份结果都要留在上下文里");
    const files = results.map((message) => /full text: (.+?)\]/.exec(message.content)?.[1]);
    assert.ok(files[0] !== undefined && files[1] !== undefined);
    assert.notEqual(files[0], files[1], "同一个 id 的两次调用不能共用一份存档");
    assert.match(await readFile(files[0], "utf8"), /^A{100}/, "第一份存档是自己的原文");
    assert.match(await readFile(files[1], "utf8"), /^B{100}/, "第二份存档也必须是自己的原文");
  });
});

test("工具调用：同一轮里复用同一个调用 id 的完整配对仍可折叠", async () => {
  // 协议只要求一次响应内 id 唯一：同一轮里两次响应都用 `same` 是合法历史。
  const replies = [
    { ...callTool("same", "echo", { value: "a" }), content: "step1 " + "a".repeat(1_500) },
    { ...callTool("same", "echo", { value: "b" }), content: "step2 " + "b".repeat(1_500) },
    finalReply("first answer " + "c".repeat(1_500)),
    finalReply("second answer " + "d".repeat(1_500)),
  ];
  const chat = createModel({ replies, summary: summaryWith("reused-id") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 6_000 });

  await agent.run("first task");
  await agent.run("second task");

  assert.ok(agent.compactionStats.compactions >= 1,
    "复用 id 是合法历史，不能因为配对检查太严就永远压不动");
  assert.equal(chat.summaryRequests.length, 1);
  assert.equal(agent.compactionStats.lastError, "");
});

test("工具调用：同一轮里复用 id 时，未消费保护不会锁住整段历史", async () => {
  // 只有「刚跑完、还没被读过」的那一批该受保护；旧的同 id 批次必须照常可折叠。
  const replies = [];
  for (let step = 1; step <= 4; step++) {
    replies.push({
      ...callTool("same", "echo", { value: String(step) }),
      content: "step " + step + " " + "n".repeat(1_500),
    });
  }
  replies.push(finalReply("done"));
  const chat = createModel({ replies, summary: summaryWith("reused-in-turn") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 6_000 });

  const reply = await agent.run("run four steps");

  assert.equal(reply.content, "done");
  assert.ok(agent.compactionStats.compactions >= 1,
    "复用 id 的旧批次不该被当成「还没读」，否则这段历史永远折不动");
  assert.ok(chat.summaryRequests.length >= 1);
  assert.equal(agent.compactionStats.lastError, "");
});

test("进程树未确认后：请求按空工具表测量，模型仍能报告故障", async () => {
  const bulky = {
    name: "bulky",
    description: "d".repeat(6_000),
    parameters: { type: "object", properties: {} },
    run: async () => {
      throw new ProcessCleanupError("process tree cleanup unverified: test");
    },
  };
  const chat = createModel({
    replies: [
      { ...callTool("c1", "bulky", {}), content: "x".repeat(3_000) },
      finalReply("reported the cleanup failure"),
    ],
  });
  // 窗口按「带全部工具」算不够、按「空工具表」算够：准入必须跟真正发出去的东西一致。
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([bulky]),
    contextWindowTokens: 3_900,
    outputTokenReserve: 1_000,
  });

  const reply = await agent.run("run it");

  assert.equal(reply.content, "reported the cleanup failure");
  assert.equal(agent.toolExecutionDisabled, true);
  assert.equal(chat.businessRequests.at(-1).tools.length, 0, "后续请求不带工具");
});

test("工具结果：先裁剪最早的旧结果，够了就停", async () => {
  const calls = ["c1", "c2"].map((id, index) => ({
    id,
    type: "function",
    function: { name: "echo", arguments: JSON.stringify({ value: String(index + 1) }) },
  }));
  const tool = { ...echoTool(), run: async () => "w".repeat(3_000) };
  const chat = createModel({
    replies: [{ role: "assistant", content: null, tool_calls: calls }, finalReply("first"), finalReply("second")],
  });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([tool]), maxTranscriptChars: 7_000 });

  await agent.run("first task");
  await agent.run("second task");

  const sent = chat.businessRequests.at(-1).messages;
  const first = sent.find((message) => message.role === "tool" && message.tool_call_id === "c1");
  const second = sent.find((message) => message.role === "tool" && message.tool_call_id === "c2");
  assert.match(first.content, /context compacted/, "越早的结果越先被裁");
  assert.equal(second.content, "w".repeat(3_000), "省够空间就停手，不顺手多裁一份");
});

test("工具结果：第一刀不够时会再切一刀，但每份都留可读路径", async () => {
  await withWorkspace(async (root) => {
    const calls = ["c1", "c2", "c3", "c4"].map((id, index) => ({
      id,
      type: "function",
      function: { name: "echo", arguments: JSON.stringify({ value: String(index + 1) }) },
    }));
    const tool = { ...echoTool(), run: async () => "v".repeat(12_000) };
    const chat = createModel({
      replies: [{ role: "assistant", content: null, tool_calls: calls }, finalReply("first"), finalReply("second")],
    });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([tool]),
      maxTranscriptChars: 5_000,
      contextArchiveDir: path.join(root, "archive"),
    });

    await agent.run("first task");
    await agent.run("second task");

    const results = chat.businessRequests.at(-1).messages.filter((message) => message.role === "tool");
    assert.equal(results.length, 4, "四份结果都还在，只是变短");
    assert.ok(results.every((message) => /full text: /.test(message.content)), "每份都要给出原文路径");
    assert.ok(results.some((message) => message.content.length < 400), "第一刀（800）不够时必须再切一刀");
    assert.ok(JSON.stringify(chat.businessRequests.at(-1).messages).length < 6_000);

    // 第二刀不能把来源换成「上一份预览」：消息里的引用必须直接指向完整原文。
    for (const message of results) {
      const file = /full text: (.+?)\]/.exec(message.content)?.[1];
      assert.ok(file !== undefined);
      assert.equal(await readFile(file, "utf8"), "v".repeat(12_000),
        `${message.tool_call_id} 的引用必须指向第一次存档的完整原文`);
    }
  });
});

// ---------------------------------------------------------------------------
// 历史摘要：让 Agent 不忘记任务
// ---------------------------------------------------------------------------

test("历史摘要：旧轮次折进摘要，当前任务与消息配对保留", async () => {
  const script = [
    callTool("c1", "echo", { value: "a" }),
    finalReply("first answer " + "a".repeat(1_200)),
    callTool("c2", "echo", { value: "b" }),
    finalReply("second answer " + "b".repeat(1_200)),
    finalReply("third answer"),
  ];
  const chat = createModel({ replies: script, summary: summaryWith("round-one") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 3_000 });

  await agent.run("first task");
  await agent.run("second task");
  await agent.run("third task");

  assert.equal(chat.summaryRequests.length, 1);
  const transcript = agent.transcript;
  const memory = memoryMessage(transcript);
  assert.match(memory.content, /round-one/, "摘要正文要进那条摘要消息");
  assert.equal(transcript[2].content, "third task", "当前任务必须留在原始消息里");
  assert.ok(!transcript.some((message) => message.content === "first task"), "旧轮次被折进摘要");

  // 保留的调用与结果必须完整配对、顺序正确。
  for (let index = 1; index < transcript.length; index++) {
    const message = transcript[index];
    if (message.role !== "assistant" || message.tool_calls === undefined) continue;
    for (const call of message.tool_calls) {
      const result = transcript[index + 1];
      assert.equal(result?.role, "tool");
      assert.equal(result?.tool_call_id, call.id);
      index++;
    }
  }
});

test("历史摘要：单轮任务里的已完成步骤也能折叠，当前目标不丢", async () => {
  const replies = [];
  for (let step = 1; step <= 7; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)));
  }
  replies.push(finalReply("all steps done"));
  const chat = createModel({ replies, summary: summaryWith("steps") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 8_000 });

  const reply = await agent.run("run all seven steps");

  assert.equal(reply.content, "all steps done");
  assert.ok(agent.compactionStats.compactions >= 1, "长单轮任务也必须能压，否则调用参数与推理会一直累积");
  const transcript = agent.transcript;
  const memory = memoryMessage(transcript);
  assert.equal(transcript[2].content, "run all seven steps", "当前目标不能被折叠");
  assert.match(memory.content, /steps/);
});

test("历史摘要：多次压缩是替换旧摘要，而不是不断追加", async () => {
  const replies = [];
  for (let step = 1; step <= 14; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)));
  }
  replies.push(finalReply("done"));
  const chat = createModel({ replies, summary: (round) => summaryWith(`round-${round}`) });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 8_000 });

  await agent.run("run all steps");

  assert.ok(chat.summaryRequests.length >= 2, "长任务应该发生多次压缩");
  const transcript = agent.transcript;
  const memory = memoryMessage(transcript).content;
  const lastTag = `round-${chat.summaryRequests.length}`;
  // 只允许出现一个轮次标记：出现两个就说明旧摘要是被追加而不是被替换。
  assert.deepEqual([...new Set(memory.match(/round-\d+/g) ?? [])], [lastTag], "旧摘要被替换，不是拼在后面");
  assert.equal((memory.match(/conversation memory/gi) ?? []).length, 1, "只有一块摘要，不重复");
  assert.ok(memory.length < 20_000, "摘要不能随压缩次数无限增长");
  assert.equal(transcript.filter((message) => /conversation memory/i.test(String(message.content ?? ""))).length, 1,
    "Transcript 里只能有一条摘要消息：替换，不是往后追加");

  // 第二次摘要请求必须带上上一份摘要，才能把旧结论合并进来。
  const secondRequest = chat.summaryRequests[1];
  const summaryInput = secondRequest.messages[1].content;
  assert.match(summaryInput, /round-1/, "摘要请求要带上上一份摘要");
  assert.match(summaryInput, /Previous summary/, "并且明确要求合并成一份新的");
});

test("历史摘要：摘要以 user 角色承载，既不抬高指令等级，也不被当成用户轮次", async () => {
  // 摘要的内容来自历史（用户要求、助手动作、工具输出），它是数据。
  // 放进 system 就等于把工具输出里的祈使句抬到系统规则那一档（设计文档 §8.4）。
  const replies = [];
  for (let step = 1; step <= 12; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)));
  }
  replies.push(finalReply("done"));
  const chat = createModel({ replies, summary: (round) => summaryWith(`role-${round}`) });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 8_000 });

  await agent.run("run the steps");

  assert.ok(agent.compactionStats.compactions >= 2, "这个用例要看到多次压缩");
  const transcript = agent.transcript;
  // 1) 摘要不在 system 消息里。
  assert.ok(!transcript[0].content.includes("conversation memory"), "摘要不能进 system");
  assert.ok(!transcript[0].content.includes("role-1"), "摘要正文不能出现在 system 里");
  // 2) 它以 user 角色紧跟 system，且正文按 JSON 字符串承载 —— 摘要里的换行伪造不出新的对话边界。
  assert.equal(transcript[1].role, "user");
  assert.match(transcript[1].content, /role-\d+/);
  const encoded = transcript[1].content.split("\n").slice(1).join("\n");
  assert.equal(typeof JSON.parse(encoded), "string", "摘要正文要以 JSON 字符串承载");

  // 3) 它不会被当成一轮用户发言交给摘要模型：那会把模型写的摘要误标成用户原话。
  const laterInput = chat.summaryRequests.at(-1).messages[1].content;
  assert.doesNotMatch(laterInput, /USER: Untrusted conversation memory/);
  assert.match(laterInput, /Previous summary of even older history/, "旧摘要走「上一份摘要」这一路，不是 USER 轮次");
});

test("历史摘要：摘要为空或不合格时不提交替换，原上下文保持不变", async () => {
  const script = [
    callTool("c1", "echo", { value: "a" }),
    finalReply("first answer " + "a".repeat(1_200)),
    callTool("c2", "echo", { value: "b" }),
    finalReply("second answer " + "b".repeat(1_200)),
    finalReply("third answer"),
  ];

  for (const summary of ["", "too short", "x".repeat(20_000)]) {
    const chat = createModel({ replies: script, summary });
    const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 3_000 });
    await agent.run("first task");
    await agent.run("second task");
    const before = agent.transcript.length;
    await agent.run("third task");

    assert.equal(agent.compactionStats.compactions, 0, `不合格摘要不能提交：${summary.slice(0, 12)}`);
    assert.ok(!hasMemoryMessage(agent.transcript), "没提交就不该留下摘要消息");
    assert.ok(agent.transcript.length >= before, "旧历史必须还在");
    assert.ok(agent.compactionStats.lastError.length > 0, "失败原因要留下，不能静默");
  }
});

test("历史摘要：缺少后四节或超过本次限长时，原始回答仍在业务请求里", async () => {
  const valid = compactNineSections();
  for (const summary of [valid.split("## Current Work")[0], valid + "x".repeat(80), valid.replace("## Optional Next Step", "## Primary Request and Intent"), valid.slice(0, valid.lastIndexOf("\n"))]) {
    const original = "old answer " + "x".repeat(2_800);
    const chat = createModel({ replies: [finalReply(original), finalReply("done")], summary });
    const agent = makeAgent({
      llm: chat, tools: makeRegistry([]), systemPrompt: "x",
      contextWindowTokens: 1_050, outputTokenReserve: 0,
    });
    await agent.run("first");
    await agent.run("second");
    assert.equal(chat.summaryRequests.length, 1);
    assert.equal(agent.compactionStats.compactions, 0);
    assert.ok(chat.businessRequests.at(-1).messages.some(message => message.content === original));
  }
});

test("历史摘要：失败配额用完后不再重复写存档，失败的那份被回滚", async () => {
  await withWorkspace(async root => {
    const replies = Array.from({ length: 9 }, (_, step) =>
      callToolWithNotes(String(step), "echo", { value: String(step) }, "n".repeat(2_500)));
    const chat = createModel({ replies: [...replies, finalReply("done")], summary: "invalid" });
    const agent = makeAgent({
      llm: chat, tools: makeRegistry([echoTool()]), contextArchiveDir: root, maxTranscriptChars: 8_000,
    });
    await agent.run("task");
    // 配额只给两次：不能为同一批历史反复写存档、反复付费。
    assert.equal(chat.summaryRequests.length, 2);
    // 两次都没提交，刚写的两份存档也就没有引用者：必须回滚，不能留下孤儿文件。
    const [session] = await readdir(root);
    assert.deepEqual(await readdir(path.join(root, session)), []);
  });
});

test("历史摘要：摘要请求失败时不提交替换", async () => {
  const script = [
    callTool("c1", "echo", { value: "a" }),
    finalReply("first answer " + "a".repeat(1_200)),
    callTool("c2", "echo", { value: "b" }),
    finalReply("second answer " + "b".repeat(1_200)),
    finalReply("third answer"),
  ];
  const chat = createModel({ replies: script, summary: new ModelHttpError(500, "upstream exploded") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 3_000 });

  await agent.run("first task");
  await agent.run("second task");
  const before = agent.transcript.length;
  await agent.run("third task");

  assert.equal(agent.compactionStats.compactions, 0);
  assert.ok(agent.transcript.length >= before);
  assert.match(agent.compactionStats.lastError, /upstream exploded/);
});

test("历史摘要：压缩途中取消，不提交摘要也不继续发请求", async () => {
  const controller = new AbortController();
  const script = [
    callTool("c1", "echo", { value: "a" }),
    finalReply("first answer " + "a".repeat(1_200)),
    callTool("c2", "echo", { value: "b" }),
    finalReply("second answer " + "b".repeat(1_200)),
    finalReply("third answer"),
  ];
  const chat = createModel({
    replies: script,
    summary: summaryWith("cancelled"),
    // 摘要请求「返回」的同时用户按了 Ctrl-C：这时不能提交，也不能再发业务请求。
    beforeSummaryReply: () => controller.abort(),
  });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    maxTranscriptChars: 3_000,
    signal: controller.signal,
  });

  await agent.run("first task");
  await agent.run("second task");
  await assert.rejects(() => agent.run("third task"), /cancelled/);

  assert.equal(agent.compactionStats.compactions, 0);
  assert.ok(!hasMemoryMessage(agent.transcript));
});

test("历史摘要：摘要请求报错的同时用户取消，取消不被降级成「摘要失败，继续跑」", async () => {
  const controller = new AbortController();
  const chat = createModel({
    replies: [finalReply("first answer " + "a".repeat(3_000)), finalReply("done")],
    // 两个信号同时到：摘要请求失败，用户也按了 Ctrl-C。
    summary: () => {
      controller.abort();
      return new ModelHttpError(500, "summary exploded");
    },
  });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([]),
    // 窗口刻意配得很紧：压不动就必然超硬上限。没有取消出口的话，这次 Run 会被
    // 误报成「context window is too small」，而不是「用户按了 Ctrl-C」。
    contextWindowTokens: 1_400,
    outputTokenReserve: 100,
    signal: controller.signal,
  });

  await agent.run("first task");
  await assert.rejects(
    () => agent.run("second task"),
    (error) => {
      // 取消要往上抛，而不是被 catch 当成「摘要失败，接着发业务请求」。
      assert.match(error.message, /cancelled/);
      assert.doesNotMatch(error.message, /context window is too small/);
      return true;
    },
  );

  assert.equal(chat.summaryRequests.length, 1, "取消前那次摘要请求确实发出过");
  assert.equal(agent.compactionStats.compactions, 0, "取消不提交摘要");
  assert.equal(agent.stats.summaryRequests, 1);
  assert.match(agent.compactionStats.lastError, /summary exploded/, "失败原因要留下，不能因为取消就丢掉");
  assert.equal(chat.businessRequests.length, 1, "取消之后不能再发业务请求");
});

test("历史摘要：摘要请求不带工具、单独计数，用量照记", async () => {
  const script = [
    callTool("c1", "echo", { value: "a" }),
    finalReply("first answer " + "a".repeat(1_200)),
    callTool("c2", "echo", { value: "b" }),
    finalReply("second answer " + "b".repeat(1_200)),
    finalReply("third answer"),
  ];
  const chat = createModel({ replies: script, summary: summaryWith("counted") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 3_000 });

  await agent.run("first task");
  await agent.run("second task");
  await agent.run("third task");

  assert.equal(chat.summaryRequests[0].tools.length, 0, "摘要请求不许调用工具");
  assert.equal(agent.stats.summaryRequests, 1);
  assert.equal(agent.sessionStats.summaryRequests, 1);
  assert.equal(agent.stats.requests, 1, "摘要不是业务 Step，不能混进 requests");
  assert.ok(agent.stats.usage.totalTokens >= 60, "摘要费用必须计入用量");
  assert.equal(agent.stats.usage.reported, 1, "摘要带了 usage，就按已报告统计");
});

test("历史摘要：保留下来的调用仍带 reasoning_content，协议字段不被删", async () => {
  // 单轮长任务：前面的步骤被折叠，最近一步原样保留 —— 它的推理字段也必须原样保留。
  const replies = [];
  for (let step = 1; step <= 6; step++) {
    replies.push({
      ...callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)),
      reasoning_content: "reasoning for step " + step,
    });
  }
  replies.push(finalReply("done"));
  const chat = createModel({ replies, summary: summaryWith("kept-fields") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 8_000 });

  await agent.run("run the steps");

  assert.ok(agent.compactionStats.compactions >= 1, "这个用例的前提是发生过压缩");
  const sent = chat.businessRequests.at(-1).messages;
  const keptCalls = sent.filter((message) => message.role === "assistant" && message.tool_calls !== undefined);
  assert.ok(keptCalls.length >= 1, "最近一步必须留在上下文里");
  assert.ok(keptCalls.every((message) => typeof message.reasoning_content === "string"),
    "仍需按协议回传的推理字段不能被压缩顺手删掉");
});

test("历史摘要：可折范围太小时不请模型，并写明原因", async () => {
  // 一轮只有几百字符：一份合格摘要一定比它长，压缩只会让请求变大，所以干脆别开口。
  const chat = createModel({ replies: [callTool("c1", "echo", { value: "a" }), finalReply("short"), finalReply("second")] });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 1_024 });

  await agent.run("one");
  await agent.run("two");

  assert.equal(chat.summaryRequests.length, 0, "不划算的摘要请求一次都不该发");
  assert.equal(agent.compactionStats.compactions, 0);
  assert.match(agent.compactionStats.lastError, /too small to summarize/);
});

test("历史摘要：摘要长度上限跟着被替换内容走，不是写死一个大数字", async () => {
  const replies = [];
  for (let step = 1; step <= 7; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)));
  }
  replies.push(finalReply("done"));
  const chat = createModel({ replies, summary: summaryWith("budget") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 8_000 });

  await agent.run("run all seven steps");

  const requested = /under (\d+) characters/.exec(chat.summaryRequests[0].messages[0].content);
  assert.ok(requested !== null, "提示词里必须给出这次的长度上限");
  const limit = Number(requested[1]);
  assert.ok(limit > 0 && limit < 12_000, `上限应该由被替换内容算出（实际 ${limit}）`);
});

test("历史摘要：小窗口下摘要请求按可用窗口裁剪，成功后主请求继续", async () => {
  await withWorkspace(async (root) => {
    // 假后端按 3 字符/token 拒绝超窗请求，复现 Codex 报的「摘要自己先被拒」。
    const windowTokens = 1_200;
    const maxRequestChars = windowTokens * 3;
    const replies = [];
    for (let step = 1; step <= 2; step++) {
      replies.push(callToolWithNotes(
        `s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400),
      ));
    }
    // 第一轮攒下可折的旧轮次；摘要请求在第二轮开始时才发生。
    replies.push(finalReply("first run done"));
    replies.push(finalReply("done"));
    const chat = createModel({ replies, summary: summaryWithinStatedLimit, maxRequestChars });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([echoTool()]),
      systemPrompt: () => "x",
      contextWindowTokens: windowTokens,
      outputTokenReserve: 0,
      contextArchiveDir: path.join(root, "archive"),
    });

    await agent.run("first task");
    const reply = await agent.run("second task");

    assert.equal(reply.content, "done", "摘要成功后主请求必须能继续");
    assert.equal(agent.compactionStats.lastError, "");
    assert.ok(chat.summaryRequests.length >= 1, "这段历史需要摘要才装得进小窗口");
    for (const request of chat.summaryRequests) {
      const size = JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
      assert.ok(size <= maxRequestChars, `摘要请求自身不能超窗（${size} > ${maxRequestChars}）`);
      assert.equal(request.tools.length, 0, "摘要请求不带工具，也不递归触发压缩");
    }
    assert.match(agent.transcript[0].content, /Archived originals removed by context compaction/);
    const refs = [...agent.transcript[0].content.matchAll(/^- (.+?) \(\d+ chars\)$/gm)].map((match) => match[1]);
    assert.ok(refs.length >= 1, "摘要输入可以缩短，但原文必须仍可定位");
    const archived = await readFile(refs[0], "utf8");
    assert.match(archived, /step 1/, "存档里是完整原文，不是给摘要看的预览");
  });
});

test("历史摘要：转义密集的历史按序列化后的真实体积裁剪，摘要仍能发出", async () => {
  await withWorkspace(async (root) => {
    const windowTokens = 1_700;
    const maxRequestChars = windowTokens * 3;
    // 反斜杠与换行在 JSON 里各占两个字符：原始 2 200 字符，序列化后接近 4 400。
    // 按原始字符数估的预算会明显偏大，实测才知道真实体积。
    const noise = "\\\n".repeat(1_100) + "END-OF-NOISE";
    const replies = [
      callToolWithNotes("s1", "echo", { value: "1" }, noise),
      finalReply("first run done"),
      finalReply("done"),
    ];
    const chat = createModel({ replies, summary: summaryWith("escaped"), maxRequestChars });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([echoTool()]),
      systemPrompt: () => "x",
      contextWindowTokens: windowTokens,
      outputTokenReserve: 0,
      contextArchiveDir: path.join(root, "archive"),
    });

    await agent.run("first task");
    // 第二个任务足够长：不压缩就必然超窗，所以这条断言同时守着「摘要真的提交了」。
    const reply = await agent.run("second task " + "q".repeat(880));

    assert.equal(reply.content, "done", "缩短摘要输入后摘要必须能生成，主请求继续");
    assert.equal(agent.compactionStats.lastError, "");
    assert.equal(agent.compactionStats.compactions, 1);
    assert.equal(chat.summaryRequests.length, 1, "第一次估算超窗时要缩短重试，不是直接放弃");
    const sent = chat.summaryRequests[0];
    const size = JSON.stringify(sent.messages).length + JSON.stringify(sent.tools).length;
    assert.ok(size <= maxRequestChars, `摘要请求必须按序列化后的体积装进窗口（${size} > ${maxRequestChars}）`);

    // 原文先存档：摘要输入被缩短，不代表原文丢了。
    assert.match(agent.transcript[0].content, /Archived originals removed by context compaction/);
    const refs = [...agent.transcript[0].content.matchAll(/^- (.+?) \(\d+ chars\)$/gm)].map((match) => match[1]);
    assert.ok(refs.length >= 1, "摘要输入可以缩短，但原文必须仍可定位");
    const archived = await readFile(refs[0], "utf8");
    assert.match(archived, /END-OF-NOISE/, "存档里必须是完整原文，包括摘要输入被裁掉的那一段");
    assert.ok(String(sent.messages[1].content).length < archived.length, "摘要输入确实被缩短了，不是原样塞进去");
  });
});

test("摘要长度下限：容得下合法九节结构，又不是随手写的大数字", () => {
  const minimal = compactNineSections();
  assert.equal(compact.validateSummary(minimal), undefined, "这份九节摘要本身必须合格，否则下限无从谈起");
  assert.ok(minimal.length <= compact.MIN_SUMMARY_STRUCTURE_CHARS,
    `下限必须装得下合法九节结构（${minimal.length} > ${compact.MIN_SUMMARY_STRUCTURE_CHARS}）`);
  assert.ok(compact.MIN_SUMMARY_STRUCTURE_CHARS - minimal.length <= 64,
    `下限要跟着结构走，不能比它大出一截（${compact.MIN_SUMMARY_STRUCTURE_CHARS} vs ${minimal.length}）`);
  assert.ok(compact.MIN_SUMMARY_STRUCTURE_CHARS >= compact.MIN_SUMMARY_CHARS, "结构下限不能低于摘要的合格下限");
});

test("历史摘要：输出预留为 0 时仍给合法九节摘要留够长度，压缩能提交", async () => {
  // 输出预留为 0 是最容易写错的一档：摘要正文上限若退回 MIN_SUMMARY_CHARS，
  // 提示词就变成「必须写满九节，但不超过 120 字符」—— 模型怎么写都不合格。
  const chat = createModel({
    replies: [finalReply("a".repeat(2_800)), finalReply("done")],
    summary: summaryWithinStatedLimit,
  });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    systemPrompt: () => "x",
    contextWindowTokens: 900,
    outputTokenReserve: 0,
  });

  await agent.run("first task");
  const reply = await agent.run("second task");

  assert.equal(reply.content, "done", "摘要提交之后主请求必须能继续");
  assert.equal(agent.compactionStats.lastError, "");
  assert.equal(agent.compactionStats.compactions, 1);
  const memory = memoryMessage(chat.businessRequests.at(-1).messages);
  for (const section of [
    "Primary Request and Intent",
    "Key Technical Concepts",
    "Files and Code Sections",
    "Errors and fixes",
    "Problem Solving",
    "All user messages",
    "Pending Tasks",
    "Current Work",
    "Optional Next Step",
  ]) {
    assert.ok(memory.content.includes(`## ${section}`), `提交的摘要必须保留小节「${section}」`);
  }
});

test("历史摘要：窗口装不下最小合法摘要时不发摘要请求，明确失败", async () => {
  // 窗口 660 token = 1 980 字符：装得下摘要系统提示，装不下「提示 + 一段像样的历史」。
  // 这时候发出去的请求必然写不出合格摘要，只能明确失败。
  const chat = createModel({
    replies: [finalReply("a".repeat(2_800)), finalReply("done")],
    summary: summaryWithinStatedLimit,
  });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    systemPrompt: () => "x",
    contextWindowTokens: 660,
    outputTokenReserve: 0,
  });

  await agent.run("first task");
  await assert.rejects(() => agent.run("second task"), /context window is too small for this request/);

  assert.match(agent.compactionStats.lastError, /too small for a safe summary/);
  assert.equal(chat.summaryRequests.length, 0, "明知写不出合格摘要就不能把请求发出去");
  assert.equal(chat.businessRequests.length, 1, "第一轮之后立刻停手，不反复试");
});

test("历史摘要：窗口连摘要提示都装不下时明确失败，不发超窗摘要请求", async () => {
  const chat = createModel({
    replies: [finalReply("a".repeat(3_000)), finalReply("done")],
    summary: summaryWith("never-sent"),
  });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    systemPrompt: () => "x",
    contextWindowTokens: 1_500,
    outputTokenReserve: 1_200,
  });

  await agent.run("first task");
  await assert.rejects(() => agent.run("second task"), /context window is too small for this request/);

  assert.match(agent.compactionStats.lastError, /too small for a safe summary/);
  assert.equal(chat.summaryRequests.length, 0, "明知摘要请求会超窗就不能发出去");
  assert.equal(chat.businessRequests.length, 1, "第一轮那次小请求之后立刻停手，不反复试");
  assert.equal(agent.sessionStats.requests, 1, "不能为了压缩陷入请求循环");
});

test("历史摘要：压缩后 system 里留下可定位、可恢复的原文引用", async () => {
  await withWorkspace(async (root) => {
    const replies = [];
    for (let step = 1; step <= 7; step++) {
      replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)));
    }
    replies.push(finalReply("done"));
    const chat = createModel({ replies, summary: summaryWith("indexed") });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([echoTool()]),
      maxTranscriptChars: 8_000,
      contextArchiveDir: path.join(root, "archive"),
    });

    await agent.run("run all seven steps");

    assert.ok(agent.compactionStats.compactions >= 1, "这个用例的前提是发生过压缩");
    const system = agent.transcript[0].content;
    assert.match(system, /Archived originals removed by context compaction/,
      "摘要之外还要有宿主生成的存档清单：摘要写得再差也不会把「原话在哪」一起丢掉");
    const listed = [...system.matchAll(/^- (.+?) \(\d+ chars\)$/gm)].map((match) => match[1]);
    assert.ok(listed.length >= 1, "至少要列出这次压缩的存档");

    // 清单里的路径必须真的能读，而且内容就是被折叠掉的原文（含被省略的步骤）。
    const body = await readFile(listed[0], "utf8");
    assert.match(body, /step 1 /, "存档里要有被折叠的原始步骤");
    assert.match(body, /"role": "tool"/, "存档是完整的消息序列，不是预览");
  });
});

test("历史压缩：候选被拒时，刚写的历史存档被回滚，不留孤儿文件", async () => {
  await withWorkspace(async (root) => {
    // 同样不放工具结果：存档目录里只可能出现这次历史压缩写的那一份。
    const chat = createModel({
      replies: [finalReply("first answer " + "a".repeat(3_000)), finalReply("done")],
      // 摘要长度合规，但控制字符序列化后每个占六个字符，候选反而变大 —— 提交校验会拒绝它。
      summary: (_round, messages) => {
        const limit = Number(/under (\d+) characters/.exec(messages[0].content)[1]);
        return compactNineSections().padEnd(limit, "\u0001");
      },
    });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([]),
      maxTranscriptChars: 3_000,
      contextArchiveDir: root,
    });

    await agent.run("first task");
    await agent.run("second task");

    assert.equal(agent.compactionStats.compactions, 0, "候选没通过验证就不能提交");
    assert.match(agent.compactionStats.lastError, /did not shrink/);
    // 没提交就没有引用者：那份完整历史既不在 system 清单里，也没有消息指向它。
    const [session] = await readdir(root);
    assert.deepEqual(await readdir(path.join(root, session)), [],
      "候选被拒后不能留下无人引用的存档");
  });
});

test("提交原子性：提交阶段抛异常时什么都没提交，恢复后四份状态互相对得上", async () => {
  await withWorkspace(async (root) => {
    const chat = createModel({
      replies: [finalReply("first answer " + "a".repeat(3_000)), finalReply("done")],
      summary: summaryWith("atomic"),
    });
    const agent = makeAgent({
      llm: chat,
      tools: makeRegistry([]),
      maxTranscriptChars: 3_000,
      contextArchiveDir: root,
    });
    await agent.run("first task");

    // 提交块里唯一可能抛异常的语句，是 rememberArchive() 里那次 push（其余都是普通字段赋值）。
    // 在实例上换掉它，就能在「存档已经写盘、会话状态还没提交」的那一刻注入一次失败。
    // 这是刻意的白盒故障注入：这个失败点没有别的外部入口。
    const context = agent.context;
    const archives = context.archivedOriginals;
    const before = agent.transcript.length;
    archives.push = () => { throw new Error("commit boom"); };
    try {
      await assert.rejects(() => agent.run("second task"), /commit boom/);
    } finally {
      delete archives.push;
    }

    // ① 什么都没提交：摘要、上下文、计数都不动，刚写的存档被回滚。
    assert.equal(agent.compactionStats.compactions, 0, "提交没走完就不算压缩成功");
    assert.equal(agent.compactionStats.archiveFailures, 0, "存档本身是成功的，失败发生在提交阶段");
    assert.ok(!hasMemoryMessage(agent.transcript), "不能留下半份摘要");
    assert.equal(agent.transcript.length, before + 1, "只多了这次任务的 user 消息，历史一条都没少");
    const [session] = await readdir(root);
    assert.deepEqual(await readdir(path.join(root, session)), [],
      "没登记就没有引用者：存档必须回滚，不能留下孤儿文件");

    // ② 恢复之后照常提交：清单、摘要、上下文、磁盘文件必须一一对应。
    await agent.run("third task");
    assert.equal(agent.compactionStats.compactions, 1);

    const transcript = agent.transcript;
    assert.match(memoryMessage(transcript).content, /atomic/);
    const system = transcript[0].content;
    const listed = [...system.matchAll(/^- (.+?) \(\d+ chars\)$/gm)].map((match) => match[1]);
    const hidden = Number(/(\d+) older archive\(s\) not listed/.exec(system)?.[1] ?? 0);
    assert.ok(listed.length >= 1, "提交成功后清单里必须有这次压缩的存档");
    for (const file of listed) {
      assert.match(await readFile(file, "utf8"), /first answer/,
        "清单里写出的路径必须真的可读 —— 不允许出现指向不存在文件的存档索引");
    }
    const files = await readdir(path.join(root, session));
    assert.equal(files.length, listed.length + hidden,
      "磁盘文件数 = 列出的 + 声明未列出的：多了是孤儿，少了是悬空引用");
  });
});

test("历史摘要：失败配额按 Run 重算，不会永久关闭压缩", async () => {
  const replies = [];
  for (let step = 1; step <= 7; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)));
  }
  replies.push(finalReply("done"));
  const chat = createModel({ replies, summary: new Error("summary boom") });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 8_000 });

  const perRun = [];
  for (const task of ["one", "two", "three", "four"]) {
    const before = chat.summaryRequests.length;
    await agent.run(task);
    perRun.push(chat.summaryRequests.length - before);
  }

  assert.ok(perRun.every((count) => count <= 2), `单个 Run 内最多浪费两次：${perRun.join(",")}`);
  assert.ok(perRun.slice(1).some((count) => count > 0),
    `后面的 Run 必须还能再试，不能一次坏运气就永久关闭：${perRun.join(",")}`);
  assert.ok(agent.compactionStats.summaryFailures >= 2);
  assert.match(agent.compactionStats.lastError, /summary boom/);
});

test("历史摘要：摘要花掉预算后，不再发业务请求", async () => {
  const replies = [];
  for (let step = 1; step <= 7; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)));
  }
  replies.push(finalReply("done"));
  const chat = createModel({ replies, summary: summaryWith("budget") });
  // 摘要一次 60 token，预算只给 50：摘要把额度用光之后，那一步的业务请求不能再发。
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    maxTranscriptChars: 8_000,
    maxTotalTokens: 50,
  });

  await assert.rejects(() => agent.run("run all seven steps"), /token budget 50 reached/);
  const summaryAt = chat.requests.findIndex((request) => request.summary);
  assert.ok(summaryAt >= 0, "这个用例的前提是发生过一次摘要请求");
  assert.equal(chat.requests.slice(summaryAt + 1).filter((request) => !request.summary).length, 0,
    "预算已被摘要用光，后面不能再有业务请求");
});

test("历史摘要：摘要返回后立刻取消，用量只记一次", async () => {
  const controller = new AbortController();
  const replies = [];
  for (let step = 1; step <= 5; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(1_400)));
  }
  replies.push(finalReply("done"));
  const chat = createModel({
    replies,
    summary: summaryWith("cancelled-after-reply"),
    businessUsage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    beforeSummaryReply: () => controller.abort(),
  });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    maxTranscriptChars: 8_000,
    signal: controller.signal,
  });

  await assert.rejects(() => agent.run("run all steps"), /cancelled/);

  const usage = agent.stats.usage;
  assert.equal(usage.reported, 1 + chat.businessRequests.length,
    "每次请求各记一次：业务请求 + 摘要请求，不多不少");
  assert.equal(usage.unknown, 0, "取消不能被当成一次「请求失败」再记一笔未知用量");
  assert.equal(agent.stats.summaryRequests, 1);
  assert.equal(agent.compactionStats.compactions, 0, "取消不提交摘要");
});

test("历史摘要：格式合格但没缩小的摘要也只给两次机会，不无限重试", async () => {
  const replies = [];
  for (let step = 1; step <= 6; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(2_500)));
  }
  replies.push(finalReply("done"));
  // 原始长度合规，但控制字符序列化后占六个字符，仍会让候选变大。
  const chat = createModel({ replies, summary: (_round, messages) => {
    const limit = Number(/under (\d+) characters/.exec(messages[0].content)[1]);
    return compactNineSections().padEnd(limit, "\u0001");
  } });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 8_000 });

  await agent.run("run all six steps");

  assert.equal(agent.compactionStats.compactions, 0, "没缩小的候选不能提交");
  assert.equal(chat.summaryRequests.length, 2,
    "格式合格不算成功：候选被拒仍要计入失败配额，一个 Run 最多两次");
  assert.match(agent.compactionStats.lastError, /did not shrink/);
});

// ---------------------------------------------------------------------------
// 上下文溢出：只认明确超限，最多恢复一次
// ---------------------------------------------------------------------------

/** 上游明确说「输入装不下窗口」的错误；这是唯一允许触发压缩恢复的形状。 */
function contextOverflowError() {
  return new ModelHttpError(400, "This model's maximum context length is 8192 tokens, however you requested 9000 tokens");
}

test("溢出：明确超限时做一次更强压缩并重发一次，不重跑工具", async () => {
  let runs = 0;
  const bigEcho = {
    ...echoTool(),
    run: async () => {
      runs++;
      return "z".repeat(12_000);
    },
  };
  const script = [callTool("c1", "echo", { value: "a" }), finalReply("first"), finalReply("second")];
  // 第 3 次业务请求（第二个 Run 的第一次）被上游判为超限：估算没超，真实窗口超了。
  const chat = createModel({ replies: script, failures: [undefined, undefined, contextOverflowError()] });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([bigEcho]),
    contextWindowTokens: 8_000,
    outputTokenReserve: 1_000,
  });

  await agent.run("first task");
  const reply = await agent.run("second task");

  assert.equal(reply.content, "second");
  assert.equal(agent.stats.overflowRetries, 1);
  assert.equal(chat.businessRequests.length, 4, "超限一次 + 重发一次，不能反复试");
  const before = JSON.stringify(chat.businessRequests[2].messages).length;
  const after = JSON.stringify(chat.businessRequests[3].messages).length;
  assert.ok(after < before, "重发前必须确认请求真的变小了");
  assert.equal(runs, 1, "恢复不能重跑已经完成的工具");
  assert.equal(agent.stats.requests - agent.retryAttempts, agent.runReplies.length,
    "超限重发也要计入「没有产生回复的请求」");
});

test("上游拒绝远小于本地预算的请求时，按被拒请求缩小未消费结果后重发", async () => {
  const chat = createModel({
    replies: [callTool("c1", "echo", { value: "read" }), finalReply("done")],
    failures: [undefined, contextOverflowError()],
  });
  const agent = makeAgent({
    llm: chat, tools: makeRegistry([{ ...echoTool(), run: async () => "x".repeat(8_000) }]),
  });
  assert.equal((await agent.run("read once")).content, "done");
  const [first, rejected, retried] = chat.businessRequests;
  assert.equal(first.messages.at(-1).role, "user");
  assert.equal(rejected.messages.at(-1).content.length, 8_000);
  assert.ok(retried.messages.at(-1).content.length < 2_000);
  assert.equal(retried.messages.at(-1).tool_call_id, "c1");
  assert.equal(agent.stats.toolCalls, 1);
  assert.equal(agent.stats.summaryRequests, 0);
});

test("溢出：裁剪后仍高于上游真实窗口时，在唯一一次重发前折叠可移除的旧轮次", async () => {
  const replies = createModel({ replies: [
    finalReply("p".repeat(6_000)), callTool("c1", "echo", { value: "read" }), finalReply("done"),
  ] });
  const sizes = [];
  const agent = makeAgent({
    llm: { async chat(messages, tools) {
      const size = serializedWireRequestChars(messages, tools);
      sizes.push(size);
      if (size > 6_500) throw contextOverflowError();
      return replies.chat(messages, tools);
    } },
    tools: makeRegistry([{ ...echoTool(), run: async () => "r".repeat(14_000) }]),
    systemPrompt: "s", maxTranscriptChars: 30_000,
  });
  await agent.run("old");
  assert.equal((await agent.run("new")).content, "done");
  assert.equal(sizes.filter(size => size > 6_500).length, 1);
  assert.equal(agent.stats.overflowRetries, 1);
  assert.equal(agent.stats.toolCalls, 1);
});

test("溢出恢复后遇到 429，仍可使用网络重试额度，已执行工具只跑一次", async () => {
  const chat = createModel({
    replies: [callTool("c1", "echo", { value: "a" }), finalReply("done")],
    failures: [undefined, contextOverflowError(), new ModelHttpError(429, "busy")],
  });
  const retries = [];
  let executions = 0;
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([{ ...echoTool(), run: async () => { executions++; return "z".repeat(100_000); } }]),
    maxSteps: 2, maxTranscriptChars: 120_000, maxModelRetries: 1,
    onRetry: (_error, attempt, limit) => retries.push([attempt, limit]),
  });
  assert.equal((await agent.run("use echo")).content, "done");
  assert.equal(executions, 1);
  assert.deepEqual(retries, [[1, 1]]);
  assert.equal(agent.stats.requests, 4);
  assert.equal(agent.retryAttempts, 2);
  assert.deepEqual(chat.businessRequests.map(r => r.tools.length), [1, 0, 0, 0]);
});

test("溢出：压缩后仍装不下的请求不再发送", async () => {
  const chat = createModel({ replies: [finalReply("done")] });
  // 只有一条超长用户消息，没有可裁剪的结果、也没有可折叠的历史：压缩救不了。
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([]),
    contextWindowTokens: 2_000,
    outputTokenReserve: 500,
  });

  await assert.rejects(
    () => agent.run("y".repeat(20_000)),
    /context window is too small for this request[\s\S]*compaction cannot shrink it further/,
  );
  assert.equal(chat.businessRequests.length, 0, "明知装不下就不要发出去白花钱");
  assert.equal(agent.stats.requests, 0);
});

test("溢出：恢复用的摘要花掉预算后，不再重发业务请求", async () => {
  const replies = [];
  for (let step = 1; step <= 4; step++) {
    replies.push(callToolWithNotes(`s${step}`, "echo", { value: String(step) }, "step " + step + " " + "n".repeat(2_500)));
  }
  replies.push(finalReply("done"));
  const chat = createModel({
    replies,
    summary: summaryWith("recovered"),
    businessUsage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    // 第三次业务请求被上游判为超限：恢复会先压一次，而那次压缩要花一次摘要请求。
    failures: [undefined, undefined, contextOverflowError()],
  });
  const agent = makeAgent({
    llm: chat,
    tools: makeRegistry([echoTool()]),
    contextWindowTokens: 4_000,
    outputTokenReserve: 1_000,
    maxTotalTokens: 50,
  });

  await assert.rejects(() => agent.run("run all four steps"), /token budget 50 reached/);

  const summaryAt = chat.requests.findIndex((request) => request.summary);
  assert.ok(summaryAt >= 0, "这个用例的前提是恢复时真的用摘要腾了空间");
  assert.equal(chat.requests.slice(summaryAt + 1).filter((request) => !request.summary).length, 0,
    "恢复用的摘要也会花钱：重发前必须重新过预算闸门");
  assert.equal(agent.stats.overflowRetries, 0, "没有发出恢复请求");
});

test("溢出：普通 400 不触发压缩恢复", async () => {
  const chat = createModel({
    replies: [finalReply("done")],
    failures: [new ModelHttpError(400, "invalid tool_call: missing function.name")],
  });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 20_000 });

  await assert.rejects(() => agent.run("task"), /invalid tool_call/);
  assert.equal(agent.stats.overflowRetries, 0);
  assert.equal(chat.businessRequests.length, 1, "普通 400 不该被当成上下文超限再试一次");
});

test("溢出：压不动时明确报错，不拿同一个请求反复发", async () => {
  const chat = createModel({ replies: [finalReply("done")], failures: [contextOverflowError()] });
  // 只有一条超长用户消息：没有工具结果可剪，也没有可折叠的旧轮次。
  const agent = makeAgent({ llm: chat, tools: makeRegistry([]), maxTranscriptChars: 20_000 });

  await assert.rejects(
    () => agent.run("x".repeat(30_000)),
    /context window exceeded and could not be reduced/,
  );
  assert.equal(chat.businessRequests.length, 1, "没有实际缩减就不能重发");
  assert.equal(agent.stats.overflowRetries, 0, "没有发出恢复请求");
});

// ---------------------------------------------------------------------------
// 隔离与长任务回放
// ---------------------------------------------------------------------------

test("隔离：两个 Agent 的上下文与摘要互不影响", async () => {
  const script = [
    callTool("c1", "echo", { value: "a" }),
    finalReply("first answer " + "a".repeat(1_200)),
    callTool("c2", "echo", { value: "b" }),
    finalReply("second answer " + "b".repeat(1_200)),
    finalReply("third answer"),
  ];
  const chatA = createModel({ replies: script, summary: summaryWith("agent-a") });
  const chatB = createModel({ replies: script, summary: summaryWith("agent-b") });
  const tools = makeRegistry([echoTool()]);
  const a = makeAgent({ llm: chatA, tools, maxTranscriptChars: 3_000 });
  const b = makeAgent({ llm: chatB, tools, maxTranscriptChars: 3_000 });

  await a.run("first task");
  await a.run("second task");
  await a.run("third task");
  await b.run("only one task");

  assert.match(memoryMessage(a.transcript).content, /agent-a/);
  assert.ok(!hasMemoryMessage(b.transcript), "子会话不该继承别人的摘要");
  assert.equal(b.compactionStats.compactions, 0);
});

test("长任务回放：多轮工具调用与多次压缩后仍能完成并保住目标", async () => {
  // 12 个批次、每批都带一段推理正文：只有折叠步骤才能压下去，光剪工具结果不够。
  const replies = [];
  for (let step = 1; step <= 12; step++) {
    replies.push(callToolWithNotes(`long-${step}`, "echo", { value: String(step) }, "reasoning " + step + " " + "r".repeat(1_400)));
  }
  replies.push(finalReply("finished all twelve steps"));
  const chat = createModel({ replies, summary: (round) => summaryWith(`long-round-${round}`) });
  const agent = makeAgent({ llm: chat, tools: makeRegistry([echoTool()]), maxTranscriptChars: 8_000 });

  const reply = await agent.run("execute the twelve-step checklist");

  assert.equal(reply.content, "finished all twelve steps");
  assert.ok(agent.compactionStats.compactions >= 2, "长任务应该压缩多次");
  assert.equal(agent.stats.toolCalls, 12, "压缩不能吃掉工具调用");

  const transcript = agent.transcript;
  assert.equal(transcript[2].content, "execute the twelve-step checklist", "用户目标必须原样保留");
  assert.ok(memoryMessage(transcript).content.includes(`long-round-${chat.summaryRequests.length}`));
  assert.ok(JSON.stringify(transcript).length < 40_000, "压缩后总量要有界");

  // 每次请求的配对都完整：断一条，下一次请求就会被 API 拒绝。
  for (const request of chat.businessRequests) {
    for (let index = 0; index < request.messages.length; index++) {
      const message = request.messages[index];
      if (message.role !== "assistant" || message.tool_calls === undefined) continue;
      for (const call of message.tool_calls) {
        const result = request.messages[index + 1];
        assert.equal(result?.role, "tool", `request ${chat.businessRequests.indexOf(request)} 缺少工具结果`);
        assert.equal(result?.tool_call_id, call.id);
        index++;
      }
    }
  }
});

/**
 * 文件目的：测「诊断记录」—— 每次请求花了多少、调了哪些工具、每个工具改了哪些文件，
 * 都要如实记下来，供评测时回看；同时不能把密钥写进记录。
 *
 * 文件职责：测 `createEvalDiagnostics()` 的记录内容与脱敏，外加一条跨天 runner 的启动前置检查。
 * 不测评测判分（那是 `eval.test.mjs`）。
 *
 * 内容目录：
 *   - 用例一：跑一轮真实 `Agent`，断言 usage、工具结果、逐工具的文件变化都被记下。
 *   - 用例二：像密钥的参数要变成 `[REDACTED]`，超长字符串只留摘要。
 *   - 用例三：正文 `ERROR:` 与宿主侧 `isError` 分开记录，避免诊断误判。
 *   - 用例四：Shell 状态按失败记录（合成结果与真实 shell 两条路径）。
 *   - 快照边界：特殊文件名不能改写字典原型，大文件降级为元数据并报告覆盖不足。
 *   - 跨天入口：`eval/cross-day.mjs --help` 不该切提交、也不该联系模型。
 *
 * 模块关系：依赖 `src/core/agent.ts`、`src/tools/workspace.ts`、`eval/diagnostics.mjs`、
 * `test/support/harness.mjs`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Agent } from "../src/core/agent.ts";
import { Workspace, createWorkspaceTools } from "../src/tools/workspace.ts";
import { createEvalDiagnostics } from "../eval/diagnostics.mjs";
import { makeRegistry } from "./support/harness.mjs";

test("诊断：记录每次请求的 usage、工具结果和逐工具的文件变化", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-eval-diagnostics-"));
  let request = 0;
  const llm = {
    async chat() {
      request += 1;
      if (request === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "note.txt", content: "hello" }),
              },
            }],
          },
          usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
        };
      }
      return {
        message: { role: "assistant", content: "done" },
        usage: { prompt_tokens: 175, completion_tokens: 4, total_tokens: 179 },
      };
    },
  };

  const tools = makeRegistry([{
    name: "write_file",
    description: "Write a test file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    run: async (args) => {
      await writeFile(path.join(workdir, args.path), args.content, "utf8");
      return "wrote " + args.content.length + " chars to " + args.path;
    },
  }]);

  try {
    const diagnostics = await createEvalDiagnostics({ llm, tools, workdir });
    const agent = new Agent({
      llm: diagnostics.llm,
      tools,
      onToolResult: diagnostics.onToolResult,
    });

    const reply = await agent.run("create note.txt");
    const trace = await diagnostics.finish();

    assert.equal(reply.content, "done");
    assert.equal(await readFile(path.join(workdir, "note.txt"), "utf8"), "hello");

    assert.equal(trace.requests.length, 2);
    assert.deepEqual(
      trace.requests.map(({ promptTokens, completionTokens, totalTokens }) => ({
        promptTokens,
        completionTokens,
        totalTokens,
      })),
      [
        { promptTokens: 120, completionTokens: 12, totalTokens: 132 },
        { promptTokens: 175, completionTokens: 4, totalTokens: 179 },
      ],
    );
    assert.equal(trace.requests[1].promptTokenDelta, 55);
    assert.equal(trace.requests[0].systemPromptChars > 0, true);
    assert.equal(trace.requests[0].conversationChars > 0, true);
    assert.equal(trace.requests[0].toolDefinitionChars > 0, true);
    assert.equal(trace.summary.requests, 2);
    assert.equal(trace.summary.toolCalls, 1);
    assert.equal(trace.summary.tools.write_file.calls, 1);

    assert.equal(trace.toolCalls.length, 1);
    const tool = trace.toolCalls[0];
    assert.equal(tool.requestIndex, 1);
    assert.equal(tool.name, "write_file");
    assert.deepEqual(tool.arguments, { path: "note.txt", content: "hello" });
    assert.equal(tool.resultKind, "text");
    assert.equal(tool.resultChars, "wrote 5 chars to note.txt".length);
    assert.equal(tool.resultBytes, Buffer.byteLength("wrote 5 chars to note.txt"));
    assert.deepEqual(tool.fileChanges, [{ path: "note.txt", change: "added", afterBytes: 5 }]);
    assert.deepEqual(trace.fileChanges, [{ path: "note.txt", change: "added", afterBytes: 5 }]);
    assert.equal(trace.snapshotCoverage.initial.complete, true);
    assert.equal(trace.snapshotCoverage.final.complete, true);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("诊断：ERROR 正文与宿主侧错误状态独立记录", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-eval-diagnostics-"));
  let request = 0;
  const llm = {
    async chat() {
      request++;
      if (request === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "literal_error", type: "function", function: { name: "read_literal", arguments: "{}" } },
              { id: "actual_error", type: "function", function: { name: "fail_tool", arguments: "{}" } },
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const tools = makeRegistry([
    {
      name: "read_literal",
      description: "Return file content that happens to begin with ERROR.",
      parameters: { type: "object", properties: {} },
      run: async () => "ERROR: this is literal file content",
    },
    {
      name: "fail_tool",
      description: "Return an explicit host-side tool failure.",
      parameters: { type: "object", properties: {} },
      run: async () => ({ content: "ERROR: genuine tool failure", isError: true }),
    },
  ]);

  try {
    const diagnostics = await createEvalDiagnostics({ llm, tools, workdir });
    const agent = new Agent({ llm: diagnostics.llm, tools, onToolResult: diagnostics.onToolResult });
    await agent.run("read a file and run a failing tool");
    const trace = await diagnostics.finish();

    assert.deepEqual(trace.toolCalls.map((tool) => tool.resultKind), ["text", "error"]);
    assert.equal(trace.toolCalls[0].resultPreview, undefined);
    assert.equal(trace.toolCalls[1].resultPreview, "ERROR: genuine tool failure");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("诊断：Shell 非零退出、超时与取消按失败记录，退出 0 仍算成功", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-eval-diagnostics-"));
  const results = new Map([
    ["exit 0", "exit 0\nok"],
    ["exit 3", "exit 3\nboom"],
    ["slow", "timeout after 50ms\npartial"],
    ["cancel", "cancelled by signal\npartial"],
  ]);
  let request = 0;
  const llm = {
    async chat() {
      request++;
      if (request === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [...results.keys()].map((command, index) => ({
              id: "shell-" + index,
              type: "function",
              function: { name: "shell", arguments: JSON.stringify({ command }) },
            })),
          },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const tools = makeRegistry([{
    name: "shell",
    description: "Return a shell-shaped result without running a process.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    run: async (args) => results.get(args.command),
  }]);

  try {
    const diagnostics = await createEvalDiagnostics({ llm, tools, workdir });
    const agent = new Agent({ llm: diagnostics.llm, tools, onToolResult: diagnostics.onToolResult });
    await agent.run("run four shell-shaped calls");
    const trace = await diagnostics.finish();

    // 宿主侧 isError 对这四次调用都是 false；诊断必须自己认出 Shell 的失败状态。
    assert.deepEqual(trace.toolCalls.map((tool) => tool.resultKind),
      ["text", "error", "error", "error"]);
    assert.equal(trace.summary.toolErrors, 3);
    assert.equal(trace.summary.tools.shell.calls, 4);
    assert.equal(trace.summary.tools.shell.errors, 3);
    assert.equal(trace.toolCalls[1].resultPreview, "exit 3\nboom".slice(0, 200));
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("诊断：真实 shell 非零退出记为 error，成功命令记为 text", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-eval-diagnostics-"));
  let request = 0;
  const llm = {
    async chat() {
      request++;
      if (request === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "shell_fail",
                type: "function",
                function: {
                  name: "shell",
                  arguments: JSON.stringify({
                    command: `node -e "console.log('boom'); process.exitCode = 3"`,
                  }),
                },
              },
              {
                id: "shell_ok",
                type: "function",
                function: { name: "shell", arguments: JSON.stringify({ command: "echo ok" }) },
              },
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const tools = makeRegistry(createWorkspaceTools(new Workspace({ root: workdir })));

  try {
    const diagnostics = await createEvalDiagnostics({ llm, tools, workdir });
    const agent = new Agent({ llm: diagnostics.llm, tools, onToolResult: diagnostics.onToolResult });
    await agent.run("run a failing shell command and a successful one");
    const trace = await diagnostics.finish();

    assert.deepEqual(trace.toolCalls.map((tool) => tool.resultKind), ["error", "text"]);
    assert.ok(trace.toolCalls[0].resultPreview.startsWith("exit 3"), trace.toolCalls[0].resultPreview);
    assert.equal(trace.summary.toolErrors, 1);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("诊断：脱敏像密钥的参数，并摘要超长字符串", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-eval-diagnostics-"));
  const secret = "do-not-store-this-key";
  const largeContent = "x".repeat(700);
  let request = 0;
  const llm = {
    async chat() {
      request += 1;
      if (request === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_args",
              type: "function",
              function: {
                name: "inspect_args",
                arguments: JSON.stringify({ api_key: secret, content: largeContent }),
              },
            }],
          },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const tools = makeRegistry([{
    name: "inspect_args",
    description: "Accept test arguments.",
    parameters: { type: "object", properties: {} },
    run: async () => "ok",
  }]);

  try {
    const diagnostics = await createEvalDiagnostics({ llm, tools, workdir });
    const agent = new Agent({ llm: diagnostics.llm, tools, onToolResult: diagnostics.onToolResult });
    await agent.run("inspect");
    const trace = await diagnostics.finish();

    const args = trace.toolCalls[0].arguments;
    assert.equal(args.api_key, "[REDACTED]");
    assert.equal(args.content.type, "string");
    assert.equal(args.content.chars, 700);
    assert.equal(args.content.sha256.length, 64);
    assert.equal(JSON.stringify(trace).includes(secret), false);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("诊断：命令参数、Bearer 和错误输出里的凭据也必须脱敏", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-eval-diagnostics-"));
  const githubToken = "ghp_0123456789abcdefghijklmnopqrstuv";
  const bearerToken = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const openaiKey = "sk-proj-0123456789abcdefghijklmnopqrstuv";
  let request = 0;
  const llm = {
    async chat() {
      request++;
      if (request === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "secret-command",
              type: "function",
              function: {
                name: "leaky_tool",
                arguments: JSON.stringify({
                  command: "curl -H 'Authorization: Bearer " + bearerToken + "' && export OPENAI_API_KEY=" + openaiKey,
                }),
              },
            }],
          },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const tools = makeRegistry([{
    name: "leaky_tool",
    description: "Return a diagnostic error containing a credential-like string.",
    parameters: { type: "object", properties: {} },
    run: async () => ({ content: "ERROR: " + githubToken, isError: true }),
  }]);

  try {
    const diagnostics = await createEvalDiagnostics({ llm, tools, workdir });
    const agent = new Agent({ llm: diagnostics.llm, tools, onToolResult: diagnostics.onToolResult });
    await agent.run("inspect safely");
    const trace = await diagnostics.finish();
    const serialized = JSON.stringify(trace);
    for (const secret of [githubToken, bearerToken, openaiKey]) {
      assert.equal(serialized.includes(secret), false, "diagnostic output must not contain credential material");
    }
    assert.match(trace.toolCalls[0].arguments.command, /REDACTED/);
    assert.match(trace.toolCalls[0].resultPreview, /REDACTED/);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("诊断：__proto__ 文件名的新增和修改均被如实记录", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-eval-diagnostics-"));
  try {
    const tools = makeRegistry([]);
    const diagnostics = await createEvalDiagnostics({ llm: { chat: async () => ({}) }, tools, workdir });
    await writeFile(path.join(workdir, "__proto__"), "hello");
    assert.deepEqual((await diagnostics.finish()).fileChanges,
      [{ path: "__proto__", change: "added", afterBytes: 5 }]);
    const second = await createEvalDiagnostics({ llm: { chat: async () => ({}) }, tools, workdir });
    await writeFile(path.join(workdir, "__proto__"), "changed");
    assert.deepEqual((await second.finish()).fileChanges,
      [{ path: "__proto__", change: "modified", beforeBytes: 5, afterBytes: 7 }]);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("诊断：超大文件只用元数据降级，小文件仍完整哈希并报告覆盖不足", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-eval-diagnostics-"));
  try {
    await writeFile(path.join(workdir, "large.txt"), Buffer.alloc(1_000_001, 65));
    await writeFile(path.join(workdir, "small.txt"), "hello");
    const diagnostics = await createEvalDiagnostics({ llm: { chat: async () => ({}) }, tools: makeRegistry([]), workdir });
    const trace = await diagnostics.finish();
    assert.equal(trace.snapshotCoverage.initial.complete, false);
    assert.equal(trace.snapshotCoverage.initial.hashedBytes, 5);
    assert.equal(trace.snapshotCoverage.final.hashedBytes, 5);
    assert.deepEqual(trace.fileChanges, []);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});


test("跨天 runner：--help 不需要切换提交，也不联系模型", () => {
  const runner = fileURLToPath(new URL("../eval/cross-day.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [runner, "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /eac798de31b24463dba09361b8c2c551e1e114d2/);
  assert.match(result.stdout, /eval\/baselines\/cross-day/);
});

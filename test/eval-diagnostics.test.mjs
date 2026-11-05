import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { ToolRegistry } from "../src/tool-registry.ts";
import { createEvalDiagnostics } from "../eval/diagnostics.mjs";

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

  const tools = new ToolRegistry([{
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
  const tools = new ToolRegistry([{
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

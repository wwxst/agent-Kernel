/**
 * 诊断层的单元测试：它必须只观察、不改结果，并把请求、工具、文件变化记全。
 * 这些数据是 Phase 3 高方差分析的唯一来源，形状错了会直接导向错误结论。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DiagnosticRecorder } from "../eval/diagnostics.mjs";

async function withDir(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-diagnostics-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolCall(name, args, id = "c1") {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("诊断：包装 chat 记录每次请求的 usage、消息大小和工具调用数", async () => {
  await withDir(async (root) => {
    const recorder = new DiagnosticRecorder({ root });
    const client = {
      async chat() {
        return {
          message: { role: "assistant", content: "ok", tool_calls: [] },
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
      },
    };

    const response = await recorder.wrap(client).chat(
      [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
      ],
      [],
    );

    assert.equal(response.message.content, "ok", "诊断层不能改响应");
    const [request] = recorder.toJSON().requests;
    assert.equal(request.index, 1);
    assert.equal(request.messageCount, 2);
    assert.equal(request.messageChars, 10, "rules + hello");
    assert.equal(request.toolCalls, 0);
    assert.deepEqual(request.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });
});

test("诊断：请求失败也留一条记录，usage 记为 null", async () => {
  await withDir(async (root) => {
    const recorder = new DiagnosticRecorder({ root });
    const client = {
      async chat() {
        throw new Error("network down");
      },
    };

    await assert.rejects(() => recorder.wrap(client).chat([], []), /network down/);

    const [request] = recorder.toJSON().requests;
    assert.equal(request.failed, true);
    assert.equal(request.usage, null);
    assert.match(request.error, /network down/);
  });
});

test("诊断：write 之后记录文件大小与 hash 的变化", async () => {
  await withDir(async (root) => {
    await writeFile(path.join(root, "a.txt"), "hello");
    const recorder = new DiagnosticRecorder({ root });

    await writeFile(path.join(root, "a.txt"), "hello world");
    recorder.onToolResult(toolCall("write", { path: "a.txt", content: "hello world" }), "wrote 11 chars to a.txt");

    const [tool] = recorder.toJSON().tools;
    assert.equal(tool.name, "write");
    assert.equal(tool.index, 1);
    assert.equal(tool.file.path, "a.txt");
    assert.equal(tool.file.beforeBytes, 5);
    assert.equal(tool.file.afterBytes, 11);
    assert.equal(tool.file.deltaBytes, 6);
    assert.notEqual(tool.file.beforeSha256, tool.file.afterSha256);
    assert.ok(tool.file.afterSha256);
  });
});

test("诊断：工具顺序、结果大小与超长参数都被记录", async () => {
  await withDir(async (root) => {
    const recorder = new DiagnosticRecorder({ root });
    const longContent = "x".repeat(500);

    recorder.onToolResult(toolCall("read", { path: "a.txt" }, "c1"), "line1\nline2");
    await writeFile(path.join(root, "b.txt"), longContent);
    recorder.onToolResult(toolCall("write", { path: "b.txt", content: longContent }, "c2"), "wrote 500 chars to b.txt");

    const { tools } = recorder.toJSON();
    assert.deepEqual(tools.map((tool) => tool.name), ["read", "write"]);
    assert.deepEqual(tools.map((tool) => tool.index), [1, 2]);
    assert.equal(tools[0].resultChars, 11);
    assert.equal(tools[0].resultLines, 2);
    assert.equal(tools[0].args.path, "a.txt");
    assert.equal(tools[1].args.content.length, 301, "长文本截断到 300 字 + 省略号");
    assert.equal(tools[1].args.contentChars, 500, "但保留原始长度");
    assert.equal(tools[1].file.beforeBytes, null, "新文件没有 before");
    assert.equal(tools[1].file.afterBytes, 500);
  });
});

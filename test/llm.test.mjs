/**
 * Llm 的单元测试：网络响应是外部输入，这里钉死「读不懂的响应必须报错」。
 *
 * 最要紧的两类：空 message（以前会被当成正常回复，CLI 空着退出 0），
 * 以及 finish_reason = length / content_filter（半截输出被当成了完整答案）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { ChatResponseError } from "../src/errors.ts";
import { Llm } from "../src/llm.ts";

/** 起一个只会回固定 JSON 的假端点。 */
async function respondWith(payload) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function clientFor(url) {
  return new Llm({ baseUrl: url, apiKey: "test-key", model: "mock-model" });
}

/** 起一个回 SSE 的假端点；每项要么是对象（自动 JSON），要么是原始字符串。 */
async function respondWithStream(frames) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) {
        response.write(`data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function streamingClient(url) {
  return new Llm({ baseUrl: url, apiKey: "test-key", model: "mock-model", stream: true });
}

/** 一个带 delta 的流式 chunk；finish_reason 只有最后一帧才有。 */
function streamDelta(delta, finishReason = null) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

const usageFrame = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };

/** 用一条 message（外加默认的 finish_reason）跑一次 chat。 */
async function chatWith(message, finishReason = "stop") {
  const payload = { choices: [{ index: 0, message, finish_reason: finishReason }] };
  const server = await respondWith(payload);
  try {
    return await clientFor(server.url).chat([], []);
  } finally {
    await server.close();
  }
}

/** 同上，但期望抛错。 */
async function expectReject(message, pattern, finishReason = "stop") {
  const payload = { choices: [{ index: 0, message, finish_reason: finishReason }] };
  const server = await respondWith(payload);
  try {
    await assert.rejects(() => clientFor(server.url).chat([], []), pattern);
  } finally {
    await server.close();
  }
}

test("chat：合法响应被归一化，只保留协议字段", async () => {
  const { message } = await chatWith(
    {
      role: "assistant",
      content: null,
      reasoning_content: "先看文件。",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read", arguments: '{"path":"a"}' },
          extra: "厂商私有字段",
        },
      ],
      annotations: [{ type: "url_citation", url: "https://example.com" }],
    },
    // 带工具调用时，finish_reason 必须是 tool_calls；stop 会被一致性校验拒绝。
    "tool_calls",
  );

  assert.deepEqual(message, {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
    reasoning_content: "先看文件。",
  });
});

test("chat：保留 usage，字段原样归一化", async () => {
  const payload = {
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cache_hit_tokens: 0 },
  };
  const server = await respondWith(payload);
  try {
    const result = await clientFor(server.url).chat([], []);
    assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  } finally {
    await server.close();
  }
});

test("chat：没有 usage 时是未知，不是 0", async () => {
  const { usage } = await chatWith({ role: "assistant", content: "ok" });

  assert.equal(usage, undefined);
});

test("chat：usage 字段类型不对必须报错（不能悄悄当成未知）", async () => {
  const payload = {
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3 },
  };
  const server = await respondWith(payload);
  try {
    await assert.rejects(
      () => clientFor(server.url).chat([], []),
      /usage\.prompt_tokens must be a non-negative integer/,
    );
  } finally {
    await server.close();
  }
});

test("chat：请求体带上单次输出上限 max_tokens", async () => {
  const server = await respondWith({
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  });
  try {
    const client = new Llm({
      baseUrl: server.url,
      apiKey: "test-key",
      model: "mock-model",
      maxOutputTokens: 1234,
    });
    await client.chat([], []);

    assert.equal(server.requests[0].max_tokens, 1234);
  } finally {
    await server.close();
  }
});

test("chat：message 是空对象时必须报错，不能变成空成功", async () => {
  await expectReject({}, /choices\[0\]\.message\.role must be "assistant"/);
});

test("chat：finish_reason=stop 却带工具调用必须拒绝", async () => {
  await expectReject(
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
    },
    /finish_reason "stop" must not include tool_calls/,
    "stop",
  );
});

test("chat：finish_reason=tool_calls 却没有工具调用必须拒绝", async () => {
  await expectReject(
    { role: "assistant", content: "done", tool_calls: [] },
    /finish_reason "tool_calls" requires a non-empty tool_calls array/,
    "tool_calls",
  );
});

test("chat：同一批工具调用出现重复 id 必须拒绝", async () => {
  await expectReject(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "same", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "same", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    },
    /tool_calls\[1\]\.id duplicates "same"/,
    "tool_calls",
  );
});

test("chat：stop 带空 tool_calls 数组按「没有工具调用」处理", async () => {
  const { message } = await chatWith({ role: "assistant", content: "ok", tool_calls: [] }, "stop");

  assert.equal(message.tool_calls, undefined);
});

test("chat：响应形状不合法时，已返回的 usage 随错误带出", async () => {
  const payload = {
    choices: [{ index: 0, message: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
  };
  const server = await respondWith(payload);
  try {
    await assert.rejects(
      () => clientFor(server.url).chat([], []),
      (error) => {
        assert.ok(error instanceof ChatResponseError);
        assert.deepEqual(error.usage, { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 });
        assert.match(error.message, /choices\[0\]\.message\.role must be "assistant"/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("chat：content 类型不对必须报错", async () => {
  await expectReject({ role: "assistant", content: 42 }, /content must be a string or null/);
});

test("chat：content 字段缺失也必须报错（和 null 不是一回事）", async () => {
  await expectReject({ role: "assistant" }, /content must be a string or null/);
});

test("chat：tool_calls 不是数组必须报错", async () => {
  await expectReject({ role: "assistant", content: "", tool_calls: {} }, /tool_calls must be an array/);
});

test("chat：tool_call 结构不完整必须报错", async () => {
  await expectReject(
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read" } }],
    },
    /tool_calls\[0\]\.function\.arguments must be a string/,
  );
});

test("chat：reasoning_content 不是字符串必须报错", async () => {
  await expectReject(
    { role: "assistant", content: "", reasoning_content: 1 },
    /reasoning_content must be a string/,
  );
});

test("chat：finish_reason = length 必须报错（输出被截断）", async () => {
  await expectReject(
    { role: "assistant", content: "写了一半" },
    /finish_reason "length": the response was truncated/,
    "length",
  );
});

test("chat：finish_reason = content_filter 必须报错", async () => {
  await expectReject(
    { role: "assistant", content: null },
    /finish_reason "content_filter": the response was filtered/,
    "content_filter",
  );
});

test("chat：缺 finish_reason 也要报错（不能靠猜）", async () => {
  const payload = { choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] };
  const server = await respondWith(payload);
  try {
    await assert.rejects(() => clientFor(server.url).chat([], []), /unexpected finish_reason undefined/);
  } finally {
    await server.close();
  }
});

test("chat：取消信号立刻中断请求，不必等 120 秒超时", async () => {
  // 这个端点永远不回响应：只有 abort 能让请求结束。
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const controller = new AbortController();
  const client = new Llm({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
    model: "mock-model",
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("user interrupt")), 50);

  const started = Date.now();
  try {
    await assert.rejects(
      () => client.chat([], []),
      (error) => error.name === "AbortError" || /abort|interrupt/i.test(error.message),
    );
    assert.ok(Date.now() - started < 5_000, "取消应该马上生效");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("流式：正文分片拼成完整消息，onDelta 逐段回调，usage 保留", async () => {
  const server = await respondWithStream([
    streamDelta({ role: "assistant", content: "Hel" }),
    streamDelta({ content: "lo" }),
    streamDelta({}, "stop"),
    usageFrame,
  ]);
  try {
    const seen = [];
    const result = await streamingClient(server.url).chat([], [], {
      onDelta: (text) => seen.push(text),
    });

    assert.equal(result.message.role, "assistant");
    assert.equal(result.message.content, "Hello");
    assert.deepEqual(seen, ["Hel", "lo"], "增量只用于显示，拼装以完整消息为准");
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    // 请求体必须声明流式，并显式要 usage —— 不然最后一方块就没有账单。
    assert.equal(server.requests[0].stream, true);
    assert.deepEqual(server.requests[0].stream_options, { include_usage: true });
  } finally {
    await server.close();
  }
});

test("流式：tool_calls 按 index 合并，id/name/arguments 分片拼装", async () => {
  const server = await respondWithStream([
    streamDelta({
      role: "assistant",
      tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: "" } }],
    }),
    streamDelta({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
    streamDelta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
    streamDelta({}, "tool_calls"),
  ]);
  try {
    const result = await streamingClient(server.url).chat([], []);
    assert.equal(result.message.content, "");
    assert.deepEqual(result.message.tool_calls, [
      { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
    ]);
  } finally {
    await server.close();
  }
});

test("流式：两个工具调用交错到达时，按 index 各归各的", async () => {
  const server = await respondWithStream([
    streamDelta({
      tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "one", arguments: "{}" } }],
    }),
    streamDelta({
      tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "two", arguments: "{}" } }],
    }),
    streamDelta({}, "tool_calls"),
  ]);
  try {
    const result = await streamingClient(server.url).chat([], []);
    assert.deepEqual(
      result.message.tool_calls.map((call) => call.id),
      ["a", "b"],
    );
  } finally {
    await server.close();
  }
});

test("流式：reasoning_content 也会累积，并跟着消息回传", async () => {
  const server = await respondWithStream([
    streamDelta({ role: "assistant", reasoning_content: "先想" }),
    streamDelta({ reasoning_content: "一下" }),
    streamDelta({ content: "done" }),
    streamDelta({}, "stop"),
  ]);
  try {
    const result = await streamingClient(server.url).chat([], []);
    assert.equal(result.message.reasoning_content, "先想一下");
    assert.equal(result.message.content, "done");
  } finally {
    await server.close();
  }
});

test("流式：finish_reason=length 说明被截断，必须报错", async () => {
  const server = await respondWithStream([streamDelta({ content: "half" }, "length")]);
  try {
    await assert.rejects(() => streamingClient(server.url).chat([], []), /truncated/);
  } finally {
    await server.close();
  }
});

test("流式：连接断了、没有 finish_reason 时不能当成完整回复", async () => {
  const server = await respondWithStream([streamDelta({ content: "half" })]);
  try {
    await assert.rejects(
      () => streamingClient(server.url).chat([], []),
      (error) => error instanceof ChatResponseError &&
        error.code === "stream_incomplete" &&
        /stream ended before the model finished/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test("流式：坏 chunk 直接报错，不能悄悄跳过", async () => {
  const server = await respondWithStream(["{not json"]);
  try {
    await assert.rejects(() => streamingClient(server.url).chat([], []), /stream chunk is not JSON/);
  } finally {
    await server.close();
  }
});

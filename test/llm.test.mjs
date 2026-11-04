/**
 * Llm 的单元测试：网络响应是外部输入，这里钉死「读不懂的响应必须报错」。
 *
 * 最要紧的两类：空 message（以前会被当成正常回复，CLI 空着退出 0），
 * 以及 finish_reason = length / content_filter（半截输出被当成了完整答案）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
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
  const message = await chatWith({
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
  });

  assert.deepEqual(message, {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
    reasoning_content: "先看文件。",
  });
});

test("chat：message 是空对象时必须报错，不能变成空成功", async () => {
  await expectReject({}, /choices\[0\]\.message\.role must be "assistant"/);
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

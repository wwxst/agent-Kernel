/**
 * Llm 的单元测试：网络响应是外部输入，这里钉死「读不懂的响应必须报错」。
 *
 * 最重要的用例是空 message：以前它会被当成一条正常回复（content 变空串、没有 tool_calls），
 * Agent 以为任务完成了 —— 错误响应被当成成功响应，正是 §11 要治理的那类问题。
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

/** 起服务、跑用例、关服务。 */
async function withEndpoint(payload, run) {
  const server = await respondWith(payload);
  try {
    return await run(server.url);
  } finally {
    await server.close();
  }
}

test("chat：合法响应被归一化，只保留协议字段", async () => {
  const payload = {
    choices: [
      {
        message: {
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
      },
    ],
  };

  await withEndpoint(payload, async (url) => {
    const message = await clientFor(url).chat([], []);

    assert.deepEqual(message, {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
      reasoning_content: "先看文件。",
    });
  });
});

test("chat：message 是空对象时必须报错，不能变成空成功", async () => {
  await withEndpoint({ choices: [{ message: {} }] }, async (url) => {
    await assert.rejects(
      () => clientFor(url).chat([], []),
      /LLM response is invalid: choices\[0\]\.message\.role must be "assistant"/,
    );
  });
});

test("chat：choices 缺失必须报错", async () => {
  await withEndpoint({}, async (url) => {
    await assert.rejects(() => clientFor(url).chat([], []), /choices must be a non-empty array/);
  });
});

test("chat：content 类型不对必须报错", async () => {
  await withEndpoint({ choices: [{ message: { role: "assistant", content: 42 } }] }, async (url) => {
    await assert.rejects(() => clientFor(url).chat([], []), /content must be a string or null/);
  });
});

test("chat：tool_calls 不是数组必须报错", async () => {
  await withEndpoint({ choices: [{ message: { role: "assistant", content: "", tool_calls: {} } }] }, async (url) => {
    await assert.rejects(() => clientFor(url).chat([], []), /tool_calls must be an array/);
  });
});

test("chat：tool_call 结构不完整必须报错", async () => {
  const payload = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read" } }],
        },
      },
    ],
  };

  await withEndpoint(payload, async (url) => {
    await assert.rejects(() => clientFor(url).chat([], []), /tool_calls\[0\]\.function\.arguments must be a string/);
  });
});

test("chat：reasoning_content 不是字符串必须报错", async () => {
  await withEndpoint({ choices: [{ message: { role: "assistant", content: "", reasoning_content: 1 } }] }, async (url) => {
    await assert.rejects(() => clientFor(url).chat([], []), /reasoning_content must be a string/);
  });
});

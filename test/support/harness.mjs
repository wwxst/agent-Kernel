/**
 * 测试夹具：脚本化的假模型 + 临时工作区。
 *
 * 假模型实现了 ChatClient 这个接口（也就是 Agent 唯一依赖的那条缝），
 * 所以循环可以在同一个进程里被完整驱动：不需要 API Key、不联网、毫秒级。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 「模型要调工具」的一条 assistant 消息。 */
export function callTool(id, name, args) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** 「模型收尾」的一条 assistant 消息：没有工具调用，循环到此结束。 */
export function finalReply(content) {
  return { role: "assistant", content, tool_calls: [] };
}

/**
 * 按脚本回放的 ChatClient。请求次数超出脚本长度时重复最后一条，保证 agent 总能收尾。
 *
 * 脚本项可以是一条 Message，也可以是 `{ message, usage }` —— 后者用来测 token 统计。
 * 每次请求都做一次深拷贝再存起来：Agent 接下来会继续往自己的 messages 里 push，
 * 不拷贝的话断言看到的是「未来」的历史，而非当时的请求。
 */
export function createScriptedChat(script) {
  const requests = [];
  let turn = 0;

  return {
    requests,
    async chat(messages, tools) {
      requests.push(structuredClone({ messages, tools }));
      const entry = structuredClone(script[Math.min(turn++, script.length - 1)]);
      // 普通 Message 脚本没有 message 字段；带用量的脚本写成 { message, usage }。
      const message = entry.message ?? entry;
      return entry.usage === undefined ? { message } : { message, usage: entry.usage };
    },
  };
}

/** 一个最小可用的工具：把参数原样回显成结果。 */
export function echoTool() {
  return {
    name: "echo",
    description: "Echo the value back.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    run: async (args) => `echo ${String(args.value)}`,
  };
}

/** 每个用例一个临时工作区，跑完就删。 */
export async function withWorkspace(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-kernel-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

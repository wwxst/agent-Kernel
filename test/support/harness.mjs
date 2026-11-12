/**
 * 文件目的：测试用的公共夹具 —— 一个按剧本回话的假模型，加一个临时目录当工作区。
 *
 * 假模型实现了核心循环唯一依赖的那个「能聊天的客户端」，
 * 所以一整轮可以在同一个进程里跑完：不用密钥、不联网、几毫秒出结果。
 *
 * 文件职责：负责造消息、造假客户端、造最小工具、造临时工作区。
 * 不负责断言、不负责启动进程 —— 那些留给各个测试文件自己写。
 *
 * 内容目录：
 *   - `callTool()` / `finalReply()`：造「要调工具」与「收尾」两种 assistant 消息。
 *   - `createScriptedChat()`：按脚本回放的假客户端；脚本超出长度就重复最后一条，
 *     每次请求都深拷贝存档，否则断言会看到「未来」的历史。
 *   - `echoTool()`：最小可用工具，把参数原样回显。
 *   - `makeRegistry()`：直接装配 `ToolRegistry`（注册表已没有权限层）。
 *   - `withWorkspace()`：每个用例一个临时目录，跑完就删。
 *
 * 模块关系：依赖 `src/core/tool-registry.ts` 与 Node 内置模块。
 * 被 `agent.test.mjs`、`tool-registry.test.mjs`、`workspace.test.mjs`、`cli.test.mjs`、
 * `cli-pty.test.mjs`、`eval-diagnostics.test.mjs` 共用；不参与 `npm test` 之外的事情。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../src/core/tool-registry.ts";

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

/** 测试里只关心循环/注册表本身；注册表不再有权限层，直接装配即可。 */
export function makeRegistry(tools) {
  return new ToolRegistry(tools);
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

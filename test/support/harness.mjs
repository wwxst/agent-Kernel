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
 *   - `SUMMARY_PROMPT_MARKER` / `CANNED_SUMMARY`：摘要请求的识别标记与一份形状合格的假摘要；
 *     摘要请求不消耗脚本项，避免把「第几次业务请求」数错。
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
 *
 * 摘要请求（上下文压缩让模型写交接摘要）单独认：它带着摘要专用的系统提示，且不带工具。
 * 这类请求不消耗脚本项 —— 否则「第 N 次业务请求回什么」会被摘要请求挤掉，
 * 测试就变成在数请求下标，而不是在验行为。`requests` 里仍然逐条记录，用 `summary` 标记区分。
 */
export function createScriptedChat(script, options = {}) {
  const requests = [];
  let turn = 0;

  return {
    requests,
    async chat(messages, tools) {
      const summary = messages.length > 0 && messages[0].role === "system" &&
        typeof messages[0].content === "string" && messages[0].content.includes(SUMMARY_PROMPT_MARKER);
      requests.push(structuredClone({ messages, tools, summary }));
      if (summary) {
        const content = options.summary ?? CANNED_SUMMARY;
        return content === null
          ? { message: { role: "assistant", content: "" } }
          : { message: { role: "assistant", content }, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
      }
      const entry = structuredClone(script[Math.min(turn++, script.length - 1)]);
      // 普通 Message 脚本没有 message 字段；带用量的脚本写成 { message, usage }。
      const message = entry.message ?? entry;
      return entry.usage === undefined ? { message } : { message, usage: entry.usage };
    },
  };
}

/** 摘要请求的识别标记：来自 `SUMMARY_SYSTEM_PROMPT` 的第一句。 */
export const SUMMARY_PROMPT_MARKER = "You are writing a handoff record for a coding session.";

/** 默认的假摘要：八个标题齐全、长度过门槛，形状上和真摘要一样合格。 */
export const CANNED_SUMMARY = [
  "## User goal",
  "Finish the current task.",
  "## Requirements and constraints",
  "Keep changes small.",
  "## Decisions and reasons",
  "None yet.",
  "## Completed work and verification",
  "Earlier tool calls were executed.",
  "## Current work and progress",
  "Continuing the task.",
  "## Key files, commands, errors, findings",
  "None recorded.",
  "## Open questions and todos",
  "None.",
  "## Next step",
  "Continue.",
].join("\n");

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
    // Windows 上刚退出的子进程可能短暂占用目录。重试有界，持续占用仍会报错。
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

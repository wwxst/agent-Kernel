/**
 * 评测诊断层：只观察，不改变 Agent 行为。
 *
 * 挂载点只有两个，都是现有接口，不需要动 Agent Loop / Workspace：
 *   1. `wrap(client)` 包住 ChatClient，记录每次模型请求的 usage 与上下文大小；
 *   2. `onToolResult(call, result)` 作为 Agent 的回调，记录工具名、参数、顺序和结果大小，
 *      并在 write / edit 之后记录文件大小与 hash 的变化。
 *
 * 输出是给评测分析用的 JSON，不参与内核决策；关掉它，Agent 的行为完全相同。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** 参数里的长文本（write 的 content）只留开头这么多，避免诊断文件比工作区还大。 */
const MAX_ARG_CHARS = 300;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashFile(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

/** 跑任务前给工作区拍一张快照，之后才能说清 write / edit 改了多少。 */
function snapshotFiles(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(full);
      files.set(path.relative(root, full), { bytes: stat.size, sha256: hashFile(full) });
    }
  };
  walk(root);
  return files;
}

/** 消息字符数：精确 token 只有端点知道，这里只作为「上下文有没有变大」的旁证。 */
function countMessageChars(messages) {
  let total = 0;
  for (const message of messages) {
    total += (message.content ?? "").length;
    total += (message.reasoning_content ?? "").length;
    for (const call of message.tool_calls ?? []) {
      total += call.function.name.length + call.function.arguments.length;
    }
  }
  return total;
}

function parseArguments(call) {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    // 坏 JSON 会由 ToolRegistry 折成 ERROR；诊断层不重复报错，只记空参数。
    return {};
  }
}

function summarizeArguments(args) {
  const summarized = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > MAX_ARG_CHARS) {
      summarized[key] = `${value.slice(0, MAX_ARG_CHARS)}…`;
      summarized[`${key}Chars`] = value.length;
    } else {
      summarized[key] = value;
    }
  }
  return summarized;
}

export class DiagnosticRecorder {
  constructor({ root }) {
    this.root = root;
    this.startedAt = Date.now();
    this.requests = [];
    this.tools = [];
    /** 当前已知的文件状态：任务开始时是快照，之后每次 write / edit 更新。 */
    this.files = snapshotFiles(root);
  }

  /** 包一层 ChatClient：行为完全透传，只额外记录这一轮的 usage 与上下文大小。 */
  wrap(client) {
    return {
      chat: async (messages, tools) => {
        const index = this.requests.length + 1;
        const startedAt = Date.now();
        let response;
        try {
          response = await client.chat(messages, tools);
        } catch (error) {
          this.requests.push({
            index,
            durationMs: Date.now() - startedAt,
            messageCount: messages.length,
            messageChars: countMessageChars(messages),
            usage: null,
            failed: true,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        this.requests.push({
          index,
          durationMs: Date.now() - startedAt,
          messageCount: messages.length,
          messageChars: countMessageChars(messages),
          usage: response.usage ?? null,
          toolCalls: response.message.tool_calls?.length ?? 0,
          contentChars: (response.message.content ?? "").length,
        });
        return response;
      },
    };
  }

  /** 作为 Agent.onToolResult：记录调用顺序、参数、结果大小，以及 write / edit 的文件变化。 */
  onToolResult(call, result) {
    const args = parseArguments(call);
    const entry = {
      index: this.tools.length + 1,
      name: call.function.name,
      args: summarizeArguments(args),
      resultChars: result.length,
      resultLines: result.split("\n").length,
      resultHead: (result.split("\n")[0] ?? "").slice(0, 160),
      elapsedMs: Date.now() - this.startedAt,
    };

    const file = this.fileChange(call.function.name, args);
    if (file !== undefined) entry.file = file;
    this.tools.push(entry);
  }

  /** 只在 write / edit 之后读文件；读失败就记 null，不掩盖工具本身的成功/失败。 */
  fileChange(name, args) {
    if ((name !== "write" && name !== "edit") || typeof args.path !== "string") return undefined;

    const absolute = path.resolve(this.root, args.path);
    const relative = path.relative(this.root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { path: args.path, outsideWorkspace: true };
    }

    const before = this.files.get(relative);
    let after;
    try {
      const stat = statSync(absolute);
      after = { bytes: stat.size, sha256: hashFile(absolute) };
      this.files.set(relative, after);
    } catch {
      after = undefined;
    }

    return {
      path: relative.split(path.sep).join("/"),
      beforeBytes: before?.bytes ?? null,
      afterBytes: after?.bytes ?? null,
      deltaBytes: before !== undefined && after !== undefined ? after.bytes - before.bytes : null,
      beforeSha256: before?.sha256 ?? null,
      afterSha256: after?.sha256 ?? null,
    };
  }

  toJSON() {
    return {
      root: this.root,
      startedAt: new Date(this.startedAt).toISOString(),
      requests: this.requests,
      tools: this.tools,
    };
  }
}

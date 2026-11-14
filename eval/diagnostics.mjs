/**
 * 文件目的：评测时的「旁听记录」—— 悄悄记下每次请求花了多少、工具返回了多大、
 * 工作区里哪些文件被改了。
 *
 * 为什么放在主程序外面：它只是趴在旁边看，不该被主程序依赖。评测要复盘「模型为什么没做成」，
 * 这些事实只能在这里抓；但主程序不能为了评测多背一份逻辑。
 *
 * 文件职责：负责包装 `Llm` 与 `ToolRegistry` 收集旁听数据、给工作区拍前后快照、脱敏。
 * 不负责判分（`run.mjs`）、不负责改主程序行为 —— 包装后行为与原对象一致。
 *
 * 内容目录：
 *   - `createEvalDiagnostics()`：唯一导出，包装 `llm` 和既有工具，返回客户端、结果回调与读取记录入口。
 *   - 内部：`snapshotFiles()` 拍文件快照、`diffSnapshots()` 对比前后、`sanitizeValue()` /
 *     `sanitizeArguments()` 抹掉密钥、`safeJsonLength()` 只算长度不存全文。
 *   - 上限常量：文件数、条目数、单文件与总计哈希字节；`SKIP_DIRECTORIES` 跳过 `.git` / `node_modules`。
 *
 * 模块关系：依赖 `src/protocol/errors.ts`（`ChatResponseError`、`describeError`）与 Node 内置模块。
 * 被 `run.mjs` 使用，`test/eval-diagnostics.test.mjs` 覆盖记录与脱敏行为。
 */
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { ChatResponseError, describeError } from "../src/protocol/errors.ts";

const MAX_TRACKED_FILES = 2_000;
const MAX_TRACKED_ENTRIES = 5_000;
const MAX_HASH_BYTES_PER_FILE = 1_000_000;
const MAX_TOTAL_HASH_BYTES = 20_000_000;
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);
const SECRET_KEY = /(?:api[_-]?key|token|secret|password|authorization|credential)/i;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeJsonLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function sanitizeValue(value, key = "", depth = 0) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";

  if (typeof value === "string") {
    if (value.length <= 512) return value;
    return {
      type: "string",
      chars: value.length,
      bytes: Buffer.byteLength(value),
      sha256: hash(value),
      preview: value.slice(0, 120) + "…",
    };
  }

  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, key, depth + 1));
  }

  const entries = Object.entries(value).slice(0, 100);
  return Object.fromEntries(entries.map(([childKey, childValue]) => [
    childKey,
    sanitizeValue(childValue, childKey, depth + 1),
  ]));
}

function sanitizeArguments(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return sanitizeValue(parsed);
    }
    return { value: sanitizeValue(parsed) };
  } catch {
    return { invalidJson: sanitizeValue(raw) };
  }
}

async function snapshotFiles(root) {
  // 文件名可以是 __proto__；无原型字典不会把它误当成对象的原型设置器。
  const files = Object.create(null);
  const warnings = [];
  let visitedFiles = 0;
  let visitedEntries = 0;
  let hashedBytes = 0;
  let complete = true;

  async function walk(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push("cannot read " + (relativeDirectory || ".") + ": " + describeError(error));
      complete = false;
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      if (visitedEntries >= MAX_TRACKED_ENTRIES) {
        complete = false;
        warnings.push("entry limit reached (" + MAX_TRACKED_ENTRIES + ")");
        return;
      }
      if (!entry.isDirectory() && visitedFiles >= MAX_TRACKED_FILES) {
        complete = false;
        warnings.push("file limit reached (" + MAX_TRACKED_FILES + ")");
        return;
      }
      visitedEntries += 1;

      const relative = relativeDirectory ? relativeDirectory + "/" + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute, relative);
        if (!complete && visitedFiles >= MAX_TRACKED_FILES) return;
        continue;
      }

      visitedFiles += 1;
      if (entry.isSymbolicLink()) {
        files[relative] = { kind: "symlink", size: 0, fingerprint: "symlink" };
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const handle = await open(absolute, "r");
        let info;
        let fingerprint;
        let fingerprintKind;
        try {
          info = await handle.stat();
          if (!info.isFile()) throw new Error("file type changed before snapshot");
          // stat 只决定读多少，不承诺文件不再增长；实际读取必须在句柄上有界。
          if (info.size <= MAX_HASH_BYTES_PER_FILE && hashedBytes + info.size <= MAX_TOTAL_HASH_BYTES) {
            const buffer = Buffer.alloc(info.size + 1);
            let bytesRead = 0;
            while (bytesRead < buffer.length) {
              const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
              if (read.bytesRead === 0) break;
              bytesRead += read.bytesRead;
            }
            if (bytesRead === info.size) {
              fingerprint = hash(buffer.subarray(0, bytesRead));
              fingerprintKind = "sha256";
              hashedBytes += bytesRead;
            } else {
              warnings.push("file changed during snapshot: " + relative);
            }
          }
          if (fingerprint === undefined) {
            fingerprint = "metadata:" + info.size + ":" + info.mtimeMs;
            fingerprintKind = "metadata";
            complete = false;
          }
        } finally {
          await handle.close();
        }
        files[relative] = {
          kind: "file",
          size: info.size,
          fingerprint,
          fingerprintKind,
        };
      } catch (error) {
        warnings.push("cannot fingerprint " + relative + ": " + describeError(error));
        complete = false;
      }
    }
  }

  await walk(root, "");
  return {
    files,
    coverage: {
      complete,
      visitedFiles,
      visitedEntries,
      hashedBytes,
      warnings,
    },
  };
}

function diffSnapshots(before, after) {
  const previous = before?.files ?? {};
  const current = after?.files ?? {};
  const names = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  const changes = [];

  for (const name of names) {
    const oldFile = previous[name];
    const newFile = current[name];
    if (oldFile === undefined) {
      changes.push({ path: name, change: "added", afterBytes: newFile.size });
    } else if (newFile === undefined) {
      changes.push({ path: name, change: "deleted", beforeBytes: oldFile.size });
    } else if (oldFile.fingerprint !== newFile.fingerprint || oldFile.kind !== newFile.kind) {
      changes.push({
        path: name,
        change: "modified",
        beforeBytes: oldFile.size,
        afterBytes: newFile.size,
      });
    }
  }
  return changes;
}

/**
 * 包装一次评测任务使用的 Llm 与 ToolRegistry。
 * 包装器保留原始模型/工具返回值；诊断失败单独记账，不改变任务结果。
 */
export async function createEvalDiagnostics({ llm, tools, workdir }) {
  const startedAt = performance.now();
  const initialSnapshot = await snapshotFiles(workdir);
  let previousSnapshot = initialSnapshot;
  let currentRequestIndex = 0;

  const trace = {
    version: 1,
    requests: [],
    toolCalls: [],
    fileChanges: [],
    snapshotCoverage: { initial: initialSnapshot.coverage },
    diagnosticsErrors: [],
  };

  const eventsByCallId = new Map();
  const noteDiagnosticError = (error) => {
    try {
      trace.diagnosticsErrors.push(describeError(error).slice(0, 500));
    } catch {
      // 诊断记账自身失败也不能改变任务行为。
    }
  };

  const observedLlm = {
    async chat(messages, definitions) {
      const index = trace.requests.length + 1;
      currentRequestIndex = index;
      const requestStarted = performance.now();
      const entry = {
        index,
        taskElapsedMs: Math.round(performance.now() - startedAt),
        requestDurationMs: null,
        messageCount: messages.length,
        messageChars: messages.reduce((total, message) => total + safeJsonLength(message), 0),
        toolCount: definitions.length,
        toolDefinitionChars: safeJsonLength(definitions),
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        usageKnown: false,
      };

      const recordUsage = (usage) => {
        if (usage === undefined || usage === null) return;
        entry.promptTokens = usage.prompt_tokens;
        entry.completionTokens = usage.completion_tokens;
        entry.totalTokens = usage.total_tokens;
        entry.usageKnown = true;
        const previous = [...trace.requests].reverse().find((request) => request.usageKnown);
        if (previous) {
          entry.promptTokenDelta = usage.prompt_tokens - previous.promptTokens;
          entry.promptTokenDeltaFromRequest = previous.index;
        }
      };

      try {
        const response = await llm.chat(messages, definitions);
        recordUsage(response?.usage);
        entry.taskElapsedMs = Math.round(performance.now() - startedAt);
        entry.requestDurationMs = Math.round(performance.now() - requestStarted);
        trace.requests.push(entry);
        return response;
      } catch (error) {
        recordUsage(error instanceof ChatResponseError ? error.usage : undefined);
        entry.taskElapsedMs = Math.round(performance.now() - startedAt);
        entry.requestDurationMs = Math.round(performance.now() - requestStarted);
        entry.error = describeError(error).slice(0, 500);
        trace.requests.push(entry);
        throw error;
      }
    },
  };

  const execute = tools.execute.bind(tools);
  try {
    tools.execute = async (call) => {
      const index = trace.toolCalls.length + 1;
      const started = performance.now();
      let result;
      let thrown;
      let didThrow = false;
      try {
        result = await execute(call);
      } catch (error) {
        didThrow = true;
        thrown = error;
      }

      const executedAt = performance.now();
      let nextSnapshot = previousSnapshot;
      try {
        nextSnapshot = await snapshotFiles(workdir);
      } catch (error) {
        noteDiagnosticError(error);
      }

      const event = {
        index,
        requestIndex: currentRequestIndex,
        toolCallId: call.id,
        name: call.function.name,
        arguments: sanitizeArguments(call.function.arguments),
        executionMs: Math.round(executedAt - started),
        observationMs: Math.round(performance.now() - executedAt),
        fileChanges: diffSnapshots(previousSnapshot, nextSnapshot),
      };
      trace.toolCalls.push(event);
      previousSnapshot = nextSnapshot;

      const queue = eventsByCallId.get(call.id) ?? [];
      queue.push(event);
      eventsByCallId.set(call.id, queue);

      if (didThrow) throw thrown;
      return result;
    };
  } catch (error) {
    noteDiagnosticError(error);
  }

  function onToolResult(call, result) {
    try {
      const queue = eventsByCallId.get(call.id);
      const event = queue?.shift();
      if (!event) return;
      event.resultChars = result.length;
      event.resultBytes = Buffer.byteLength(result);
      event.resultKind = result.startsWith("ERROR:") ? "error" : "text";
      if (event.resultKind === "error") event.resultPreview = result.slice(0, 200);
      if (queue.length === 0) eventsByCallId.delete(call.id);
    } catch (error) {
      noteDiagnosticError(error);
    }
  }

  async function finish() {
    let finalSnapshot = previousSnapshot;
    try {
      finalSnapshot = await snapshotFiles(workdir);
    } catch (error) {
      noteDiagnosticError(error);
    }
    trace.fileChanges = diffSnapshots(initialSnapshot, finalSnapshot);
    trace.snapshotCoverage.final = finalSnapshot.coverage;
    trace.elapsedMs = Math.round(performance.now() - startedAt);
    return trace;
  }

  return { llm: observedLlm, onToolResult, finish };
}

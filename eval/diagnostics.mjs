/**
 * Optional diagnostics for real-model eval runs.
 *
 * This module is deliberately outside src/: it observes the existing ChatClient,
 * ToolRegistry.execute(), and Agent.onToolResult seams without changing Agent Loop behavior.
 * It stores token counts, bounded tool arguments, result sizes, and workspace file deltas.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ChatResponseError, describeError } from "../src/errors.ts";

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
  const files = {};
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
        const info = await lstat(absolute);
        let fingerprint;
        let fingerprintKind;
        if (info.size <= MAX_HASH_BYTES_PER_FILE && hashedBytes + info.size <= MAX_TOTAL_HASH_BYTES) {
          const bytes = await readFile(absolute);
          fingerprint = hash(bytes);
          fingerprintKind = "sha256";
          hashedBytes += bytes.length;
        } else {
          fingerprint = "metadata:" + info.size + ":" + info.mtimeMs;
          fingerprintKind = "metadata";
          complete = false;
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
 * Wrap an existing Llm and ToolRegistry for one eval task.
 * The wrappers never change returned model/tool values; diagnostic failures are recorded and ignored.
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
      // Diagnostics must never alter task behavior.
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

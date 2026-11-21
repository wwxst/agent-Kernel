#!/usr/bin/env node
/**
 * 离线专项评测：用可控假模型验证上下文压缩和工具执行边界，不调用外部模型。
 */
import { Agent } from "../../src/core/agent.ts";
import { SUMMARY_SECTIONS } from "../../src/core/context-compact.ts";
import { ToolRegistry } from "../../src/core/tool-registry.ts";
import path from "node:path";
import { pathToFileURL } from "node:url";

const systemPrompt = "t".repeat(1_086);

function summaryText() {
  return SUMMARY_SECTIONS.map((section) => "## " + section + "\n" + "Preserved facts and decisions. ".repeat(5)).join("\n");
}

function tool(name, run) {
  return {
    name,
    description: "A deterministic test tool.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    run,
  };
}

async function contextCompaction() {
  let businessRequests = 0;
  let summaryRequests = 0;
  const llm = {
    async chat(messages) {
      const first = String(messages[0]?.content ?? "");
      if (first.includes("detailed summary of the conversation so far")) {
        summaryRequests++;
        return {
          message: { role: "assistant", content: summaryText() },
          usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
        };
      }
      businessRequests++;
      if (businessRequests <= 6) {
        return {
          message: {
            role: "assistant",
            content: "Recorded context " + "x".repeat(1_800),
            tool_calls: [{
              id: "compact-" + businessRequests,
              type: "function",
              function: { name: "record", arguments: JSON.stringify({ value: String(businessRequests) }) },
            }],
          },
          usage: { prompt_tokens: 1_000, completion_tokens: 600, total_tokens: 1_600 },
        };
      }
      return {
        message: { role: "assistant", content: "long-context task complete" },
        usage: { prompt_tokens: 1_000, completion_tokens: 20, total_tokens: 1_020 },
      };
    },
  };
  const tools = new ToolRegistry([tool("record", async ({ value }) => "stored " + value)]);
  const agent = new Agent({
    llm, tools, systemPrompt,
    maxSteps: 12, maxTotalTokens: 30_000,
    maxTranscriptChars: 5_000,
  });
  const reply = await agent.run("Preserve every recorded decision and finish the long-context task.");
  const stats = agent.compactionStats;
  if (reply.content !== "long-context task complete") throw new Error("final response was not preserved");
  if (stats.compactions < 1 || summaryRequests < 1 || stats.summaryRequests < 1) {
    throw new Error("long context did not trigger a successful history compaction");
  }
  return { name: "context-compaction", ok: true, businessRequests, summaryRequests, compactions: stats.compactions };
}

async function serialToolBatch() {
  const order = [];
  let request = 0;
  const llm = {
    async chat() {
      request++;
      if (request === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: ["first", "second"].map((value) => ({
              id: "serial-" + value,
              type: "function",
              function: { name: "record", arguments: JSON.stringify({ value }) },
            })),
          },
        };
      }
      return { message: { role: "assistant", content: "batch complete" } };
    },
  };
  const tools = new ToolRegistry([tool("record", async ({ value }) => {
    order.push("start:" + value);
    await Promise.resolve();
    order.push("end:" + value);
    return "done " + value;
  })]);
  const agent = new Agent({ llm, tools, systemPrompt });
  const reply = await agent.run("Run both tools in order.");
  const expected = ["start:first", "end:first", "start:second", "end:second"];
  if (JSON.stringify(order) !== JSON.stringify(expected)) throw new Error("tool calls did not execute serially");
  if (reply.content !== "batch complete") throw new Error("agent did not finish after the tool batch");
  return { name: "serial-tool-batch", ok: true, order };
}

async function toolErrorFeedback() {
  let request = 0;
  let errorWasReturned = false;
  const llm = {
    async chat(messages) {
      request++;
      if (request === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "error-call",
              type: "function",
              function: { name: "fail", arguments: JSON.stringify({ value: "x" }) },
            }],
          },
        };
      }
      errorWasReturned = messages.some((message) => message.role === "tool" && message.content.includes("expected tool failure"));
      return { message: { role: "assistant", content: "recovered after tool failure" } };
    },
  };
  const tools = new ToolRegistry([tool("fail", async () => ({
    content: "expected tool failure",
    isError: true,
  }))]);
  const agent = new Agent({ llm, tools, systemPrompt });
  const reply = await agent.run("Call the tool and recover from its failure.");
  if (!errorWasReturned) throw new Error("tool error state was not returned to the model");
  if (reply.content !== "recovered after tool failure") throw new Error("agent did not recover after tool failure");
  return { name: "tool-error-feedback", ok: true, requests: request };
}

export async function runScenarios() {
  const results = [];
  for (const scenario of [contextCompaction, serialToolBatch, toolErrorFeedback]) {
    try {
      results.push(await scenario());
    } catch (error) {
      results.push({
        name: scenario.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const results = await runScenarios();
  for (const result of results) console.log((result.ok ? "PASS " : "FAIL ") + result.name);
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

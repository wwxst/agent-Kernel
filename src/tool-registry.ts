/**
 * 工具注册表：模型能调用的工具有哪些，以及怎么把一次 Tool call 变成一段文本结果。
 *
 * 它只做一件事，但这件事必须只有一个地方做 —— 所有失败都要折成 "ERROR: ..." 文本。
 * 理由再说一遍，因为这是整个设计里最容易被写错的地方：
 *   - 抛异常 = 循环终止 = 用户得从头再来；
 *   - 返回错误文本 = 模型下一轮读到 "ERROR: ENOENT ..." = 它自己换个路径重试。
 * 后者才是 agent 该有的行为。
 *
 * 规则写在 execute() 里，而不是靠调用方自觉：只要工具调用走这条路，就漏不出去。
 */
import type { Tool, ToolCall, ToolDefinition } from "./types.ts";

/** 把任意抛出物转成一行人类可读的文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 按工具自己的 JSON Schema 校验参数（只覆盖工具定义里真正用到的子集）。
 *
 * 为什么必须做：模型会漏字段、也会给错类型。漏了 `content` 就直接执行 `write`，
 * 结果是把文件清空 —— 一次「看起来成功」的静默破坏，比报错危险得多。
 * 校验放在 execute() 里，和「失败折成文本」同一条路，任何工具都躲不过去。
 */
function validateArguments(tool: Tool, args: Record<string, unknown>): string | undefined {
  const schema = tool.parameters as {
    required?: unknown;
    properties?: Record<string, { type?: string }>;
  };

  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  for (const key of required) {
    if (args[key] === undefined) return `missing required argument "${key}"`;
  }

  for (const [key, value] of Object.entries(args)) {
    const expected = schema.properties?.[key]?.type;
    if (expected === undefined) continue; // 没声明的字段不管，交给工具自己判断
    if (expected === "string" && typeof value !== "string") return `argument "${key}" must be a string`;
    if (expected === "number" && typeof value !== "number") return `argument "${key}" must be a number`;
    if (expected === "boolean" && typeof value !== "boolean") return `argument "${key}" must be a boolean`;
  }

  return undefined;
}

export class ToolRegistry {
  private readonly tools: readonly Tool[];

  constructor(tools: readonly Tool[]) {
    this.tools = tools;
  }

  /** 发给模型的那一半：只有说明书，没有 run。 */
  get definitions(): ToolDefinition[] {
    return this.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /**
   * 按名字执行一次工具调用。
   *
   * 这个函数刻意「永不抛异常」：工具名不存在、参数不是合法 JSON、工具自己炸了，
   * 全部变成一段 ERROR 文本。错误是循环里的常态，不是终止条件。
   */
  async execute(call: ToolCall): Promise<string> {
    const name = call.function.name;
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      // 模型会「幻觉」出不存在的工具名，这不是异常，是正常要处理的分支。
      const available = this.tools.map((candidate) => candidate.name).join(", ");
      // 中文对照：ERROR: 没有这个工具 "{名字}"（可用的有：{列表}）
      return `ERROR: unknown tool "${name}" (available: ${available})`;
    }

    let args: Record<string, unknown>;
    try {
      // arguments 可能为空串（无参工具），也可能被模型写坏 —— 两种都要兜住。
      const parsed: unknown = JSON.parse(call.function.arguments || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        // 中文对照：ERROR: 参数必须是一个 JSON 对象，实际拿到的是 {值}
        return `ERROR: arguments must be a JSON object, got ${JSON.stringify(parsed)}`;
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      // 中文对照：ERROR: 参数不是合法 JSON：{原因}
      return `ERROR: invalid JSON arguments: ${errorMessage(error)}`;
    }

    // 结构不对就到此为止：让模型自己补参数，别让它「带着空值」去改文件。
    const problem = validateArguments(tool, args);
    if (problem !== undefined) {
      // 中文对照：ERROR: 参数不合法：{原因}
      return `ERROR: invalid arguments: ${problem}`;
    }

    try {
      return await tool.run(args);
    } catch (error) {
      // 中文对照：ERROR: {原因}
      return `ERROR: ${errorMessage(error)}`;
    }
  }
}

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
import { describeError, ProcessCleanupError } from "../protocol/errors.ts";
import type { Tool, ToolCall, ToolDefinition } from "../protocol/types.ts";

/** 校验器真正支持的类型；注册时就把超出范围的 Schema 挡掉。 */
const SUPPORTED_PARAMETER_TYPES = new Set(["string", "number", "boolean"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 注册时的 Schema 体检：只接受「这个注册表真的会校验」的形状。
 *
 * 为什么必须在注册时拒绝，而不是等到执行时才发现：一个声明 `array` / `object`
 * 参数的工具会顺利通过 validateArguments（因为校验器不认识这个类型，直接跳过），
 * 于是它「看起来被校验过」—— 这是最危险的一种安全假象。宁可在装配阶段就报错。
 */
function assertSupportedSchema(tool: Tool): void {
  const schema: unknown = tool.parameters;
  if (!isRecord(schema)) {
    throw new Error(`tool "${tool.name}": parameters must be a JSON Schema object`);
  }
  if (schema.type !== "object") {
    throw new Error(`tool "${tool.name}": parameters.type must be "object"`);
  }

  const properties = schema.properties ?? {};
  if (!isRecord(properties)) {
    throw new Error(`tool "${tool.name}": parameters.properties must be an object`);
  }

  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property) || typeof property.type !== "string") {
      throw new Error(`tool "${tool.name}": parameter "${key}" must declare a type`);
    }
    if (!SUPPORTED_PARAMETER_TYPES.has(property.type)) {
      throw new Error(
        `tool "${tool.name}": parameter "${key}" has unsupported type "${property.type}"; ` +
          `supported types: ${[...SUPPORTED_PARAMETER_TYPES].join(", ")}`,
      );
    }
  }

  const required = schema.required;
  if (required === undefined) return;
  if (!Array.isArray(required)) {
    throw new Error(`tool "${tool.name}": parameters.required must be an array of strings`);
  }
  for (const key of required) {
    if (typeof key !== "string") {
      throw new Error(`tool "${tool.name}": parameters.required must contain only strings`);
    }
    if (!Object.hasOwn(properties, key)) {
      throw new Error(
        `tool "${tool.name}": required parameter "${key}" is not declared in parameters.properties`,
      );
    }
  }
}

/**
 * 按工具自己的 JSON Schema 校验参数（只覆盖工具定义里真正用到的子集）。
 *
 * 为什么必须做：模型会漏字段、也会给错类型。漏了 `content` 就直接执行 `write`，
 * 结果是把文件清空 —— 一次「看起来成功」的静默破坏，比报错危险得多。
 * 校验放在 execute() 里，和「失败折成文本」同一条路，任何工具都躲不过去。
 *
 * 覆盖范围刻意很小：只校验 `required` + `string` / `number` / `boolean` 三种类型。
 * 七个内置工具的参数全是字符串，够用；嵌套对象、数组、枚举都不看。
 * 但「不看」不等于「放过」：声明了校验器不认识的类型，注册时就会被 assertSupportedSchema 拒绝，
 * 所以不会出现「看起来校验过、其实完全没查」的工具。
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
    if (expected === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      return `argument "${key}" must be a finite number`;
    }
    if (expected === "boolean" && typeof value !== "boolean") return `argument "${key}" must be a boolean`;
  }

  return undefined;
}

export class ToolRegistry {
  private readonly tools: readonly Tool[];

  /**
   * 装配时就把不合法的工具挡掉：重名会让「按名字找工具」有歧义，
   * 不支持的 Schema 类型会让参数校验静默失效。两者都不该等到模型调用时才暴露。
   */
  constructor(tools: readonly Tool[]) {
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`duplicate tool name "${tool.name}"`);
      }
      seen.add(tool.name);
      assertSupportedSchema(tool);
    }
    this.tools = tools;
  }

  /** 发给模型的那一半：只有说明书，没有 run。 */
  get definitions(): ToolDefinition[] {
    return this.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /**
   * 按名字执行一次工具调用。
   *
   * 普通工具失败折成 ERROR 文本，让模型继续纠正；但进程树清理未确认时，
   * 后代进程可能还在产生副作用，必须抛 ProcessCleanupError 阻断后续工具。
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
      return `ERROR: invalid JSON arguments: ${describeError(error)}`;
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
      // 进程树尚可能在运行：这是不可恢复的宿主故障，不能当作普通工具错误继续执行。
      if (error instanceof ProcessCleanupError) throw error;
      // 中文对照：ERROR: {原因}
      return `ERROR: ${describeError(error)}`;
    }
  }
}

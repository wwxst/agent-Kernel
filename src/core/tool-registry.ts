/**
 * 文件目的：管住「模型能用哪些工具，以及怎么执行一次调用」。
 *
 * 这里最关键的一条规矩：工具出错不许让程序崩，只能变成一句「错误：原因」交回去。
 * 区别在哪：崩了，整轮就结束，用户得从头再来；交回一句话，模型下一轮读到它，
 * 就能自己换个路径、换个参数再试 —— 这才是它该有的样子。
 *
 * 文件职责：负责工具查找、注册时体检、参数校验、执行、把失败折成文本，
 * 以及围着 `tool.run()` 触发三个 Hook 事件（`PreToolUse` / `PostToolUse` / `PostToolUseFailure`）。
 * 不负责定义具体工具（那是 `tools/workspace.ts`）、不负责跟模型对话（那是 `core/agent.ts`）、
 * 不负责 Hook 的登记与执行顺序（那是 `core/tool-hooks.ts`）。
 *
 * 内容目录：
 *   - `ToolRegistry`：注册表本体，构造时挡掉重名与不支持的 Schema。
 *   - `ToolRegistry.definitions`：发给模型的那一半，只有说明书，没有执行函数。
 *   - `ToolRegistry.execute()`：按名字执行一次调用，四个失败分支全部折成 `ERROR:` 文本；
 *     参数过关之后围着 `tool.run()` 依次触发三个 Hook 事件。
 *   - 内部：`assertSupportedSchema()` 注册时体检、`validateArguments()` 按 Schema 校验参数、
 *     `SUPPORTED_PARAMETER_TYPES` 校验器真正认识的那几种类型。
 *
 * 模块关系：依赖 `protocol/types.ts`（`Tool` / `ToolCall` / `ToolDefinition`）、
 * `protocol/errors.ts`（`describeError`、`ProcessCleanupError`）与 `core/tool-hooks.ts`（`ToolHooks`）。
 * 由 `cli.ts` 装配、`core/agent.ts` 每轮调用；`test/support/harness.mjs` 也用它搭测试夹具。
 */
import { describeError, ProcessCleanupError } from "../protocol/errors.ts";
import type { Tool, ToolCall, ToolDefinition } from "../protocol/types.ts";
import { ToolHooks } from "./tool-hooks.ts";

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

  /** 围着工具执行的那三个事件；不传就是空执行器，行为与没有 Hook 时完全一致。 */
  private readonly hooks: ToolHooks;

  /**
   * 装配时就把不合法的工具挡掉：重名会让「按名字找工具」有歧义，
   * 不支持的 Schema 类型会让参数校验静默失效。两者都不该等到模型调用时才暴露。
   */
  constructor(tools: readonly Tool[], hooks: ToolHooks = new ToolHooks()) {
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`duplicate tool name "${tool.name}"`);
      }
      seen.add(tool.name);
      assertSupportedSchema(tool);
    }
    this.tools = tools;
    this.hooks = hooks;
  }

  /** 工具箱成员 definitions（工具说明书）：发给模型的那一半，只有说明书，没有执行函数。 */
  get definitions(): ToolDefinition[] {
    return this.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /**
   * 工具箱方法 execute（执行工具）：按名字执行一次工具调用。
   *
   * 普通工具失败折成 ERROR 文本，让模型继续纠正；但进程树清理未确认时，
   * 后代进程可能还在产生副作用，必须抛 ProcessCleanupError 阻断后续工具。
   *
   * 这里是**唯一**的执行入口，所以 Hook 也只需要挂在这里：所有工具自动经过它，
   * 不用逐个工具接线（见 `docs/adr/0020-tool-hooks-live-in-the-registry.md`）。
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

    // 参数过关之后才轮到 Hook：它看到的一定是「真实存在、参数合法」的调用，
    // 也就没有机会把未知工具或缺参数洗成一次执行 —— Hook 不能绕过已有的执行约束。
    const blocked = await this.hooks.runPreToolUse(call, args);
    if (blocked !== undefined) {
      // 中文对照：ERROR: 工具 "{名字}" 被 Hook 拦下：{原因}
      return `ERROR: tool "${name}" blocked by hook: ${blocked}`;
    }

    try {
      const result = await tool.run(args);
      // 先定结果，再通知 Hook：结果已经是不可变的字符串，Hook 只看得见、改不着。
      await this.hooks.runPostToolUse(call, args, result);
      return result;
    } catch (error) {
      // 同样先折文本再通知：失败事件拿到原始错误，但回灌给模型的那句话已经定下来了。
      // 中文对照：ERROR: {原因}
      const text = `ERROR: ${describeError(error)}`;
      await this.hooks.runPostToolUseFailure(call, args, error);
      // 进程树尚可能在运行：这是不可恢复的宿主故障，不能当作普通工具错误继续执行。
      if (error instanceof ProcessCleanupError) throw error;
      return text;
    }
  }
}

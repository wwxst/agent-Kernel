/**
 * 文件目的：在「工具执行」这一处加一个统一的扩展点，三个事件围着一次调用：
 * 执行前（`PreToolUse`）、成功之后（`PostToolUse`）、失败之后（`PostToolUseFailure`）。
 *
 * 为什么需要它：日志、监控、调用检查这类横切需求，如果每加一个都要改一遍工具实现或 Core 循环，
 * 加三次之后工具里就全是别人的事。有了挂点，工具只写自己那份逻辑，循环也一行不用动。
 * 设计口径是一句话：**Hook around the loop, never rewrite the loop** ——
 * 钩子只能旁观、只能阻止，不能改写循环，也不能改变工具结果的形状。
 *
 * 文件职责：负责登记形状、事件上下文、按登记顺序执行、把 Hook 自己的失败吞成计数。
 * 不负责工具查找与参数校验（那是 `core/tool-registry.ts`）、不负责定义具体 Hook
 * （生产代码目前一个都没登记，调用方自己传进来）、不负责展示（那是 `ui/`）。
 *
 * 内容目录：
 *   - `ToolUseContext`：三个事件共用的上下文 —— 哪一次调用、什么参数。
 *   - `PostToolUseContext` / `PostToolUseFailureContext`：成功时多一个结果，失败时多一个原始错误。
 *   - `PreToolUseDecision`：前置 Hook 唯一的出口；返回 `{ block: 原因 }` 就阻止这次调用。
 *   - `PreToolUseHook` / `PostToolUseHook` / `PostToolUseFailureHook`：回调形状，同步和异步都收。
 *   - `ToolHooksOptions`：一次登记的三个事件列表，缺哪个就表示那个事件没人关心。
 *   - `ToolHooks`：执行器本体；三个 `run*` 方法按登记顺序跑，`failureCount` 记 Hook 自身失败的次数。
 *   - 内部：`cloneContext()` 让每个事件拿到独立副本；`readBlockReason()` 把返回值读成阻止原因。
 *
 * 模块关系：只依赖 `protocol/types.ts` 的 `ToolCall`，是 `core/` 里一个不带副作用的旁路模块。
 * 由 `core/tool-registry.ts` 持有，在 `execute()` 里围着 `tool.run()` 调用；
 * `cli.ts` 与测试构造 `ToolHooks` 后交给 `ToolRegistry` 构造函数。
 */
import type { ToolCall } from "../protocol/types.ts";

/** 三个事件共用的上下文：这次调用是谁、参数是什么。两者都是副本，Hook 改了也影响不到真实执行。 */
export interface ToolUseContext {
  /** 模型发起的那一次调用（副本）。 */
  call: ToolCall;
  /** 已经过 JSON 解析与 Schema 校验的参数（副本）。 */
  args: Record<string, unknown>;
}

/** 成功之后能看到的上下文：在共用上下文之外，多一条即将回灌给模型的结果原文。 */
export interface PostToolUseContext extends ToolUseContext {
  /** 工具返回的那条结果原文，一字未改。 */
  result: string;
}

/** 失败之后能看到的上下文：在共用上下文之外，多一个工具抛出的原始错误。 */
export interface PostToolUseFailureContext extends ToolUseContext {
  /**
   * 工具抛出的原始错误 —— 折成 `ERROR:` 文本之前的那个东西，可能是 `Error`，也可能是别的。
   * 只读：不要改写它，回灌给模型的文本在通知 Hook 之前就已经定下来了。
   */
  error: unknown;
}

/**
 * 前置 Hook 的决定。返回 `{ block: "原因" }` 就阻止这次调用，什么都不返回就是放行。
 *
 * 原因会进 `ERROR:` 文本被模型读到，所以要写「为什么不让跑」，而不是「denied」——
 * 模型靠这句话决定下一步换个做法还是收尾。
 */
export interface PreToolUseDecision {
  block: string;
}

/** 执行前的 Hook：同步返回决定，或者返回一个 Promise。 */
export type PreToolUseHook = (context: ToolUseContext) => PreToolUseDecision | void | Promise<PreToolUseDecision | void>;

/** 成功之后的 Hook：只观察，没有返回值。 */
export type PostToolUseHook = (context: PostToolUseContext) => void | Promise<void>;

/** 失败之后的 Hook：只观察，没有返回值。 */
export type PostToolUseFailureHook = (context: PostToolUseFailureContext) => void | Promise<void>;

/** 一次登记：每个事件一个列表，列表顺序就是执行顺序。 */
export interface ToolHooksOptions {
  preToolUse?: readonly PreToolUseHook[];
  postToolUse?: readonly PostToolUseHook[];
  postToolUseFailure?: readonly PostToolUseFailureHook[];
}

/**
 * 每个事件都拿一份独立副本。
 *
 * 为什么必须复制：参数校验已经跑完了，如果 Hook 拿到的是工具真正会收到的那个对象，
 * 它改一下 `context.args` 就等于绕过校验改参数 —— 那是 Hook 不该有的权力。
 * 复制之后 Hook 只能看，改也只改到自己那份。
 */
function cloneContext(call: ToolCall, args: Record<string, unknown>): ToolUseContext {
  return { call: structuredClone(call), args: structuredClone(args) };
}

/**
 * 把前置 Hook 的返回值读成「阻止原因」。
 *
 * 返回 `undefined` = 放行，返回非空字符串 = 阻止。三条规矩：
 *   - 没有 `block` 字段（或返回 `false`）= 放行，这是 JS 里最自然的「不拦」写法；
 *   - 原因必须是非空字符串，空的 `ERROR:` 等于没说，模型只能瞎猜；
 *   - 说了要拦却没给原因，用兜底文案照样拦 —— 宁可拦下并说明，也不要因为文案写漏就放行。
 *
 * 参数用 `unknown`：Hook 是调用方写的代码，类型标注挡不住运行时返回一个奇怪东西。
 */
function readBlockReason(decision: unknown): string | undefined {
  if (decision === null || typeof decision !== "object" || !("block" in decision)) return undefined;
  const reason = (decision as { block?: unknown }).block;
  if (reason === false || reason === undefined || reason === null) return undefined;
  if (typeof reason === "string" && reason.trim() !== "") return reason.trim();
  return "blocked by hook (no reason given)";
}

/**
 * 工具执行的 Hook 执行器。
 *
 * 同一事件内**串行**执行，按登记顺序，一个跑完（含 await）才轮到下一个：
 * Hook 之间可能前后依赖（先记日志、再判断），并发会让「顺序」这个词失去意义。
 *
 * Hook 自己抛错只记一笔 `failureCount` 然后跳过它 —— 既不打断工具执行，
 * 也不改变工具结果，更不会变成模型看到的内容。Hook 是宿主侧的旁路观察者，
 * 它的故障不该冒充工具失败。
 *
 * 已知边界：没有超时。一个永不返回的 Hook 会一直挡住那次工具调用；
 * 第一版不引入后台调度或超时预算，需要时由 Hook 自己处理。
 */
export class ToolHooks {
  private readonly preToolUse: readonly PreToolUseHook[];
  private readonly postToolUse: readonly PostToolUseHook[];
  private readonly postToolUseFailure: readonly PostToolUseFailureHook[];

  /** Hook 自身失败的累计次数（抛错或返回 rejected Promise），供宿主诊断。 */
  private failures = 0;

  constructor(options: ToolHooksOptions = {}) {
    this.preToolUse = options.preToolUse ?? [];
    this.postToolUse = options.postToolUse ?? [];
    this.postToolUseFailure = options.postToolUseFailure ?? [];
  }

  /** Hook 自身失败的累计次数。不参与工具结果、不进入 Transcript，只供宿主看。 */
  get failureCount(): number {
    return this.failures;
  }

  /**
   * 跑前置链，返回阻止原因；`undefined` 表示放行。
   *
   * 第一个要阻止的 Hook 直接结束整条链：后面的 Hook 不再执行，工具也不执行。
   * 不收集「所有人的意见」再投票 —— 一个 Hook 说不行就够了，而多跑几个 Hook
   * 还会让「谁拦的」变得说不清。
   *
   * Hook 抛错时按「这个 Hook 没意见」处理，也就是放行。这是刻意的：一个写坏了的日志 Hook
   * 不该让所有工具都跑不了；它出错只说明它自己坏了，不说明这次调用有问题。
   */
  async runPreToolUse(call: ToolCall, args: Record<string, unknown>): Promise<string | undefined> {
    for (const hook of this.preToolUse) {
      let decision: unknown;
      try {
        decision = await hook(cloneContext(call, args));
      } catch {
        this.failures++;
        continue;
      }
      const reason = readBlockReason(decision);
      if (reason !== undefined) return reason;
    }
    return undefined;
  }

  /** 跑成功后的链：全部执行完，单个 Hook 失败不影响下一个，也不影响结果。 */
  async runPostToolUse(call: ToolCall, args: Record<string, unknown>, result: string): Promise<void> {
    for (const hook of this.postToolUse) {
      await this.runQuietly(hook, { ...cloneContext(call, args), result });
    }
  }

  /** 跑失败后的链：全部执行完；错误对象原样传下去，不复制也不改写。 */
  async runPostToolUseFailure(call: ToolCall, args: Record<string, unknown>, error: unknown): Promise<void> {
    for (const hook of this.postToolUseFailure) {
      await this.runQuietly(hook, { ...cloneContext(call, args), error });
    }
  }

  /** 单个 Hook 的隔离执行：同步抛错和 rejected Promise 都只计数，不往外传。 */
  private async runQuietly<Context>(hook: (context: Context) => unknown, context: Context): Promise<void> {
    try {
      await hook(context);
    } catch {
      this.failures++;
    }
  }
}

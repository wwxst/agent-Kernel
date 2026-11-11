/**
 * 权限：每次 Tool call 在执行前被放行还是拒绝，以及 shell 的人工审批从哪来。
 *
 * 它回答的是「模型想做这件事，宿主同不同意」，不是「操作系统允不允许」：
 * 这里没有容器、没有用户切换、没有只读挂载。shell 一旦放行，子进程的权限和启动它的人一样，
 * 可以 `cd ..` 走出工作区（见 ADR-0008 与 ADR-0013）。
 * 把 Permission 当成 Sandbox 是这类设计里最常见的误读 —— 两者不是一回事。
 *
 * 模块只做策略判断，不碰 stdin/stdout：审批回调由宿主（CLI）注入，测试可以注入假实现。
 * 这样「什么时候问人」和「问人时怎么读一行」分开，一次性任务的审批才能复用同一个 readline。
 */
import { describeError } from "./errors.ts";

/** 三档权限，顺序就是帮助文案里的顺序。 */
export const PERMISSION_MODES = ["read-only", "workspace-write", "full-access"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** CLI 不传 `--permission` 时的默认值：能改工作区文件，shell 每次都要问。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "workspace-write";

/**
 * 只读工具：不改变任何东西，read-only 和 workspace-write 都直接放行。
 *
 * `shell-output` 放在这里：它只读一个后台任务自己的日志，而那个任务是在 `shell`
 * 那一步已经批准过的。把它算成需要审批，会让后台任务在默认模式下彻底不可用。
 */
const READ_ONLY_TOOL_NAMES = ["read", "ls", "glob", "grep", "shell-output"] as const;
const READ_ONLY_TOOLS = new Set<string>(READ_ONLY_TOOL_NAMES);
const READ_ONLY_TOOL_LIST = READ_ONLY_TOOL_NAMES.join(", ");

/**
 * 只改文件的工具；它们是否真的留在工作区由 Workspace 的路径守卫决定，不归 Permission 管。
 * 工具名清单同时供策略和模型提示使用：加工具只改这里，避免提示与实际放行悄悄分叉。
 */
/**
 * 写工具：workspace-write 放行。
 *
 * `shell-kill` 放在这里：它只能停掉这个工作区自己起的后台任务（编号是 Workspace 内部的），
 * 而起那一步已经批准过了。停自己起的进程比让它一直跑着更安全，不该再拦一次。
 */
const WRITE_TOOL_NAMES = ["write", "edit", "shell-kill"] as const;
const WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES);
const WRITE_TOOL_LIST = WRITE_TOOL_NAMES.join(", ");
const SHELL_TOOL = "shell";

/**
 * 一次权限检查要看的调用信息：工具名 + 已经校验过的参数。
 *
 * 策略本身只读 `tool`；`args` 是留给审批提示的（比如 shell 的 command），Permission 不解释它。
 * 这样策略不需要认识每个工具的参数，审批提示又拿得到原始命令。
 */
export interface PermissionRequest {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * 审批器的返回值只认 `true`：字符串 "yes"、1、对象都按拒绝处理。
 * 审批是安全默认值，宁可多问一次，也不要把「看起来像同意」当成同意。
 */
export type PermissionApprover = (request: PermissionRequest) => boolean | Promise<boolean>;

export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** 只接受三档字符串；CLI 的 `--permission` 和 REPL 的 `/permission` 共用这一处判定。 */
export function parsePermissionMode(value: string): PermissionMode | undefined {
  return PERMISSION_MODES.find((mode) => mode === value);
}

/**
 * 给模型看的当前权限说明。
 *
 * 它只指导模型少走弯路，不是执行检查：真正的放行/拒绝仍由 `Permission.check`
 * 和 `ToolRegistry.execute` 决定。提示写错不会让工具被放行，反之也不会。
 * 名字按 spec 使用 `permissionPrompt`；返回值是提示文本，不是工厂对象。
 */
export function permissionPrompt(mode: PermissionMode): string {
  switch (mode) {
    case "read-only":
      return [
        // 权限模式：只读。
        "Permission mode: read-only.",
        // 本说明覆盖基础提示里的工具清单：只有 read、ls、glob、grep 可用；write、edit、shell 会被拒绝。
        `This overrides the base tool list: only ${READ_ONLY_TOOL_LIST} are available. ${WRITE_TOOL_LIST}, and ${SHELL_TOOL} are denied.`,
        // 验证需要被拒绝的工具时跳过并说明，不要尝试被拒绝的工具。
        "If a check or test requires a denied tool, skip it and explain why instead of trying a denied tool.",
      ].join("\n");

    case "workspace-write":
      return [
        // 权限模式：工作区写入。
        "Permission mode: workspace-write.",
        // 可以调用只读工具与写工具；文件修改必须留在工作区内。
        `You may call ${READ_ONLY_TOOL_LIST}, ${WRITE_TOOL_LIST}; keep file changes inside the workspace.`,
        // shell 每条命令都需要用户批准，可能被拒绝；不要把批准当成默认。
        `${SHELL_TOOL} requires explicit user approval for every command and may be denied. Do not assume a command was approved.`,
      ].join("\n");

    case "full-access":
      return [
        // 权限模式：完全访问。
        "Permission mode: full-access.",
        // 所有工具（包括 shell）无需审批即可调用。
        `All tools, including ${SHELL_TOOL}, may be used without approval.`,
        // 仍然保持改动范围合理，并在完成后验证。
        "Still keep changes scoped and verify your work.",
      ].join("\n");

    default:
      // 类型上到不了这里；JS 调用方传了未知模式时，直接报错而不是给模型空规则。
      throw new Error(`unknown permission mode "${String(mode)}"`);
  }
}

/** 审批回答只认 y / yes（大小写不敏感）；空行、n、其他任何输入都是拒绝。 */
export function isApproved(answer: string): boolean {
  return /^(?:y|yes)$/i.test(answer.trim());
}

/**
 * 审批前的前置门：没有交互终端、已经取消、或 REPL 里已有排队的下一行输入时，不问、直接拒绝。
 *
 * 返回值带原因，而不是只给 boolean：调用方要把「没有提问」折进拒绝文本，
 * 不能让模型和用户把它误读成「用户拒绝了」。抽成纯函数也让它能被单独测试，
 * 不需要为了验证一个信号或一行排队输入去伪造终端。
 */
export type ApprovalGate =
  | { ask: true }
  | { ask: false; reason: string };

export function approvalGate(
  signal: AbortSignal,
  interactive: boolean,
  pendingInput: boolean,
): ApprovalGate {
  if (signal.aborted) return { ask: false, reason: "task cancelled" };
  if (!interactive) return { ask: false, reason: "no interactive terminal" };
  if (pendingInput) return { ask: false, reason: "next input is already queued" };
  return { ask: true };
}

/**
 * 权限策略是会话级状态：`/reset` 换 Agent 但不换它，所以切换后的模式不会因为清空上下文而丢失。
 *
 * 为什么不做成 ToolRegistry 的默认值：注册表是工具执行器，测试和评测会自己组装工具集
 * （比如只有 echo 的单元测试）。把策略注入进去，CLI 才能说「默认 workspace-write」，
 * 而库调用方仍然可以按自己的场景决定要不要检查。
 */
export class Permission {
  private current: PermissionMode;

  /** 每次实际切换权限都递增：审批期间撤权后即使切回来，旧批准也不能复活。 */
  private modeVersion = 0;

  private readonly approve?: PermissionApprover;

  constructor(mode: PermissionMode = DEFAULT_PERMISSION_MODE, approve?: PermissionApprover) {
    this.current = mode;
    this.approve = approve;
  }

  get mode(): PermissionMode {
    return this.current;
  }

  setMode(mode: PermissionMode): void {
    if (this.current !== mode) {
      this.current = mode;
      this.modeVersion++;
    }
  }

  /**
   * 判断一次 Tool call 是否放行。
   *
   * 只看工具名，不看参数：`read` 无论读哪个路径都过权限这一关，路径越界由 Workspace 拒绝。
   * 两层各管一件事 —— Permission 管「这类动作同不同意」，Workspace 管「这个路径在不在范围内」。
   */
  async check(request: PermissionRequest): Promise<PermissionResult> {
    switch (this.current) {
      case "full-access":
        return { allowed: true };

      case "read-only":
        if (READ_ONLY_TOOLS.has(request.tool)) return { allowed: true };
        return {
          allowed: false,
          reason: `tool "${request.tool}" is not allowed in read-only mode (allowed: ${READ_ONLY_TOOL_LIST})`,
        };

      case "workspace-write":
        if (READ_ONLY_TOOLS.has(request.tool) || WRITE_TOOLS.has(request.tool)) return { allowed: true };
        if (request.tool === SHELL_TOOL) return this.askForShell(request);
        return {
          allowed: false,
          reason: `tool "${request.tool}" is not allowed in workspace-write mode`,
        };

      default:
        // 类型上到不了这里；JS 调用方传了未知模式时，拒绝比放行安全。
        return { allowed: false, reason: `unknown permission mode "${String(this.current)}"` };
    }
  }

  /**
   * shell 的逐次审批：每次调用都问，绝不缓存「上次同意过」。
   *
   * 不缓存是有意的 —— 「允许一次」是给用户看一条具体命令再决定，
   * 缓存之后第二次的命令可能完全不同，却沿用了上一次的同意。
   */
  private async askForShell(request: PermissionRequest): Promise<PermissionResult> {
    if (this.approve === undefined) {
      return {
        allowed: false,
        reason: `tool "${SHELL_TOOL}" requires approval, but no approval prompt is available; denied`,
      };
    }

    // 审批是异步的：等待用户回答时，别处可能把 workspace-write 改成 read-only。
    // 记住版本而非仅检查最终模式：切走再切回，也必须重新请求授权。
    const approvedUnderVersion = this.modeVersion;
    try {
      const approved = await this.approve(request);
      if (this.modeVersion !== approvedUnderVersion || this.current !== "workspace-write") {
        return { allowed: false, reason: "permission mode changed during approval; denied" };
      }
      if (approved === true) return { allowed: true };
      return { allowed: false, reason: `user denied tool "${SHELL_TOOL}"` };
    } catch (error) {
      // 审批通道自己坏了（readline 关闭、TTY 消失）也按拒绝处理：
      // 异常绝不能变成「默认放行」，那正好是权限系统最危险的方向。
      // 原因写进拒绝文本，避免把「读不到输入」误报成「用户拒绝」。
      return {
        allowed: false,
        reason: `tool "${SHELL_TOOL}" approval failed: ${describeError(error)}; denied by default`,
      };
    }
  }
}

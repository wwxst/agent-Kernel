/**
 * 文件目的：让主 Agent 把一件相对独立的活儿交给一个临时子 Agent，只拿回一份最终结果。
 *
 * 没有它会怎样：所有调查、改动、验证都挤进主 Agent 同一条 Transcript，
 * 任务一复杂，上下文被无关细节撑满，主 Agent 又没法把「查」和「改」分开。
 * 有了它，子任务在自己的上下文里跑完，主 Agent 只看到一段结论。
 *
 * 文件职责：定义两种子 Agent 角色（只读调查 / 可写执行）、两种角色的工具清单与系统提示、
 * 委派工具 `run_subagent` 的说明书、参数校验、结果格式化与截断，以及主 Agent 的委派指导。
 * 不负责创建或运行 Agent（那是 `cli.ts` 装配层的事，本文件只通过回调索取结果），
 * 不负责执行工具（那是 `core/tool-registry.ts`），也不负责展示（那是 `ui/`）。
 *
 * 内容目录：
 *   - `SubagentMode` / `DEFAULT_SUBAGENT_MODE`：两种角色，以及默认的只读调查。
 *   - 上限常量：任务长度、结果长度、子 Agent 的步数 / 工具调用 / token 三道预算。
 *   - `SubagentStats` / `SubagentOutcome`：子 Agent 交回来的统计，与三种终态（完成 / 失败 / 取消）。
 *   - `subagentWorkspaceContext()`：两种角色共用的工作区说明（真实根目录、相对路径规则）。
 *   - `createExplorerSystemPrompt()` / `WORKER_SUBAGENT_GUIDANCE` / `SUBAGENT_GUIDANCE`：
 *     两个角色的系统提示，以及写给主 Agent 的委派规矩。
 *   - `toolsForSubagentRole()`：按角色挑工具；Worker 的 `shell` 在这里被改成纯前台。
 *   - `throwIfProcessesUnverified()`：子 Agent 进程树没确认收干净时，不许当成功。
 *   - `createSubagentTool()`：暴露给主 Agent 的 `run_subagent`。
 *
 * 模块关系：只依赖 `protocol/types.ts`（`Tool`）与 `protocol/errors.ts`（`ProcessCleanupError`），
 * 保持 `tools → protocol` 的依赖方向 —— 它不认识 `Agent`，真正的子 Agent 由 `cli.ts` 注入回调执行。
 * 由 `cli.ts` 装配进主 Agent 的工具注册表，并负责提供执行函数。
 */
import { ProcessCleanupError } from "../protocol/errors.ts";
import type { Tool } from "../protocol/types.ts";

/** 子 Agent 的两种工作角色：`explore` 只读调查，`execute` 可以改文件、跑前台命令。 */
export type SubagentMode = "explore" | "execute";

/** 不写 mode 时用哪个角色。调查不产生文件副作用，默认选它更稳妥。 */
export const DEFAULT_SUBAGENT_MODE: SubagentMode = "explore";

/** 任务描述最多 8000 字符：再长就不是「一件子任务」，而是把整段对话搬过去。 */
export const SUBAGENT_TASK_MAX_CHARS = 8_000;

/** 回传给主 Agent 的结果正文最多 12000 字符；超出必须标明截断，不能伪装成完整结论。 */
export const SUBAGENT_RESULT_MAX_CHARS = 12_000;

/**
 * 子 Agent 的三道预算。
 *
 * 比主 Agent 默认值更窄是有意的：一次委派不该吃掉整轮任务的全部额度。
 * 实际生效值取「这里」和「用户配置」的较小者（装配在 `cli.ts`）。
 */
export const SUBAGENT_MAX_STEPS = 20;
export const SUBAGENT_MAX_TOOL_CALLS = 30;
export const SUBAGENT_MAX_TOTAL_TOKENS = 100_000;

/** 一次委派的请求：任务原文，以及用哪个角色跑。 */
export interface SubagentRequest {
  task: string;
  mode: SubagentMode;
}

/**
 * 子 Agent 自己的执行统计。
 *
 * 刻意不并入父 Agent 的 `stats`：那个数字回答「这一轮主任务花了多少」，
 * 把子 Agent 的请求塞进去，两个账都算不清。所以统计随结果一起交回来，由主 Agent 读到。
 */
export interface SubagentStats {
  mode: SubagentMode;
  requests: number;
  toolCalls: number;
  /** 端点**报告了** usage 的部分之和；不是精确花费。 */
  tokens: number;
  /** 没有 usage 的请求数。大于 0 时上面的 tokens 只是下限。 */
  unknownUsage: number;
  /** 子 Agent 的 token 预算是否已经达到上限。 */
  budgetExceeded: boolean;
}

/**
 * 子 Agent 的终态。三种情况分开，是因为主 Agent 该做的事完全不同：
 * 完成 → 用结论；失败 → 先看工作区再决定；取消 → 不要再重试同一个子任务。
 */
export type SubagentOutcome =
  | { status: "completed"; content: string; stats: SubagentStats }
  | { status: "failed"; reason: string; stats: SubagentStats }
  | { status: "cancelled"; reason: string; stats: SubagentStats };

/** 只读调查角色能用的工具。没有 write / edit / shell，也没有创建子 Agent 的能力。 */
const EXPLORE_TOOL_NAMES = ["read", "glob", "grep", "ls"] as const;

/** 执行角色能用的工具。`shell` 会在 `toolsForSubagentRole()` 里被改成纯前台。 */
const EXECUTE_TOOL_NAMES = ["read", "write", "edit", "glob", "grep", "ls", "shell"] as const;

/**
 * 子 Agent 的工作区说明：两种角色共用这一份，只写一次。
 *
 * 为什么必须把真实路径写进去：模型最常犯的错是凭空猜一个 `/workspace/src/...` 这样的绝对路径
 * （别的 agent 工具常把项目挂在 `/workspace`），猜错之后会连读几次、连搜几次，把预算烧在找路上。
 * 把真实根目录原样告诉它，是这条链路上最便宜的一道防线 —— 这是**事实**，不是操作步骤。
 *
 * 已知边界：这是模型行为指导，不是安全边界。Full Access 下工具仍能访问当前操作系统账户
 * 有权访问的任何位置 —— 这句话管不住工具，只提醒模型别跑题。
 */
export function subagentWorkspaceContext(workspaceRoot: string): string {
  return [
    // 本次任务的工作区根目录就是这个路径。
    `The workspace root for this task is ${JSON.stringify(workspaceRoot)}.`,
    // 相对文件路径都从这个确切目录解析。
    "Resolve relative file paths from this exact directory.",
    // 不要拿一个固定的绝对路径（例如 /workspace）去替换上面这个路径。
    "Do not substitute a fixed absolute path such as /workspace for the path above.",
    // 除非委派任务明确要求访问外部路径，否则留在这个工作区里。
    "Stay within this workspace unless the delegated task explicitly requires an external path.",
  ].join("\n");
}

/**
 * 只读调查角色的系统提示。
 *
 * 整份按 Claude Code 的 Explore agent 提示词重写（资料包 `01_主Agent与Subagent提示词` §1，见 ADR-0032）：
 * 身份、只读红线、禁止动作、擅长什么、怎么汇报逐句沿用；只删掉本仓库没有的能力
 * （shell、并行工具调用、写文件），工具名换成本仓库的四个只读工具。
 *
 * 与 ADR-0025 的旧立场（「只给方向，不写步骤」）不同：资料里的 Explore 提示把禁止清单写死了，
 * 这里照搬 —— 硬约束由工具表、预算、取消保证，这段文字负责把红线说清楚。
 * 工作区路径由 `subagentWorkspaceContext()` 在装配时追加（见 `cli.ts`），所以本函数不需要参数。
 */
export function createExplorerSystemPrompt(): string {
  return [
    // 你是文件搜索专家，擅长彻底浏览和探索代码库。
    "You are a file search specialist. You excel at thoroughly navigating and exploring codebases.",
    // 重要：只读模式，禁止修改任何文件。
    "=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===",
    // 这是只读探索任务：严格禁止创建、修改、删除、移动或复制文件。
    "This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from creating, modifying, deleting, moving, or copying files.",
    // 你的职责只有搜索和分析现有代码。
    "Your role is EXCLUSIVELY to search and analyze existing code.",
    // 你没有编辑文件的工具；尝试编辑会失败。
    "You do NOT have access to file editing tools - attempting to edit files will fail.",
    // 你的优势：用 glob 模式快速定位文件。
    "Rapidly finding files using glob patterns",
    // 用正则搜索代码和文本。
    "Searching code and text with regex patterns",
    // 读取并分析文件内容。
    "Reading and analyzing file contents",
    // 知道具体文件路径时，用 read 工具去读。
    "Use read when you know the specific file path you need to read.",
    // 按调用者要求的彻底程度调整搜索方式。
    "Adapt your search approach based on the thoroughness level specified by the caller.",
    // 调查方式自己定；没有指定的文件清单、搜索顺序或步骤序列。
    "Decide your own investigation approach; no file list, search order, or step sequence is prescribed.",
    // 直接以普通消息交出最终报告，不要试图创建文件。
    "Communicate your final report directly as a regular message - do NOT attempt to create files.",
    // 高效使用手上的工具：搜索文件和实现时要聪明。
    "Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations.",
    // 高效完成这次搜索任务，并清楚汇报发现。
    "Complete the user's search request efficiently and report your findings clearly.",
    // 返回结论、关键依据和主 Agent 需要的建议；只报告你真正核实过的东西。
    "Return your conclusion, the key evidence behind it, and any recommendation the parent needs; report only what you actually verified.",
    // 交出报告之后停止调用工具。
    "Stop calling tools once you have delivered the report.",
  ].join("\n");
}

/**
 * 执行角色在默认编码提示之后追加的部分。
 *
 * 按 Claude Code 的 General-purpose 与 Coordinator Worker 提示词重写（资料包 §3、§5，见 ADR-0032）：
 * 「完整做完、别过度包装、只做分配的事、不懂的代码别改、交付时说清改了什么」逐句沿用。
 * 只改一处事实：Coordinator Worker 里「改完就提交」不适用于本仓库 —— 子 Agent 没有自己的分支，
 * 提交必须由任务明确授权，这条硬约束保留。
 * 基础指令（先看再改、改完验证、不谎报）沿用 `DEFAULT_SYSTEM_PROMPT`。
 */
export const WORKER_SUBAGENT_GUIDANCE = [
  // 你是一个执行子 Agent，执行主 Agent 分配给的一项开发任务。
  "You are a worker agent executing a task assigned by the parent agent.",
  // 把任务完整做完 —— 不要过度包装，也不要只做一半。
  "Complete the task fully—don't gold-plate, but don't leave it half-done.",
  // 自己把它做完，不需要逐步请求确认。
  "Complete it yourself: you do not need to ask for step-by-step confirmation.",
  // 完成后用简短报告说明做了什么、发现了什么重要问题。
  "When you complete the task, respond with a concise report covering what was done and any key findings.",
  // 严格完成分配的事，别顺手修无关问题；发现后作为后续建议。
  "Complete exactly what was asked. Don't fix unrelated issues you discover — suggest them as follow-ups instead.",
  // 不要改自己没看懂的代码。
  "Don't modify code you don't understand.",
  // 改动范围只限任务真正需要的部分。
  "Limit changes to what your task requires.",
  // 按仓库实际情况选方案；复用现有架构，避免无关修改和过度设计。
  "Choose the approach that fits the actual repository; reuse the existing architecture and avoid unrelated changes or over-engineering.",
  // 除非任务明确授权这个具体动作，否则不要提交、推送、合并、变基、重置、清理或暂存。
  "Do not commit, push, merge, rebase, reset, clean, or stash unless the task explicitly authorizes that exact action.",
  // 报告你改了什么、真正验证了什么，以及还有什么没解决。
  "Report what you changed, what you actually verified, and what remains unresolved.",
  // 没法安全完成时停下来报告阻塞。
  "If the task cannot be completed safely, stop and report the blocker.",
  // 结果直接交给父 Agent，而不是用户。
  "Your response goes directly to the parent agent, not the user.",
].join("\n");

/**
 * 写给主 Agent 的委派规矩。
 *
 * 按 Claude Code 的 Subagent 工具说明与 Coordinator 规则重写（资料包 §2、§8，见 ADR-0032）：
 * 能自己答的别委派、prompt 必须自包含、别重复子 Agent 在做的事、结果先检查再采用。
 * 本仓库的子 Agent 是同步的、看不到这段对话、失败也不回滚文件改动 —— 这三条按实际写。
 */
export const SUBAGENT_GUIDANCE = [
  // 能直接回答的问题就自己回答，别把不用工具的活委派出去。
  "Answer questions directly when possible - don't delegate work that you can handle without tools.",
  // 你可以用 run_subagent 把一项独立的子任务交给子 Agent。
  "You can delegate a self-contained subtask to a subagent with run_subagent.",
  // 子 Agent 看不到这段对话，所以 task 里必须带齐它需要的全部背景。
  "The subagent cannot see this conversation. Every task must be self-contained with everything the subagent needs.",
  // 什么时候委派、用哪个角色（explore 还是 execute），由你自己判断。
  "Decide yourself when to delegate and which role (explore or execute) to use.",
  // 简单或紧密耦合的自己做，别为了用子 Agent 而委派。
  "Handle simple or tightly coupled work yourself instead of delegating it just to use a subagent.",
  // 已经交给子 Agent 的调查不要自己再做一遍。
  "Avoid duplicating work that subagents are already doing: if you delegate research to a subagent, do not also perform the same searches yourself.",
  // 先检查结果再采用；子 Agent 失败时，它做过的文件修改不会自动回滚。
  "Review the result before relying on it; a failed subagent's file changes are not rolled back.",
  // 子 Agent 的最终报告只给你看，用户看不到；要转达的信息由你自己写。
  "The subagent's final report is shown to you, not to the user - if something in it matters, relay it yourself.",
  // 然后继续把总体任务做完。
  "Then continue and finish the overall task.",
].join("\n");

/**
 * 改写后的 shell 说明书：去掉了 `background` 参数，所以必须同时去掉「用后台跑服务」那句。
 *
 * 措辞按 Claude Code 的 Bash 工具提示词重写（资料包 `03_工具调用与Hooks` §3，见 ADR-0032）：
 * 一次调用一个 shell、工作目录与状态不跨调用保留。只删 `background` 那一段，其余能力照旧要说：
 * `timeout` 参数还在 Schema 里，说明书不提它，模型就不知道慢构建、慢测试可以把超时调长，
 * 只会把「等超时」当成失败。
 */
const FOREGROUND_SHELL_DESCRIPTION =
  // 跑一条 shell 命令，返回退出码与 stdout/stderr。
  "Executes a given shell command and returns its output: exit code plus stdout/stderr. " +
  // 每次调用都是新 shell：工作目录默认工作区根目录，命令里可以自行 cd 或用绝对路径。
  "Each call starts a fresh shell; the working directory defaults to the workspace root, and the command may cd anywhere or use absolute paths. " +
  // 只在前台执行：不会自己结束的命令（服务、监听）会一直阻塞到超时，所以不要启动它们。
  "Foreground only: a command that never exits (a server, a watcher) blocks until it times out, so never start one. " +
  // 慢构建、慢测试可以把超时调长：单位毫秒，默认 120000，上限 600000。
  "Set timeout (milliseconds, default 120000, max 600000) when a build or test run needs longer.";

/**
 * 把 `shell` 改成纯前台：Schema 里删掉 `background`，执行时强制 `background: false`。
 *
 * 为什么两层都要做：只删 Schema，模型仍可能从旧上下文里照抄 `background:true`；
 * 只强制 false，模型仍会以为能起后台任务，然后拿到一个它无法用 `shell-output` 跟踪的进程。
 * 已知边界：这是工具层的限制，不是操作系统级隔离 —— 命令内部仍可能自行派生脱离管理的进程。
 *
 * 这里刻意不搬运 `strictArguments`：`shell` 本身没有开它，而这一层包装的正确性恰恰依赖
 * 「多余字段不报错」—— 模型塞进来的 `background` 要能被吞掉再强制改成前台。
 * 如果以后给 `shell` 打开 `strictArguments`，这个包装会先被注册表拒掉，必须先改这里。
 */
function foregroundShell(shell: Tool): Tool {
  const parameters = structuredClone(shell.parameters);
  const properties = parameters.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    delete (properties as Record<string, unknown>).background;
  }
  return {
    name: shell.name,
    description: FOREGROUND_SHELL_DESCRIPTION,
    parameters,
    run: async (args) => shell.run({ ...args, background: false }),
  };
}

/**
 * 按角色挑出子 Agent 能用的工具。
 *
 * 缺工具直接抛错，不静默跳过：拿不到 `read` 的 Explorer 什么都干不了，
 * 与其让它空转一轮再失败，不如在装配时就说出「少了哪个工具」。
 */
export function toolsForSubagentRole(tools: readonly Tool[], mode: SubagentMode): Tool[] {
  const allowed: readonly string[] = mode === "explore" ? EXPLORE_TOOL_NAMES : EXECUTE_TOOL_NAMES;
  const picked: Tool[] = [];
  for (const name of allowed) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      throw new Error(`subagent mode "${mode}" requires tool "${name}", which is not available`);
    }
    picked.push(name === "shell" ? foregroundShell(tool) : tool);
  }
  return picked;
}

/**
 * 子 Agent 的进程树没确认收干净时，不许把它的最终回复当成功。
 *
 * 为什么必须抛 `ProcessCleanupError` 而不是返回失败文本：父 Agent 对这类错误的处理是
 * 「禁用后续所有工具、只让模型收尾」。如果这里悄悄降级成一条普通失败结果，
 * 父 Agent 会继续改文件，而子 Agent 的 shell 可能还在跑 —— 那才是真正危险的组合。
 */
export function throwIfProcessesUnverified(mode: SubagentMode, toolExecutionDisabled: boolean): void {
  if (!toolExecutionDisabled) return;
  throw new ProcessCleanupError(
    `subagent mode "${mode}" could not confirm process tree cleanup; ` +
      "its shell may still be running, so tool execution stays disabled for the parent agent",
  );
}

/**
 * 校验模型给的参数。放在这里而不是 Schema 里，是因为注册表只校验类型，
 * 不认 `enum` / `minLength` / `maxLength` —— 为这一个工具扩一整套 Schema 框架不值得。
 */
function readRequest(args: Record<string, unknown>): SubagentRequest {
  if (typeof args.task !== "string") throw new Error("task must be a string");
  const task = args.task.trim();
  if (task === "") throw new Error("task must not be empty");
  if (task.length > SUBAGENT_TASK_MAX_CHARS) {
    throw new Error(`task must be at most ${SUBAGENT_TASK_MAX_CHARS} characters, got ${task.length}`);
  }

  const rawMode = args.mode;
  const mode = rawMode === undefined ? DEFAULT_SUBAGENT_MODE : rawMode;
  if (mode !== "explore" && mode !== "execute") {
    throw new Error(`mode must be "explore" or "execute", got ${JSON.stringify(rawMode)}`);
  }
  return { task, mode };
}

/**
 * 结果正文超长时截断，并在末尾写明丢了多少 —— 不能让人以为拿到的是完整结论。
 *
 * 上限数的是 UTF-16 代码单元，所以可能正好切在一个 emoji（代理对）中间。
 * 留下半个代理，编码成 UTF-8 就是一个替换字符：模型读到的正文是坏的，
 * 而「丢了多少」还会少算一个。宁可多丢一个代码单元，也不交出半个字符。
 */
function clipResult(content: string): string {
  if (content.length <= SUBAGENT_RESULT_MAX_CHARS) return content;
  const cut = content.slice(0, SUBAGENT_RESULT_MAX_CHARS);
  const kept = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  const omitted = content.length - kept.length;
  return kept + `\n\n[... subagent result truncated: ${omitted} chars omitted]`;
}

/** 统计块的统一排版：成功、失败、取消三种结果都要带，主 Agent 才能自己判断花了多少。 */
function formatStats(stats: SubagentStats): string[] {
  return [
    `mode: ${stats.mode}`,
    `requests: ${stats.requests}`,
    `tool_calls: ${stats.toolCalls}`,
    `tokens: ${stats.tokens}`,
    `unknown_usage: ${stats.unknownUsage}`,
  ];
}

/**
 * 把子 Agent 的终态排成一条工具结果。
 *
 * 这里的文本是给模型读的，所以用英文（规范第 1 节）；中文只留在源码注释里。
 */
export function formatSubagentResult(outcome: SubagentOutcome): string {
  if (outcome.status === "completed") {
    const lines = ["[Subagent completed]", ...formatStats(outcome.stats), ""];
    // 预算顶穿但仍有完整最终答复：这是成功，但必须说清「没有再发新请求」。
    if (outcome.stats.budgetExceeded) {
      lines.push(
        "note: the subagent reached its token budget; the report above is complete, but no further requests were sent.",
        "",
      );
    }
    lines.push("Final report:", clipResult(outcome.content.trim()));
    return lines.join("\n");
  }

  if (outcome.status === "cancelled") {
    return [
      "[Subagent cancelled]",
      ...formatStats(outcome.stats),
      "",
      `reason: ${outcome.reason}`,
      "",
      "The subtask was cancelled and produced no complete final report.",
    ].join("\n");
  }

  return [
    "[Subagent failed]",
    ...formatStats(outcome.stats),
    "",
    `reason: ${outcome.reason}`,
    "",
    "note: a failed subagent does not roll back the file changes it already made. " +
      "Inspect the workspace before delegating the same work again.",
  ].join("\n");
}

/**
 * 造出 `run_subagent` 工具。
 *
 * 执行函数由调用方注入：本文件不认识 `Agent`，也不认识 `Workspace`，
 * 所以「怎么跑子 Agent」留在装配层，这里只负责说明书、校验和结果排版。
 * `ProcessCleanupError` 不在这里捕获 —— 它必须穿过去，交给 `ToolRegistry` 与父 Agent 处理。
 *
 * 返回的是带 `isError` 的结构化结果，不是裸字符串：子 Agent 失败或取消时，
 * 注册表、Hook、工具日志和界面都要知道这次调用没成功。正文照样保留，
 * 只是状态不再由正文内容「暗示」。
 */
export function createSubagentTool(runSubagent: (request: SubagentRequest) => Promise<SubagentOutcome>): Tool {
  return {
    name: "run_subagent",
    // 把一件相对独立的子任务交给临时子 Agent；它有自己的对话上下文和更窄的工具集合，
    // 只交回一份最终报告，不返回它内部的对话记录。
    // mode 为 explore（默认）时只能读和搜；mode 为 execute 时才能改文件、跑前台命令。
    // 子 Agent 看不到当前对话，所以 task 里必须写清全部背景。
    // 同一时刻只跑一个子 Agent，它是同步的：调用会等到子任务结束才返回。
    description:
      "Launch a new agent to handle complex, multi-step tasks autonomously. " +
      "It delegates one self-contained subtask to a temporary subagent that has its own context and a narrower tool set; " +
      "it returns one final report, not its internal transcript. " +
      'mode "explore" (default) can only read and search; mode "execute" may also change files and run foreground commands. ' +
      "The subagent cannot see this conversation, so put every needed detail in task. " +
      "A subagent starts fresh without your context window. " +
      "Only one subagent runs at a time and the call returns when the subtask ends. " +
      "The final report is shown to you, not to the user.",
    parameters: {
      type: "object",
      properties: {
        // 子任务的完整描述，包含它需要的全部背景；最多 8000 字符，不能为空。
        task: {
          type: "string",
          description:
            "Complete instructions for the subtask, including all background it needs. " +
            `Must not be empty; at most ${SUBAGENT_TASK_MAX_CHARS} characters.`,
        },
        // 角色：explore 只读调查（默认），execute 可以改文件并跑前台命令。
        mode: {
          type: "string",
          description: 'Either "explore" (read-only investigation, the default) or "execute" (may modify files and run foreground commands).',
        },
      },
      required: ["task"],
    },
    // 失败和取消必须带上 isError：只回一段写着 "[Subagent failed]" 的文本，
    // 注册表会把它当成成功 —— Hook 走 PostToolUse、TUI 显示 ✓、工具日志记 ok:true，
    // 三处都在骗人。状态要和正文说的是同一件事。
    run: async (args) => {
      const outcome = await runSubagent(readRequest(args));
      return {
        content: formatSubagentResult(outcome),
        isError: outcome.status !== "completed",
      };
    },
  };
}

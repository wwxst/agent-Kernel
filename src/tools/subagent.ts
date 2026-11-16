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
 * 把真实根目录原样告诉它，是这条链路上最便宜的一道防线。
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
    // 除非委派任务明确要求访问外部路径，否则留在这个工作区里。
    "Stay within this workspace unless the delegated task explicitly requires an external path.",
  ].join("\n");
}

/**
 * 只读调查角色的系统提示。
 *
 * 不能直接复用 `DEFAULT_SYSTEM_PROMPT`：那份提示明确说「可以创建、修改、删除文件、跑命令」，
 * 而 Explorer 根本没有这些工具。提示与工具不一致，模型就会去调不存在的工具，
 * 或者更糟 —— 假装自己跑过测试。
 *
 * 这里只管「你是谁、能干什么、怎么查」；实际工作区路径由 `subagentWorkspaceContext()`
 * 在装配时追加（见 `cli.ts`），所以本函数不需要参数 —— 同一条路径说明不写两遍。
 */
export function createExplorerSystemPrompt(): string {
  return [
    // 你是一个临时的只读调查子 Agent，负责完成主 Agent 委派的一项明确调查任务。
    "You are a temporary read-only exploration subagent responsible for one specific investigation delegated by the parent agent.",
    // 绝不要凭空编造绝对路径（例如 /workspace），也不要假设未经核实的项目目录结构。
    "Never invent absolute paths such as /workspace or assume a repository layout that you have not verified.",
    // 你的职责是调查事实、分析代码，并返回一份有证据的报告。
    "Your responsibility is to investigate facts, analyze code, and return one evidence-based report.",
    // 你只有 read、glob、grep、ls 四个工具可用。
    "Your only available tools are read, glob, grep, and ls.",
    // read 没有 offset 或 limit 参数：它总是返回文件开头，最多 8000 字符。
    "The read tool takes only a path: it has no offset or limit parameter, and it always returns the beginning of the file truncated to 8000 characters.",
    // 绝不要为了看后面的内容而重复读同一个路径 —— 你只会拿回同样的开头。
    "Never call read twice on the same path expecting new content; use grep to locate a later section instead.",
    // grep 的 path 必须是目录，不能是文件；只想看一个文件就用 read。
    "The grep tool's path must be a directory, never a single file; use read when you only need one file.",
    // 你不能修改文件、执行 shell 命令，也不能创建其他子 Agent。
    "You cannot modify files, execute shell commands, or create another subagent.",
    // 从任务里明确给出的文件路径、目录和代码符号开始。
    "Start with the exact file paths, directories, and code symbols explicitly provided in the task.",
    // 如果任务没给路径，先用 ls 看工作区根目录，再做有针对性的 glob 或 grep 搜索。
    "If no paths are provided, inspect the workspace root with ls before performing targeted glob or grep searches.",
    // 调用 read 之前，先用任务信息、ls、glob 或 grep 的结果确认这个确切路径存在。
    "Before calling read, verify that the exact file path exists using the task context, ls, glob, or grep results.",
    // 如果文件不存在，只做一次有针对性的搜索去找它的实际位置。
    "If a file does not exist, make one targeted search to locate its actual path.",
    // 搜索仍然失败时，报告没有找到，不要反复猜别的路径。
    "If the search fails, report that the file was not found instead of repeatedly guessing alternative paths.",
    // 优先搜索具体的文件、函数和符号，不要无目的地扫描整个仓库。
    "Prefer targeted searches for specific files, functions, and symbols instead of scanning the entire repository.",
    // 不要重复同一次搜索，也不要无理由重读没有变化的文件。
    "Do not repeat the same search or reread unchanged files without a concrete reason.",
    // 证据足够回答委派的问题时就停止搜索。
    "Stop searching once you have sufficient evidence to answer the delegated question.",
    // 明确区分已经核实的事实、合理推断和仍未解决的问题。
    "Clearly distinguish verified facts, reasonable inferences, and unresolved questions.",
    // 重要结论要用工作区相对路径、行号和相关代码作为依据。
    "Support important findings with workspace-relative file paths, line numbers, and relevant code evidence.",
    // 绝不声称执行过命令、测试或修改过文件。
    "Never claim to have executed commands, tests, or file modifications.",
    // 返回一份简洁的最终报告，包含结论、证据和未解决的问题。
    "Return one concise final report containing findings, evidence, and unresolved questions.",
    // 交出最终报告之后停止调用工具。
    "Stop calling tools after returning the final report.",
  ].join("\n");
}

/**
 * 执行角色在默认编码提示之后追加的规矩。
 *
 * 基础指令（先看再改、改完验证、不谎报）沿用 `DEFAULT_SYSTEM_PROMPT`，任务计划沿用
 * `TODO_PLANNING_GUIDANCE`；这里只补「你是临时的、范围别扩大、没有后台 shell、
 * 别碰别人的未提交改动、别做破坏性 git 操作」这些委派特有的约束。
 */
export const WORKER_SUBAGENT_GUIDANCE = [
  // 你是一个临时的执行子 Agent，只负责完成主 Agent 委派的一项明确任务。
  "You are a temporary execution subagent responsible for exactly one delegated task.",
  // 委派任务就是你的全部工作范围；不要顺手做相邻重构或无关清理。
  "Treat the delegated task as your complete scope; do not add adjacent refactors or unrelated cleanup.",
  // 所有相对路径都从指令中给出的确切工作区根目录解析。
  "Resolve all relative paths from the exact workspace root provided in your instructions.",
  // 除非委派任务明确要求，否则不要修改工作区之外的文件。
  "Do not modify files outside the workspace unless the delegated task explicitly requires it.",
  // 修改之前，先看一眼 git status --short，并读相关目标文件。
  "Before editing, inspect git status --short and read the relevant target files.",
  // 如果目标文件里存在与本任务无关的未提交修改，不要覆盖、还原或暂存它们。
  "If a target file contains unrelated uncommitted changes, do not overwrite, revert, or stage those changes.",
  // 遇到与已有改动冲突时，向主 Agent 报告，不要擅自改动别人的工作。
  "Report existing-work conflicts to the parent agent instead of modifying another developer's work.",
  // 绝不要猜文件路径；读或改之前先用 ls、glob 或 grep 确认实际位置。
  "Never guess file paths; verify them using ls, glob, or grep before reading or editing.",
  // read 只有 path 一个参数：没有 offset 或 limit，总是返回文件开头（最多 8000 字符）。
  "The read tool takes only a path: no offset or limit, and it always returns the beginning of the file truncated to 8000 characters.",
  // 不要靠重复读同一个路径去看后面的内容；用 grep 定位，再用 edit 的原文片段精确修改。
  "Do not page through a file by calling read again; use grep to locate the region, then use edit with an exact snippet.",
  // 目标文件不存在时，只做一次有针对性的搜索去找它的实际位置。
  "If a target file is missing, perform one targeted search for its actual location.",
  // 仍然找不到时报告阻塞，不要反复猜别的路径。
  "If the target cannot be found, report the blocker instead of repeatedly guessing alternative paths.",
  // 只做满足验收条件所必需的最小改动。
  "Make the smallest changes necessary to satisfy the task's acceptance criteria.",
  // 不要重构无关代码，也不要扩大要求的实现范围。
  "Do not refactor unrelated code or expand the requested implementation scope.",
  // 改完代码后，先跑与改动范围最直接相关的测试或检查。
  "After changing code, run the narrowest relevant tests or checks first.",
  // 检查失败时，先判断是不是你的改动造成的，再决定怎么修。
  "When a check fails, determine whether your changes caused the failure before attempting another fix.",
  // 不要反复重跑一条没有任何改动的失败命令。
  "Do not repeatedly rerun an unchanged failing command.",
  // 只用前台 shell 命令；绝不要启动长期运行的服务、监听器或脱离管理的进程。
  "Use foreground shell commands only; never start long-running servers, watchers, or detached processes.",
  // 不要执行破坏性的 git 操作，也不要改写分支历史。
  "Do not perform destructive Git operations or rewrite branch history.",
  // 除非委派任务明确授权这个具体动作，否则不要提交、推送、合并、变基、重置、清理或暂存。
  "Do not commit, push, merge, rebase, reset, clean, or stash unless the delegated task explicitly authorizes that exact action.",
  // 你不能创建其他子 Agent。
  "You cannot create another subagent.",
  // 收尾前检查自己的改动，并跑 git diff --check 看空白错误。
  "Review your changes and run git diff --check before finishing.",
  // 报告改动的文件、实际跑过的检查、检查结果和未解决的问题。
  "Report changed files, checks actually executed, their results, and unresolved issues.",
  // 如果这件事无法在当前范围内安全完成，就停下来向主 Agent 报告阻塞，不要临场发挥。
  "If the task cannot be completed safely within scope, stop and report the blocker instead of improvising.",
].join("\n");

/** 写给主 Agent 的委派规矩：什么时候该委派、任务描述要写到什么程度、收到结果后还要做什么。 */
export const SUBAGENT_GUIDANCE = [
  // 你可以用 run_subagent 把一项独立任务交给临时子 Agent。
  "You can delegate one self-contained task to a temporary subagent using run_subagent.",
  // 子 Agent 看不到这段对话，所以必须把完成任务所需的全部背景写进去。
  "The subagent cannot see this conversation, so include all background required to complete its task.",
  // 只要手上有，就把确切的文件路径、函数名和相关代码位置写进去。
  "Include exact file paths, function names, and relevant code locations whenever available.",
  // 明确写出目标、范围、约束和完成标准。
  "Clearly specify the objective, scope, constraints, and completion criteria.",
  // 不要把模糊的、没有边界的大任务直接丢给子 Agent。
  "Do not delegate vague or unbounded tasks.",
  // 简单任务、以及和当前改动紧密耦合的改动，自己做完。
  "Handle simple tasks and tightly coupled changes yourself.",
  // 默认用 explore；只有确实需要改文件或跑命令时才用 execute。
  "Use explore by default; use execute only when file modifications or shell commands are genuinely required.",
  // 不要把「你或别的开发者正在改的文件」交给子 Agent 去改。
  "Do not delegate changes to files that you or another developer are actively modifying.",
  // 同一时刻只跑一个子 Agent，等它交回结果再继续。
  "Run only one subagent at a time and wait for its result before continuing.",
  // 子 Agent 只回一份最终报告和它自己的统计，不返回内部对话记录。
  "The subagent returns one final report and its own statistics, never its internal transcript.",
  // 子 Agent 失败或取消后先检查工作区：它已经做过的文件修改不会自动回滚。
  "After a subagent fails or is cancelled, inspect the workspace because its previous file changes are not automatically rolled back.",
  // 子 Agent 完成后，你仍然要自己检查它的改动和验证结果。
  "Review the subagent's changes and verification results before accepting its work.",
  // 不要因为子 Agent 说成功，就跳过你自己的最终验证。
  "Never skip your own final verification just because the subagent reported success.",
].join("\n");

/** 改写后的 shell 说明书：去掉了后台参数，所以必须同时去掉「用 background 跑服务」那句。 */
const FOREGROUND_SHELL_DESCRIPTION =
  // 跑一条 shell 命令，返回退出码与 stdout/stderr。
  "Run a shell command; returns exit code plus stdout/stderr. " +
  // 工作目录默认是工作区根目录，命令里可以 cd 到别处或用绝对路径。
  "The working directory defaults to the workspace root, and the command may cd anywhere or use absolute paths. " +
  // 只在前台执行：不会自己结束的命令（服务、监听）会一直阻塞到超时，所以不要启动它们。
  "Foreground only: a command that never exits (a server, a watcher) blocks until it times out, so never start one.";

/**
 * 把 `shell` 改成纯前台：Schema 里删掉 `background`，执行时强制 `background: false`。
 *
 * 为什么两层都要做：只删 Schema，模型仍可能从旧上下文里照抄 `background:true`；
 * 只强制 false，模型仍会以为能起后台任务，然后拿到一个它无法用 `shell-output` 跟踪的进程。
 * 已知边界：这是工具层的限制，不是操作系统级隔离 —— 命令内部仍可能自行派生脱离管理的进程。
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

/** 结果正文超长时截断，并在末尾写明丢了多少 —— 不能让人以为拿到的是完整结论。 */
function clipResult(content: string): string {
  if (content.length <= SUBAGENT_RESULT_MAX_CHARS) return content;
  const omitted = content.length - SUBAGENT_RESULT_MAX_CHARS;
  return content.slice(0, SUBAGENT_RESULT_MAX_CHARS) +
    `\n\n[... subagent result truncated: ${omitted} chars omitted]`;
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
      "Delegate one self-contained subtask to a temporary subagent that has its own context and a narrower tool set; " +
      "it returns one final report, not its internal transcript. " +
      'mode "explore" (default) can only read and search; mode "execute" may also change files and run foreground commands. ' +
      "The subagent cannot see this conversation, so put every needed detail in task. " +
      "Only one subagent runs at a time and the call returns when the subtask ends.",
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
    run: async (args) => formatSubagentResult(await runSubagent(readRequest(args))),
  };
}

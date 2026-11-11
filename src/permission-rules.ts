/**
 * 权限规则：把「这条命令以后别再问」写成一个文件。
 *
 * 为什么需要它：`Permission` 只有三档整体模式。`workspace-write` 下每条 shell 都要问一次，
 * 排查一个 bug 跑十几条命令就是十几次打断。规则让「读状态」这类命令一次批准、长期放行。
 *
 * 为什么分三层：**「跟着我走」和「跟着项目走」不是一回事**。
 * 团队约定放行 `git status` 该进版本库；你个人图省事放行 `npm run dev` 不该让整个团队继承。
 * 所以三层，优先级从高到低：
 *
 *   1. 本地 `.agent-kernel/permissions.local.json` —— 只有你，自动进 `.gitignore`
 *   2. 项目 `.agent-kernel/permissions.json` —— 团队共享，进版本库
 *   3. 用户 `~/.agent-kernel/permissions.json` —— 跨项目的个人习惯
 *
 * 菜单里点「以后不再问」写的是**本地层**：点一百次也不会污染团队的规则文件。
 * 参照 Claude Code 的 user / project / local 三层（它连 gitignore 都帮你配好）。
 *
 * 为什么不按字符串前缀匹配：`Bash(ls *)` 那种写法里，`ls && rm -rf /` 也以 `ls ` 开头，
 * 照样命中。所以这里把命令切成**参数数组**，并且把 `&&` `||` `;` `|` 连起来的复合命令拆开
 * 逐条判定，任何一条没被放行就整体不放行。Codex 的 `execpolicy` 是同一个思路。
 *
 * 保守边界：出现 `$`、反引号、重定向、通配符、反斜杠或换行时**不拆**，整条命令当作不透明。
 * 不透明命令永远匹配不上 allow，只能问你——宁可多问一次，不可误放一条。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

/** 唯一需要切分命令的工具；其他工具只支持「整个工具」粒度的规则。 */
const SHELL_TOOL = "shell";

/** 本地层相对工作区的位置。它永远不该进版本库，`remember` 会顺手写进 `.gitignore`。 */
const LOCAL_FILE = path.join(".agent-kernel", "permissions.local.json");

/** 项目层相对工作区的位置。 */
const PROJECT_FILE = path.join(".agent-kernel", "permissions.json");

/** 用户层相对 home 的位置。 */
const USER_FILE = path.join(".agent-kernel", "permissions.json");

const RULE_FIELDS = ["allow", "ask", "deny"] as const;

/** 工具名只允许标识符形状；`shell-output` 这种带连字符的也要通过。 */
const TOOL_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * 出现这些字符就不拆：它们能把一条命令变成任意行为（命令替换、重定向、通配、转义、多行），
 * 手写切分器没法保证解析结果和 shell 的实际行为一致。猜错一次就是误放。
 */
const UNSAFE_FOR_SPLITTING = /[$`<>*?\\\n\r]/;

/**
 * 一条规则。放行的宽度必须可预测，所以只有两种形状：
 *
 * - `prefix`：单条简单命令的参数前缀。`shell:git status` 也放行 `git status --short`，
 *   因为多一个参数不改变「这条命令在干什么」。
 * - `exact`：整条命令的原文，逐字比较。复合命令（`cd demo && node server.js`）和
 *   切不开的命令（`curl x 2>&1; echo $?`）都走这里——按前缀记只能记第一段，
 *   第二段就没人管了；而切不开的命令硬拆就是猜。
 */
export type PermissionRule =
  | { tool: string; kind: "prefix"; argv: string[] }
  | { tool: string; kind: "exact"; command: string };

export type RuleDecision = "allow" | "ask" | "deny";

export interface RuleSet {
  allow: PermissionRule[];
  ask: PermissionRule[];
  deny: PermissionRule[];
}

/** 一层规则：来源文件 + 三张表。数组顺序就是优先级，靠前的赢。 */
export interface RuleLayer {
  file: string;
  rules: RuleSet;
}

/** 裁决强度：数值大的赢。`none` 表示没有任何规则命中。 */
const STRENGTH: Record<RuleDecision | "none", number> = { none: 0, allow: 1, ask: 2, deny: 3 };

function stricter(a: RuleDecision | "none", b: RuleDecision | "none"): RuleDecision | "none" {
  return STRENGTH[b] > STRENGTH[a] ? b : a;
}

/**
 * 空白归一：去首尾空白，把连续空白压成一个空格。
 *
 * 精确规则靠它比较——模型偶尔在参数之间多打一个空格，那不该算「另一条命令」。
 * 但**不碰其他任何字符**：多一个参数、换一个引号，都必须重新问。
 */
function normalize(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/** 写回文件时给带空白的 token 加引号，否则 `git commit -m "fix bug"` 会被拆成两段。 */
function quoteToken(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

/** 规则写回文件的形状：精确规则原样写，前缀规则把参数拼起来。 */
function serialize(rule: PermissionRule): string {
  if (rule.kind === "exact") return `${rule.tool}:${rule.command}`;
  return rule.argv.length === 0 ? rule.tool : `${rule.tool}:${rule.argv.map(quoteToken).join(" ")}`;
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  if (a.tool !== b.tool || a.kind !== b.kind) return false;
  if (a.kind === "exact" && b.kind === "exact") return a.command === b.command;
  if (a.kind === "prefix" && b.kind === "prefix") return sameTokens(a.argv, b.argv);
  return false;
}

/**
 * 把一条规则文本拆成工具名与命令 token。
 *
 * 命令部分用**和真实命令同一个切分器**解析：切成单段就是前缀规则（`shell:git status`），
 * 其余一律整条精确规则（`shell:cd demo && node server.js`、`shell:curl x 2>&1; echo $?`）。
 * 写几条就是几条，不会出现「写了复合命令却只匹配第一段」这种错觉。
 */
function parseRule(text: string, where: string): PermissionRule {
  const colon = text.indexOf(":");
  const tool = colon < 0 ? text.trim() : text.slice(0, colon).trim();
  const rest = colon < 0 ? "" : text.slice(colon + 1).trim();
  if (tool === "") throw new Error(`${where}: rule "${text}" has no tool name`);
  // 工具名必须是标识符。少了这一条，`"rm -rf"` 会被当成「名为 rm -rf 的工具」而静默无效——
  // 用户以为写了条 deny，实际什么都没拦。
  if (!TOOL_NAME.test(tool)) {
    throw new Error(`${where}: "${tool}" is not a tool name (write "shell:rm -rf", not "rm -rf")`);
  }
  if (colon >= 0 && rest === "") {
    // 「shell:」既可能被读成「所有 shell 命令」也可能被读成写漏了，不能猜。
    throw new Error(`${where}: rule "${text}" ends with ":" but no argument prefix`);
  }
  if (rest === "") return { tool, kind: "prefix", argv: [] };
  const segments = splitCommand(rest);
  if (segments !== null && segments.length === 1) {
    return { tool, kind: "prefix", argv: segments[0]! };
  }
  // 多段或切不开：整条原文精确匹配。一个字符不同就不命中，所以这里不需要理解它。
  return { tool, kind: "exact", command: normalize(rest) };
}

/** 解析规则文件正文；形状不对就报错，绝不静默忽略一份安全配置。 */
export function parseRules(text: string, source: string): RuleSet {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: expected an object with "allow" / "ask" / "deny" arrays`);
  }
  const rules: RuleSet = { allow: [], ask: [], deny: [] };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(RULE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`${source}: unknown field "${key}" (expected: allow, ask, deny)`);
    }
    if (!Array.isArray(value)) throw new Error(`${source}: "${key}" must be an array of strings`);
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") throw new Error(`${source}: "${key}[${index}]" must be a string`);
      rules[key as (typeof RULE_FIELDS)[number]].push(parseRule(entry, `${source}: ${key}[${index}]`));
    }
  }
  return rules;
}

/**
 * 把一条 shell 命令切成若干「简单命令」。
 *
 * 返回 `null` 表示无法安全解析，调用方必须按「需要审批」处理。只有四种连接符会切开：
 * `&&`、`||`、`;`、`|`。单个 `&`（后台执行）直接判为不可解析。
 */
export function splitCommand(command: string): string[][] | null {
  if (UNSAFE_FOR_SPLITTING.test(command)) return null;
  const segments: string[][] = [];
  let argv: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;

  const endToken = () => {
    if (token !== "") {
      argv.push(token);
      token = "";
    }
  };
  const endSegment = () => {
    endToken();
    if (argv.length > 0) segments.push(argv);
    argv = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "&") {
      // 单个 & 是后台执行，语义和 && 完全不同；不猜，整条按不可解析处理。
      if (command[index + 1] !== "&") return null;
      endSegment();
      index++;
      continue;
    }
    if (char === "|") {
      if (command[index + 1] === "|") index++;
      endSegment();
      continue;
    }
    if (char === ";") {
      endSegment();
      continue;
    }
    if (char === " " || char === "\t") {
      endToken();
      continue;
    }
    token += char;
  }
  // 引号没闭合：这半条命令的实际行为和字面差得很远，不能拆。
  if (quote !== undefined) return null;
  endSegment();
  return segments;
}

/** 前缀匹配：规则的 token 必须逐项等于命令开头。 */
function matchesPrefix(argv: readonly string[], segment: readonly string[]): boolean {
  if (argv.length > segment.length) return false;
  return argv.every((part, index) => part === segment[index]);
}

/**
 * 一条规则能不能整条管住这条命令。
 *
 * 前缀规则只对**单段**命令生效。多段或切不开的命令只能被精确规则整条管住——
 * 否则 `shell:git status` 会顺带放行 `git status && curl evil`。
 *
 * 例外是**空参数规则**（只写工具名，如 `shell`）：它的意思是「这个工具的任意调用」，
 * 所以连切不开的命令也算。这是 Claude Code 裸 `Bash` 规则的等价物——
 * 少了这条，`"allow": ["shell"]` 对 `curl x 2>&1` 这种命令就不生效，等于形同虚设。
 */
function matchesCommand(
  rule: PermissionRule,
  tool: string,
  raw: string,
  segments: readonly string[][] | null,
): boolean {
  if (rule.tool !== tool) return false;
  if (rule.kind === "exact") return normalize(raw) === rule.command;
  if (rule.argv.length === 0) return true;
  return segments !== null && segments.length === 1 && matchesPrefix(rule.argv, segments[0]!);
}

/** 前缀规则对单段命令的命中判定。 */
function matchesSegment(rule: PermissionRule, tool: string, segment: readonly string[]): boolean {
  return rule.tool === tool && rule.kind === "prefix" && matchesPrefix(rule.argv, segment);
}

/**
 * deny 跨层最强：任何一层写了 deny 就拒绝。团队写了 `deny: rm -rf`，
 * 你本地再写 allow 也不生效——安全方向的例外值得这个不一致。
 *
 * 切不开的命令也要被拦住：`rm -rf / 2>&1` 里有 `>`，拆不开，但它的开头就是 `rm -rf`。
 * deny 方向上宁可多拦——漏拦一次是灾难，多拦一次只是多问一句。
 */
function deniesAny(
  layers: readonly RuleLayer[],
  tool: string,
  raw: string,
  segments: readonly string[][] | null,
): boolean {
  return layers.some((layer) => layer.rules.deny.some((rule) => {
    if (rule.tool !== tool) return false;
    if (rule.kind === "exact") return normalize(raw) === rule.command;
    if (segments !== null) return segments.some((segment) => matchesPrefix(rule.argv, segment));
    return matchesPrefix(rule.argv, normalize(raw).split(" "));
  }));
}

/**
 * 一条命令能不能被「以后不再问」记住。
 *
 * 现在几乎什么都能记：切不开的命令按整条原文存，逐字比较，一个字符都不放宽。
 * 唯一不收的是空命令——它没有可记的内容。
 */
export function isRememberable(command: string): boolean {
  return normalize(command) !== "";
}

/**
 * 判断一次工具调用该走哪条路。
 *
 * 返回 `none` 表示**没有任何规则命中**，由调用方按模式决定默认动作。
 *
 * 顺序：先看 deny（跨层），再看整条精确规则（按层序），最后逐段做前缀裁决。
 * 切不开的命令到此为止——它们永远不会被 allow 放过，只能问。
 */
export function decideRules(
  layers: readonly RuleLayer[],
  tool: string,
  args: Record<string, unknown>,
): RuleDecision | "none" {
  const raw = tool === SHELL_TOOL && typeof args.command === "string" ? args.command : "";
  // 非 shell 工具没有命令可切，当作一段空命令：只有「整个工具」粒度的规则能命中。
  const segments = tool === SHELL_TOOL ? splitCommand(raw) : [[]];

  if (deniesAny(layers, tool, raw, segments)) return "deny";

  // 整条精确规则：按层序，第一个命中的层说话。
  for (const layer of layers) {
    if (layer.rules.ask.some((rule) => matchesCommand(rule, tool, raw, segments))) return "ask";
    if (layer.rules.allow.some((rule) => matchesCommand(rule, tool, raw, segments))) return "allow";
  }

  // 切不开的命令到此为止：没有精确规则命中，就不能放行。
  if (segments === null || segments.length === 0) return "ask";

  let matched = false;
  let decision: RuleDecision | "none" = "none";
  for (const segment of segments) {
    let one: RuleDecision | "none" = "none";
    for (const layer of layers) {
      if (layer.rules.ask.some((rule) => matchesSegment(rule, tool, segment))) {
        one = "ask";
        break;
      }
      if (layer.rules.allow.some((rule) => matchesSegment(rule, tool, segment))) {
        one = "allow";
        break;
      }
    }
    if (one === "none") {
      // 这一段没有任何规则命中：它不能被别的段的 allow 带过去。
      decision = stricter(decision, "ask");
      continue;
    }
    matched = true;
    decision = stricter(decision, one);
  }
  // 一条规则都没命中就交还给调用方，而不是在这里冒充「需要审批」——
  // 那样调用方永远看不到「没有规则」这个事实。
  return matched ? decision : "none";
}

/** 读一份规则文件；不存在就是这一层没有规则，不算错误。 */
async function readLayer(file: string): Promise<RuleLayer> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { file, rules: { allow: [], ask: [], deny: [] } };
    throw error;
  }
  return { file, rules: parseRules(text, file) };
}

/** 把一层规则写成文件；空层也照写，删掉规则时文件要跟着变空。 */
async function writeLayer(layer: RuleLayer): Promise<void> {
  await mkdir(path.dirname(layer.file), { recursive: true });
  const body: Record<string, string[]> = {};
  for (const field of RULE_FIELDS) {
    const entries = layer.rules[field].map(serialize);
    if (entries.length > 0) body[field] = entries;
  }
  // 末尾留换行：项目层的规则文件要提交进仓库，别让它成为 diff 里的噪音源。
  await writeFile(layer.file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/**
 * 把本地层文件加进 `.gitignore`。
 *
 * 只有真的是 git 仓库才动手；已经有这一行就不重复写。追加而不是覆盖——
 * 这是用户的文件，不是我们的。
 */
async function ensureGitIgnored(root: string, entry: string): Promise<void> {
  try {
    await stat(path.join(root, ".git"));
  } catch {
    return;
  }
  const file = path.join(root, ".gitignore");
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  if (text.split("\n").some((line) => line.trim() === entry)) return;
  // 原文件末尾没有换行时先补一个，否则会把最后一行和我们的条目粘成一行。
  const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
  await writeFile(file, `${text}${prefix}${entry}\n`, "utf8");
}

/**
 * 三层规则集合。加载一次，之后由 `Permission` 查询；「以后不再问」写回本地层。
 */
export class PermissionRules {
  /** 优先级从高到低：本地、项目、用户。 */
  private readonly layers: RuleLayer[];

  /** 工作区根目录：`remember` 要往这里写本地层和 `.gitignore`。 */
  private readonly root: string;

  private constructor(layers: RuleLayer[], root: string) {
    this.layers = layers;
    this.root = root;
  }

  /**
   * 读三层规则。任何一层文件存在但内容不合法都**直接报错**——
   * 静默忽略一份安全配置比没有它更危险。
   */
  static async load(root: string): Promise<PermissionRules> {
    const [local, project, user] = await Promise.all([
      readLayer(path.join(root, LOCAL_FILE)),
      readLayer(path.join(root, PROJECT_FILE)),
      readLayer(path.join(process.env.AGENT_KERNEL_HOME ?? homedir(), USER_FILE)),
    ]);
    return new PermissionRules([local, project, user], root);
  }

  /** 三层文件的位置，用于把「是哪份配置拦的」说清楚。 */
  get sources(): string[] {
    return this.layers.map((layer) => layer.file);
  }

  /**
   * 判断一次工具调用该走哪条路。语义见 `decideRules`。
   */
  decide(tool: string, args: Record<string, unknown>): RuleDecision | "none" {
    return decideRules(this.layers, tool, args);
  }

  /**
   * 把一条命令记成 allow 规则并落盘，返回写进去的规则文本。
   *
   * 写的是**本地层**：菜单里的一次点头属于个人偏好，不该进团队的规则文件。
   *
   * 单条简单命令记成前缀规则（`git status` 顺带放行 `git status --short`）；
   * 其余——复合命令、带重定向/通配/命令替换的命令——记成整条精确规则，按原文比较。
   * 后者是「几乎什么都能记住」的关键：切不开的命令不需要被理解，只需要被一模一样地认出来。
   */
  async remember(command: string): Promise<string> {
    const normalized = normalize(command);
    if (normalized === "") throw new Error("cannot remember an empty command");
    const segments = splitCommand(command);
    const prefix = segments !== null && segments.length === 1 ? segments[0]! : undefined;
    const rule: PermissionRule = prefix !== undefined
      ? { tool: SHELL_TOOL, kind: "prefix", argv: prefix }
      : { tool: SHELL_TOOL, kind: "exact", command: normalized };
    const local = this.layers[0]!;
    if (!local.rules.allow.some((existing) => sameRule(existing, rule))) {
      local.rules.allow.push(rule);
      await writeLayer(local);
    }
    // 即使规则已经在，也补一次忽略：文件可能是用户手工建的。
    await ensureGitIgnored(this.root, LOCAL_FILE.split(path.sep).join("/"));
    return serialize(rule);
  }
}

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

/** 一条规则：工具名 + 参数前缀。`shell:git status` 只放行以 `git status` 开头的命令。 */
export interface PermissionRule {
  tool: string;
  /** 参数前缀；空数组表示「这个工具的任意调用」（规则只写工具名时）。 */
  argv: string[];
}

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
 * 把一条规则文本拆成工具名与参数前缀。
 *
 * 前缀按空白切分，**不处理引号**：规则里写不出带空格的参数（`node -e "..."` 这种命令
 * 本来也无法用规则放行）。这条限制是刻意的——规则写不清就等于没有规则。
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
  return { tool, argv: rest === "" ? [] : rest.split(/\s+/) };
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

/** 规则命中判定：规则的参数前缀必须逐项等于命令开头。 */
function matches(rule: PermissionRule, tool: string, argv: string[]): boolean {
  if (rule.tool !== tool) return false;
  if (rule.argv.length > argv.length) return false;
  return rule.argv.every((part, index) => part === argv[index]);
}

/**
 * 单条简单命令的裁决。
 *
 * 两条规则同时决定一件事：
 *   - **deny 跨层最强**：任何一层写了 deny 就拒绝。团队写了 `deny: rm -rf`，
 *     你本地再写 allow 也不生效——安全方向的例外值得这个不一致。
 *   - 其余按层序，靠前的层先说话：本地压过项目，项目压过用户。
 */
function decideOne(layers: readonly RuleLayer[], tool: string, argv: string[]): RuleDecision | "none" {
  if (layers.some((layer) => layer.rules.deny.some((rule) => matches(rule, tool, argv)))) return "deny";
  for (const layer of layers) {
    if (layer.rules.ask.some((rule) => matches(rule, tool, argv))) return "ask";
    if (layer.rules.allow.some((rule) => matches(rule, tool, argv))) return "allow";
  }
  return "none";
}

/** 一条命令能不能被「以后不再问」记住：必须是能安全解析的单条简单命令。 */
export function isRememberable(command: string): boolean {
  const segments = splitCommand(command);
  return segments !== null && segments.length === 1;
}

/**
 * 判断一次工具调用该走哪条路。
 *
 * 返回 `none` 表示**没有任何规则命中**，由调用方按模式决定默认动作。
 * 复合命令里只要有一段没被放行，整体就不算放行——否则 `git status && curl evil`
 * 会被第一条的 allow 带过去。
 */
export function decideRules(
  layers: readonly RuleLayer[],
  tool: string,
  args: Record<string, unknown>,
): RuleDecision | "none" {
  if (tool !== SHELL_TOOL) return decideOne(layers, tool, []);
  const command = typeof args.command === "string" ? args.command : "";
  const segments = splitCommand(command);
  if (segments === null || segments.length === 0) return "ask";
  let matched = false;
  let decision: RuleDecision | "none" = "none";
  for (const segment of segments) {
    const one = decideOne(layers, tool, segment);
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
    const entries = layer.rules[field].map((rule) =>
      rule.argv.length === 0 ? rule.tool : `${rule.tool}:${rule.argv.join(" ")}`);
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
   * 只接受能安全解析的单条简单命令——复合命令记成一条前缀规则会放行比用户点的那次更多的东西。
   */
  async remember(command: string): Promise<string> {
    const segments = splitCommand(command);
    if (segments === null || segments.length !== 1) {
      throw new Error(`cannot remember "${command}": only a single simple command can become a rule`);
    }
    const argv = segments[0]!;
    const text = `${SHELL_TOOL}:${argv.join(" ")}`;
    const local = this.layers[0]!;
    const exists = local.rules.allow.some(
      (rule) => rule.tool === SHELL_TOOL && rule.argv.length === argv.length &&
        rule.argv.every((part, index) => part === argv[index]),
    );
    if (!exists) {
      local.rules.allow.push({ tool: SHELL_TOOL, argv });
      await writeLayer(local);
    }
    // 即使规则已经在，也补一次忽略：文件可能是用户手工建的。
    await ensureGitIgnored(this.root, LOCAL_FILE.split(path.sep).join("/"));
    return text;
  }
}

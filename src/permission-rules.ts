/**
 * 项目级权限规则：把「这条命令以后别再问」写成一个文件。
 *
 * 为什么需要它：`Permission` 只有三档整体模式。`workspace-write` 下每条 shell 都要问一次，
 * 排查一个 bug 跑十几条命令就是十几次打断。规则让「读状态」这类命令一次批准、长期放行。
 *
 * 为什么不按字符串前缀匹配：`Bash(ls *)` 那种写法里，`ls && rm -rf /` 也以 `ls ` 开头，
 * 照样命中。所以这里把命令切成**参数数组**，并且把 `&&` `||` `;` `|` 连起来的复合命令拆开
 * 逐条判定，任何一条没被放行就整体不放行。Codex 的 `execpolicy` 是同一个思路。
 *
 * 保守边界：出现 `$`、反引号、重定向、通配符、反斜杠或换行时**不拆**，整条命令当作不透明。
 * 不透明命令永远匹配不上 allow，只能问你——宁可多问一次，不可误放一条。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

/** 规则文件相对工作区的位置。跟 `.claude/settings.json` 一样是项目级：换个仓库，信任程度也不同。 */
const RULES_FILE = path.join(".agent-kernel", "permissions.json");

/** 唯一需要切分命令的工具；其他工具只支持「整个工具」粒度的规则。 */
const SHELL_TOOL = "shell";

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

function decideOne(rules: RuleSet, tool: string, argv: string[]): RuleDecision | "none" {
  if (rules.deny.some((rule) => matches(rule, tool, argv))) return "deny";
  if (rules.ask.some((rule) => matches(rule, tool, argv))) return "ask";
  if (rules.allow.some((rule) => matches(rule, tool, argv))) return "allow";
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
  rules: RuleSet,
  tool: string,
  args: Record<string, unknown>,
): RuleDecision | "none" {
  if (tool !== SHELL_TOOL) return decideOne(rules, tool, []);
  const command = typeof args.command === "string" ? args.command : "";
  const segments = splitCommand(command);
  if (segments === null || segments.length === 0) return "ask";
  let matched = false;
  let decision: RuleDecision | "none" = "none";
  for (const segment of segments) {
    const one = decideOne(rules, tool, segment);
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

/**
 * 项目级规则集合。加载一次，之后由 `Permission` 查询；「以后不再问」会写回同一个文件。
 */
export class PermissionRules {
  private readonly file: string;

  private rules: RuleSet;

  private constructor(file: string, rules: RuleSet) {
    this.file = file;
    this.rules = rules;
  }

  /**
   * 读工作区的规则文件。文件不存在就是没有规则，不算错误；
   * 文件存在但内容不合法**直接报错**——静默忽略一份安全配置比没有它更危险。
   */
  static async load(root: string): Promise<PermissionRules> {
    const file = path.join(root, RULES_FILE);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return new PermissionRules(file, { allow: [], ask: [], deny: [] });
      throw error;
    }
    return new PermissionRules(file, parseRules(text, file));
  }

  get filePath(): string {
    return this.file;
  }

  /**
   * 判断一次工具调用该走哪条路。语义见 `decideRules`。
   */
  decide(tool: string, args: Record<string, unknown>): RuleDecision | "none" {
    return decideRules(this.rules, tool, args);
  }

  /**
   * 把一条命令记成 allow 规则并落盘，返回写进去的规则文本。
   *
   * 只接受能安全解析的单条简单命令：复合命令记成一条前缀规则会放行比用户点的那次更多的东西。
   */
  async remember(command: string): Promise<string> {
    const segments = splitCommand(command);
    if (segments === null || segments.length !== 1) {
      throw new Error(`cannot remember "${command}": only a single simple command can become a rule`);
    }
    const argv = segments[0]!;
    const text = `${SHELL_TOOL}:${argv.join(" ")}`;
    const exists = this.rules.allow.some(
      (rule) => rule.tool === SHELL_TOOL && rule.argv.length === argv.length &&
        rule.argv.every((part, index) => part === argv[index]),
    );
    if (!exists) {
      this.rules.allow.push({ tool: SHELL_TOOL, argv });
      await this.save();
    }
    return text;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const body: Record<string, string[]> = {};
    for (const field of RULE_FIELDS) {
      const entries = this.rules[field].map((rule) =>
        rule.argv.length === 0 ? rule.tool : `${rule.tool}:${rule.argv.join(" ")}`);
      if (entries.length > 0) body[field] = entries;
    }
    // 末尾留换行：规则文件是要提交进仓库的，别让它成为 diff 里的噪音源。
    await writeFile(this.file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }
}

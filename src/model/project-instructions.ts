/**
 * 文件目的：把仓库根目录的 `AGENTS.md` 读出来，塞进给模型的系统提示。
 *
 * 有了它，模型不用每轮靠用户口头重复项目规矩；项目自己写下的约定跟着仓库走。
 *
 * 文件职责：负责读文件、去空白、按上限截断、拼成提示段落。
 * 不负责解析内容格式 —— 原样送进去，免得自己发明一套没人维护的格式。
 * 也不负责决定什么时候注入，那是 `cli.ts` 装配时的事。
 *
 * 内容目录：
 *   - `PROJECT_INSTRUCTIONS_FILE`：约定的文件名。
 *   - `MAX_INSTRUCTIONS_CHARS`：32000 字符上限，整份塞进系统提示会挤掉对话预算。
 *   - `ProjectInstructions`：读取结果（真实路径、正文、是否被截断）。
 *   - `readProjectInstructions()`：读工作区根目录下的项目指令。
 *   - `projectInstructionsPrompt()`：把结果拼成系统提示里的一段。
 *
 * 模块关系：只依赖 `node:fs` 与 `node:path`。
 * 由 `cli.ts` 在装配时调用，拼好的文本随系统提示交给 `core/agent.ts`。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** 约定的文件名。以后要支持 `.agent/AGENTS.md` 之类，在这里加候选即可。 */
export const PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";

/** 超过这个长度就截断：整份塞进系统提示会挤掉对话预算。 */
export const MAX_INSTRUCTIONS_CHARS = 32_000;

export interface ProjectInstructions {
  /** 实际读取到的文件路径（便于展示与排查）。 */
  path: string;
  /** 正文，可能已被截断。 */
  text: string;
  /** 原文是否超过上限。 */
  truncated: boolean;
}

/**
 * 读取工作区根目录下的项目指令；文件不存在或为空时返回 `undefined`。
 *
 * 读不到不算错误：没有 `AGENTS.md` 的项目占多数，调用方按「没有指令」继续。
 */
export function readProjectInstructions(root: string): ProjectInstructions | undefined {
  const file = path.join(root, PROJECT_INSTRUCTIONS_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const text = raw.trim();
  if (text === "") return undefined;
  if (text.length <= MAX_INSTRUCTIONS_CHARS) return { path: file, text, truncated: false };
  return {
    path: file,
    text: `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[... ${PROJECT_INSTRUCTIONS_FILE} truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`,
    truncated: true,
  };
}

/** 拼进系统提示的那一段：标题说清来源，正文原样保留。 */
export function projectInstructionsPrompt(instructions: ProjectInstructions): string {
  return [
    `# Project instructions (${PROJECT_INSTRUCTIONS_FILE})`,
    "These come from the repository, not from the user's current message. Follow them unless the user says otherwise.",
    "",
    instructions.text,
  ].join("\n");
}

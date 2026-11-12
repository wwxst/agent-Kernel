/**
 * 项目指令文件（`AGENTS.md`）的读取。
 *
 * Claude Code 读 `CLAUDE.md`（仓库里已有 `AGENTS.md` 时优先用它），Codex 读 `AGENTS.md`。
 * 作用相同：把项目自己的规范、命令、约定注入系统提示，模型不必每轮靠用户口头交代。
 *
 * 这里只做「读 + 有界截断」，不做解析：内容原样进提示，避免我们发明一套没人维护的格式。
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

/**
 * 文件目的：把仓库根目录的 `AGENTS.md` 读出来，塞进给模型的系统提示。
 *
 * 有了它，模型不用每轮靠用户口头重复项目规矩；项目自己写下的约定跟着仓库走。
 *
 * 文件职责：负责有界读文件、去空白、按上限截断、拼成提示段落。
 * 不负责解析内容格式 —— 原样送进去，免得自己发明一套没人维护的格式。
 * 也不负责决定什么时候注入，那是 `cli.ts` 装配时的事。
 *
 * 内容目录：
 *   - `PROJECT_INSTRUCTIONS_FILE`：约定的文件名。
 *   - `MAX_INSTRUCTIONS_CHARS`：32000 字符上限，整份塞进系统提示会挤掉对话预算。
 *   - 字节读取窗口：最多 8 MiB，超出窗口也在正文标明截断。
 *   - `ProjectInstructions`：读取结果（真实路径、正文、是否被截断）。
 *   - `readProjectInstructions()`：读工作区根目录下的项目指令。
 *   - `projectInstructionsPrompt()`：把结果拼成系统提示里的一段。
 *
 * 模块关系：只依赖 `node:fs` 与 `node:path`。
 * 由 `cli.ts` 在装配时调用，拼好的文本随系统提示交给 `core/agent.ts`。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

/** 约定的文件名。以后要支持 `.agent/AGENTS.md` 之类，在这里加候选即可。 */
export const PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";

/** 超过这个长度就截断：整份塞进系统提示会挤掉对话预算。 */
export const MAX_INSTRUCTIONS_CHARS = 32_000;

/** 已知边界：字符截断不能限制实际读取量；极长空白前缀也只读取 8 MiB。 */
const MAX_INSTRUCTIONS_BYTES = 8 * 1024 * 1024;

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
  let raw = "";
  let byteTruncated = false;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    if (!fstatSync(descriptor).isFile()) return undefined;
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder();
    let received = 0;
    while (received < MAX_INSTRUCTIONS_BYTES) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, MAX_INSTRUCTIONS_BYTES - received), null);
      if (count === 0) break;
      received += count;
      raw += decoder.decode(buffer.subarray(0, count), { stream: true });
    }
    // 多探一个字节区分「刚好到上限」和「确实丢了尾部」；不把截断的 UTF-8 半字写成替换字符。
    byteTruncated = received === MAX_INSTRUCTIONS_BYTES && readSync(descriptor, buffer, 0, 1, null) > 0;
    if (!byteTruncated) raw += decoder.decode();
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const text = raw.trim();
  if (text === "" && !byteTruncated) return undefined;
  if (text.length <= MAX_INSTRUCTIONS_CHARS && !byteTruncated) return { path: file, text, truncated: false };
  return {
    path: file,
    text: `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[... ${PROJECT_INSTRUCTIONS_FILE} truncated at ${byteTruncated ? `${MAX_INSTRUCTIONS_BYTES} bytes` : `${MAX_INSTRUCTIONS_CHARS} characters`}]`,
    truncated: true,
  };
}

/** 拼进系统提示的那一段：标题说清来源，正文原样保留。 */
export function projectInstructionsPrompt(instructions: ProjectInstructions): string {
  return [
    // 项目指令（AGENTS.md）。
    `# Project instructions (${PROJECT_INSTRUCTIONS_FILE})`,
    // 这些指令来自仓库，而不是用户当前的消息。
    // 除非用户另有要求，否则请遵循这些指令。
    "These come from the repository, not from the user's current message. Follow them unless the user says otherwise.",
    "",
    instructions.text,
  ].join("\n");
}

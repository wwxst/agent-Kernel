/**
 * 工具层：模型唯一能碰真实世界的入口。
 *
 * 设计上只有两条规矩，但都很重要：
 *
 *   1. 路径必须留在工作区内。模型会写出 "../../etc/passwd" 这种参数（不是它坏，
 *      是它在按训练数据里的「常见写法」猜），所以每次读写前都要 resolve + 校验。
 *   2. 工具失败不抛异常，而是变成 "ERROR: ..." 文本。错误是循环里的常态，
 *      回灌给模型，它下一轮就能自己改；抛出去只会让整个会话崩掉。
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Tool, ToolCall } from "./types.ts";

/** 单个工具返回给模型的字符上限：防止一条命令刷屏把上下文撑爆。 */
const MAX_OUTPUT_CHARS = 8_000;

/**
 * 把模型给的相对路径解析成绝对路径，并确保它没有跑出工作区。
 *
 * 判断用的是 path.relative 的结果，而不是简单的字符串 startsWith("..")：
 * 后者会把 "..notes.md" 这种合法文件名也误杀，属于典型的路径校验 bug。
 */
export function resolveIn(root: string, requested: string): string {
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);

  // relative 为空 = 就是根目录本身；以 ".." 开头 = 跑到了根目录外面；
  // 返回绝对路径 = 换了盘符（Windows 上 "D:\x" 相对 C:\root 就是这种情况）。
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  return absolute;
}

/** 超出上限就截断，并明确告诉模型「后面还有，但你看不到了」。 */
function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const hidden = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${hidden} chars]`;
}

/** 把任意抛出物转成一行人类可读的文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 在工作区根目录执行一条 shell 命令，收集 stdout + stderr。
 *
 * 两个现实问题：
 *   - 命令可能永远不结束（比如起了个 dev server），所以要有超时；
 *   - 超时后杀掉的是外层 shell，Windows 上它派生的子进程可能残留 ——
 *     这里接受这个限制，真要彻底清理得用 taskkill /T，会显著增加复杂度。
 */
function runCommand(root: string, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: root, shell: true, windowsHide: true });
    let output = "";

    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // exit code 也一起返回：模型需要知道命令是成功还是失败。
      resolve(truncate(`exit ${code}\n${output}`.trimEnd()));
    });
  });
}

export interface WorkspaceToolsOptions {
  /** 工具的沙箱根目录。 */
  root: string;
  /** 单条 shell 命令的超时，默认 120 秒。 */
  timeoutMs?: number;
}

/**
 * 造一套「最小可用」的编码工具：读、写、列目录、跑命令。
 *
 * 刻意保持只有四个。工具越多，系统提示词越长、模型选错工具的概率越高；
 * 真的需要更多能力时，优先让 run_command 去组合，而不是继续加工具。
 */
export function createWorkspaceTools({ root, timeoutMs = 120_000 }: WorkspaceToolsOptions): Tool[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file. Output is truncated to 8000 chars.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the workspace root." } },
        required: ["path"],
      },
      run: async (args) => {
        const file = resolveIn(root, String(args.path));
        return truncate(await readFile(file, "utf8"));
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a UTF-8 file; parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
      run: async (args) => {
        const file = resolveIn(root, String(args.path));
        const content = String(args.content ?? "");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content, "utf8");
        return `wrote ${content.length} chars to ${String(args.path)}`;
      },
    },
    {
      name: "list_dir",
      description: "List a directory: entry type, size in bytes, and name.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory relative to the workspace root." } },
        required: ["path"],
      },
      run: async (args) => {
        const dir = resolveIn(root, String(args.path));
        const entries = await readdir(dir, { withFileTypes: true });
        const rows = await Promise.all(
          entries.map(async (entry) => {
            const size = entry.isFile() ? (await stat(path.join(dir, entry.name))).size : 0;
            const kind = entry.isDirectory() ? "dir " : "file";
            return `${kind} ${String(size).padStart(8)}  ${entry.name}`;
          }),
        );
        return rows.sort().join("\n") || "(empty directory)";
      },
    },
    {
      name: "run_command",
      description: "Run a shell command in the workspace root; returns exit code plus stdout/stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command, executed with the workspace root as cwd." } },
        required: ["command"],
      },
      run: async (args) => runCommand(root, String(args.command), timeoutMs),
    },
  ];
}

/**
 * 按名字执行一次工具调用。
 *
 * 这个函数刻意「永不抛异常」：所有失败都折成 "ERROR: ..." 文本返回。
 * 理由再说一遍，因为这是整个设计里最容易被写错的地方：
 *   - 抛异常 = 循环终止 = 用户得从头再来；
 *   - 返回错误文本 = 模型下一轮读到 "ERROR: ENOENT ..." = 它自己换个路径重试。
 * 后者才是 agent 该有的行为。
 */
export async function executeTool(tools: Tool[], call: ToolCall): Promise<string> {
  const name = call.function.name;
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    // 模型会「幻觉」出不存在的工具名，这不是异常，是正常要处理的分支。
    const available = tools.map((candidate) => candidate.name).join(", ");
    return `ERROR: unknown tool "${name}" (available: ${available})`;
  }

  let args: Record<string, unknown>;
  try {
    // arguments 可能为空串（无参工具），也可能被模型写坏 —— 两种都要兜住。
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `ERROR: arguments must be a JSON object, got ${JSON.stringify(parsed)}`;
    }
    args = parsed as Record<string, unknown>;
  } catch (error) {
    return `ERROR: invalid JSON arguments: ${errorMessage(error)}`;
  }

  try {
    return await tool.run(args);
  } catch (error) {
    return `ERROR: ${errorMessage(error)}`;
  }
}

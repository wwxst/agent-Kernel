/**
 * 工作区：agent 唯一能碰真实世界的入口。
 *
 * 这个模块把三件「容易写错、但调用方不该关心」的事情关在门后：
 *
 *   1. 路径必须留在工作区内。模型会写出 "../../etc/passwd" 这种参数（不是它坏，
 *      是它在按训练数据里的「常见写法」猜），所以每次读写前都要 resolve + 校验。
 *   2. 输出必须有上限。一条命令刷屏几万行就能把上下文撑爆，读和跑都要截断。
 *   3. 命令必须有超时。命令可能永远不结束（比如起了个 dev server）。
 *
 * 失败时它抛异常 —— 这是它在接口上的错误模式；
 * 折成 "ERROR: ..." 文本回灌给模型是 Toolbelt 的事，不是这里的事。
 * 两个模块各管一个决定，改的时候不会互相牵动。
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "./types.ts";

/** 单个工具返回给模型的字符上限：防止一条命令刷屏把上下文撑爆。 */
const MAX_OUTPUT_CHARS = 8_000;

const DEFAULT_TIMEOUT_MS = 120_000;

export interface WorkspaceOptions {
  /** 沙箱根目录，必须是绝对路径。工具只能碰它下面的东西。 */
  root: string;
  /** 单条 shell 命令的超时，默认 120 秒。 */
  timeoutMs?: number;
}

/**
 * 一套「最小可用」的编码能力：读、写、列目录、跑命令。
 *
 * 刻意只有四个。工具越多，系统提示词越长、模型选错工具的概率越高；
 * 真的需要更多能力时，优先让 shell 工具去组合，而不是继续加方法。
 */
export class Workspace {
  private readonly root: string;

  private readonly timeoutMs: number;

  constructor({ root, timeoutMs = DEFAULT_TIMEOUT_MS }: WorkspaceOptions) {
    this.root = root;
    this.timeoutMs = timeoutMs;
  }

  /** 读一个 UTF-8 文本文件，超长截断。 */
  async read(requested: string): Promise<string> {
    const file = this.resolve(requested);
    return this.truncate(await readFile(file, "utf8"));
  }

  /** 创建或覆盖文件，父目录自动补齐。返回一行给模型看的结果摘要。 */
  async write(requested: string, content: string): Promise<string> {
    const file = this.resolve(requested);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return `wrote ${content.length} chars to ${requested}`;
  }

  /** 列目录：类型、字节数、名称，按行排好。 */
  async list(requested: string): Promise<string> {
    const dir = this.resolve(requested);
    const entries = await readdir(dir, { withFileTypes: true });
    const rows = await Promise.all(
      entries.map(async (entry) => {
        const size = entry.isFile() ? (await stat(path.join(dir, entry.name))).size : 0;
        const kind = entry.isDirectory() ? "dir " : "file";
        return `${kind} ${String(size).padStart(8)}  ${entry.name}`;
      }),
    );
    return rows.sort().join("\n") || "(empty directory)";
  }

  /**
   * 在工作区根目录执行一条 shell 命令，返回「exit code + stdout/stderr」。
   *
   * 已知边界：超时杀掉的是外层 shell，Windows 上它派生的子进程可能残留。
   * 这里接受这个限制 —— 真要彻底清理得用 taskkill /T，会显著增加复杂度。
   */
  async run(command: string): Promise<string> {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, { cwd: this.root, shell: true, windowsHide: true });
      let collected = "";

      const timer = setTimeout(() => child.kill(), this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => (collected += chunk));
      child.stderr.on("data", (chunk: Buffer) => (collected += chunk));

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        // exit code 也一起返回：模型需要知道命令是成功还是失败。
        resolve(`exit ${code}\n${collected}`.trimEnd());
      });
    });
    return this.truncate(output);
  }

  /**
   * 把模型给的相对路径解析成绝对路径，并确保它没有跑出工作区。
   *
   * 判断用的是 path.relative 的结果，而不是简单的字符串 startsWith("..")：
   * 后者会把 "..notes.md" 这种合法文件名也误杀，属于典型的路径校验 bug。
   */
  private resolve(requested: string): string {
    const absolute = path.resolve(this.root, requested);
    const relative = path.relative(this.root, absolute);

    // relative 为空 = 就是根目录本身；以 ".." 开头 = 跑到了根目录外面；
    // 返回绝对路径 = 换了盘符（Windows 上 "D:\x" 相对 C:\root 就是这种情况）。
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`path escapes workspace: ${requested}`);
    }
    return absolute;
  }

  /** 超出上限就截断，并明确告诉模型「后面还有，但你看不到了」。 */
  private truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    const hidden = text.length - MAX_OUTPUT_CHARS;
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${hidden} chars]`;
  }
}

/**
 * 把 Workspace 的四个行为翻译成模型能调用的工具。
 *
 * 这个函数是适配器：它真正的内容不是逻辑，而是写给模型看的文案
 * （name / description / JSON Schema）。文案写得含糊，模型就会传错参数 ——
 * 所以它和上面的行为放在同一个文件里：改一个上限，顺手就能改对应的说明。
 */
export function workspaceTools(workspace: Workspace): Tool[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file. Output is truncated to 8000 chars.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the workspace root." } },
        required: ["path"],
      },
      run: async (args) => workspace.read(String(args.path)),
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
      run: async (args) => workspace.write(String(args.path), String(args.content ?? "")),
    },
    {
      name: "list_dir",
      description: "List a directory: entry type, size in bytes, and name.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory relative to the workspace root." } },
        required: ["path"],
      },
      run: async (args) => workspace.list(String(args.path)),
    },
    {
      name: "run_command",
      description: "Run a shell command in the workspace root; returns exit code plus stdout/stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command, executed with the workspace root as cwd." } },
        required: ["command"],
      },
      run: async (args) => workspace.run(String(args.command)),
    },
  ];
}

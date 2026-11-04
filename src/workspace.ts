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
 * 折成 "ERROR: ..." 文本回灌给模型是 ToolRegistry 的事，不是这里的事。
 * 两个模块各管一个决定，改的时候不会互相牵动。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "./types.ts";

/** 单个工具返回给模型的字符上限：防止一条命令刷屏把上下文撑爆。 */
const MAX_OUTPUT_CHARS = 8_000;

/**
 * 一次 read 最多读进多少字节。
 * 8k 字符的内容，UTF-8 下最多也就二十几 KB；留到 32 KB 足以产出完整的截断文本，
 * 又不会把几百 MB 的日志整个读进内存。
 */
const MAX_READ_BYTES = 32_768;

/** grep 跳过超过这个大小的文件：大概率是日志、锁文件或打包产物，读进来只会拖慢。 */
const MAX_GREP_FILE_BYTES = 1_000_000;

/** edit 能接受的文件大小上限：整文件读进来做替换，再大就该走 shell 或拆分处理。 */
const MAX_EDIT_FILE_BYTES = 2_000_000;

/** list 最多 stat / 展示多少个条目：目录可能有一万个，没必要全列。 */
const MAX_LIST_ENTRIES = 500;

/**
 * glob / grep 最多返回多少条命中。
 * 结果再多模型也读不完，只会把上下文挤掉 —— 宁可行数少，也不要「全都有」。
 */
const MAX_RESULTS = 200;

/** grep 单行最多展示多少字符。 */
const MAX_LINE_CHARS = 200;

/** 搜内容时直接跳过的目录：不是代码，搜起来慢，结果全是噪音。 */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * 输出统一用正斜杠（`sub/b.ts` 而不是 `sub\b.ts`）。
 * 模型和用户都习惯 POSIX 风格，跨平台读起来也稳定；回填给 read/edit 同样能解析。
 */
function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

const DEFAULT_TIMEOUT_MS = 120_000;

export interface WorkspaceOptions {
  /** 工作区根目录，必须是绝对路径。文件工具的相对路径都相对它解析 —— 它不是安全边界（见 ADR-0008）。 */
  root: string;
  /** 单条 shell 命令的超时，默认 120 秒。 */
  timeoutMs?: number;
}

/**
 * 一套「最小可用」的编码能力：读、写、改、找文件、搜内容、列目录、跑命令。
 *
 * 刻意只有七个。工具越多，系统提示词越长、模型选错工具的概率越高；
 * 真的需要更多能力时，优先让 shell 工具去组合，而不是继续加方法。
 */
export class Workspace {
  private readonly root: string;

  private readonly timeoutMs: number;

  /** 工作区根目录的真实路径（链接解析后）。懒算一次，之后复用。 */
  private rootReal?: string;

  constructor({ root, timeoutMs = DEFAULT_TIMEOUT_MS }: WorkspaceOptions) {
    this.root = root;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 读一个 UTF-8 文本文件，超过上限就截断。
   *
   * 用有界读取：`readFile` 会把整个文件读进内存，模型一句 `read("big.log")`
   * 就能把进程撑爆。上限必须落在「读进来多少」，而不是「返回多少」。
   */
  async read(requested: string): Promise<string> {
    const file = this.resolve(requested);
    await this.assertInsideWorkspace(file, requested);

    const { text, truncated } = await readTextUpTo(file, MAX_READ_BYTES, Buffer.alloc(MAX_READ_BYTES + 1));
    const cut = truncated ? `\n… [stopped after ${MAX_READ_BYTES} bytes]` : "";
    return this.clip(text, cut);
  }

  /** 创建或覆盖文件，父目录自动补齐。返回一行给模型看的结果摘要。 */
  async write(requested: string, content: string): Promise<string> {
    const file = this.resolve(requested);
    await this.assertInsideWorkspace(file, requested);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return `wrote ${content.length} chars to ${requested}`;
  }

  /**
   * 把文件里唯一命中的一段换成另一段，返回长度变化。
   *
   * 为什么要求「唯一」：模型很爱给一个到处都有的片段（`return`、`}`、空行）。
   * 替换错位置比报错贵得多 —— 报错它读一遍文件就能改；改错了可能十几轮都发现不了。
   *
   * 换行符做一次归一：Windows 上文件常是 CRLF，而模型吐出来的是 LF。
   * 不归一，「看起来一模一样」的片段会找不到；归一之后写入仍沿用文件自己的行尾。
   */
  async edit(requested: string, oldString: string, newString: string): Promise<string> {
    const file = this.resolve(requested);
    await this.assertInsideWorkspace(file, requested);
    if (oldString === "") {
      // 中文对照：old_string 不能是空串。
      throw new Error("old_string must not be empty");
    }

    // 编辑要整文件读进来做替换，所以先划一条上限：
    // 超过它的文件不该走 edit，让模型改用 shell，或者干脆拆开处理。
    const { text: before, truncated } = await readTextUpTo(
      file,
      MAX_EDIT_FILE_BYTES,
      Buffer.alloc(MAX_EDIT_FILE_BYTES + 1),
    );
    if (truncated) {
      // 中文对照：文件超过 {n} 字节，太大，不适合整文件编辑；请改用 shell。
      throw new Error(`file is larger than ${MAX_EDIT_FILE_BYTES} bytes; edit it through shell instead`);
    }

    const toStyle = (text: string) =>
      before.includes("\r\n") ? text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : text.replace(/\r\n/g, "\n");

    const needle = toStyle(oldString);
    // 按 1 个字符推进地数：重叠的命中（比如 "aaa" 里的 "aa"）也要算进来，
    // 否则「唯一命中」的判断会漏掉重叠，替换掉第一个就算成功。
    let occurrences = 0;
    for (let at = before.indexOf(needle); at !== -1; at = before.indexOf(needle, at + 1)) {
      occurrences++;
    }
    if (occurrences === 0) {
      // 中文对照：在 {文件} 里找不到 old_string。
      throw new Error(`old_string not found in ${requested}`);
    }
    if (occurrences > 1) {
      // 中文对照：old_string 在 {文件} 里出现了 {n} 次；把上下文写长一点再试。
      throw new Error(`old_string appears ${occurrences} times in ${requested}; include more surrounding text`);
    }

    const at = before.indexOf(needle);
    const after = before.slice(0, at) + toStyle(newString) + before.slice(at + needle.length);
    await writeFile(file, after, "utf8");
    // 中文对照：已编辑 {文件}（字符数从 {旧} 变成 {新}）。
    return `edited ${requested} (${before.length} → ${after.length} chars)`;
  }

  /** 列目录：类型、字节数、名称，按行排好。 */
  async list(requested: string): Promise<string> {
    const dir = this.resolve(requested);
    await this.assertInsideWorkspace(dir, requested);
    const entries = await readdir(dir, { withFileTypes: true });
    // 目录可能有一万个条目：只 stat 前 MAX_LIST_ENTRIES 个，剩下的明说没列。
    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    const rows = await Promise.all(
      shown.map(async (entry) => {
        const size = entry.isFile() ? (await stat(path.join(dir, entry.name))).size : 0;
        const kind = entry.isDirectory() ? "dir " : "file";
        return `${kind} ${String(size).padStart(8)}  ${entry.name}`;
      }),
    );
    const more = entries.length > shown.length ? `\n… (${entries.length - shown.length} more entries not listed)` : "";
    return this.clip(rows.sort().join("\n") || "(empty directory)", more);
  }

  /**
   * 按模式找文件，返回相对工作区根目录的路径，一行一个，排好序。
   *
   * 做法是「在工作区里走，拿模式去套」，而不是把模式交给 `fs.glob` 去展开。
   * 展开派（`fs.glob`）支持花括号展开（`{../outside,src}` 会变成两条模式）之类的语法，
   * 光靠字符串切分拦不住，能直接跑到工作区外；自己走目录则从结构上走不出去。
   *
   * 代价：支持的语法只有 `*`、`**`、`?`，其余字符（含 `{ } [ ]`）按字面匹配。
   */
  async glob(pattern: string): Promise<string> {
    if (pattern === "") throw new Error("pattern must not be empty");
    if (pattern.split(/[\\/]/).includes("..")) throw new Error(`path escapes workspace: ${pattern}`);
    if (path.isAbsolute(pattern)) throw new Error(`pattern must be relative to the workspace root: ${pattern}`);

    const matcher = globToRegExp(toPosix(pattern));
    const matches: string[] = [];
    for await (const file of walkFiles(this.root)) {
      const relative = toPosix(path.relative(this.root, file));
      if (!matcher.test(relative)) continue;
      matches.push(relative);
      if (matches.length >= MAX_RESULTS) break;
    }

    if (matches.length === 0) return "(no matches)";
    matches.sort();
    const note = matches.length >= MAX_RESULTS ? `\n… (stopped at ${MAX_RESULTS} matches)` : "";
    return this.clip(matches.join("\n"), note);
  }

  /**
   * 在文本文件里按正则搜索，返回「路径:行号: 内容」，最多 MAX_RESULTS 条。
   *
   * 二进制文件（含 NUL 字节）直接跳过：按 UTF-8 读出来只是乱码。
   * 超过 MAX_GREP_FILE_BYTES 的文件不读，并在结果里说明跳过了几个 ——
   * 否则模型会以为「没搜到」等于「不存在」。
   * 读不了的文件（权限、坏链接）也跳过：一次搜索不该被一个文件打断。
   */
  async grep(pattern: string, requested = "."): Promise<string> {
    const start = this.resolve(requested);
    await this.assertInsideWorkspace(start, requested);
    // 写错的正则让它抛出去，由 ToolRegistry 折成给模型看的 ERROR 文本。
    const regex = new RegExp(pattern);

    const hits: Array<{ file: string; line: number; text: string }> = [];
    let skippedLarge = 0;
    let unreadable = 0;
    // 一次 grep 只分配一块上限大小的读缓冲，所有文件复用 —— 不按文件数乘内存。
    const buffer = Buffer.alloc(MAX_GREP_FILE_BYTES + 1);
    for await (const file of walkFiles(start)) {
      if (hits.length >= MAX_RESULTS) break;

      let content: string;
      try {
        // 用句柄读到上限为止：先 stat 再看 readFile 有竞态，真正的上限得落在读了多少字节。
        const read = await readTextUpTo(file, MAX_GREP_FILE_BYTES, buffer);
        if (read.truncated) {
          skippedLarge++;
          continue;
        }
        content = read.text;
      } catch {
        // 读不了也要记账：丢掉这个文件可以，但「结果可能不完整」必须告诉模型。
        unreadable++;
        continue;
      }
      if (content.includes("\u0000")) continue;

      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (!regex.test(lines[index])) continue;
        hits.push({
          file: toPosix(path.relative(this.root, file)),
          line: index + 1,
          text: lines[index].trim().slice(0, MAX_LINE_CHARS),
        });
        if (hits.length >= MAX_RESULTS) break;
      }
    }

    // 部分失败要报告：截断、跳过、读不了一律写进尾注，由 clip 保住。
    const tails =
      (hits.length >= MAX_RESULTS ? `\n… (stopped at ${MAX_RESULTS} matches)` : "") +
      (skippedLarge > 0 ? `\n… (skipped ${skippedLarge} files over 1 MB)` : "") +
      (unreadable > 0 ? `\n… (${unreadable} files could not be read)` : "");

    if (hits.length === 0) return `(no matches)${tails}`;
    // 先按文件、再按行号排：同一份文件里的命中保持阅读顺序。
    hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

    return this.clip(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`).join("\n"), tails);
  }

  /**
   * 在工作区根目录执行一条 shell 命令，返回「exit code + stdout/stderr」。
   *
   * 三个现实问题，逐个处理：
   *   - 命令可能永远不结束 → 超时；而且要杀**整棵进程树**，只杀外层 shell 会留下孤儿；
   *   - 输出可能无限增长 → 只保留前 MAX_OUTPUT_CHARS 个字符，后面的丢弃并记下丢了多少；
   *   - 模型要能区分「失败」和「超时」→ 结果的第一行写清是 exit 还是 timeout。
   */
  async run(command: string): Promise<string> {
    const { status, output, dropped } = await new Promise<{
      status: string;
      output: string;
      dropped: number;
    }>((resolve, reject) => {
      const child = spawn(command, {
        cwd: this.root,
        shell: true,
        windowsHide: true,
        // POSIX 上开新进程组，超时时能整组杀掉；Windows 走 taskkill /T。
        detached: process.platform !== "win32",
      });

      let collected = "";
      let dropped = 0;
      let timedOut = false;

      const absorb = (chunk: Buffer) => {
        collected += chunk.toString();
        if (collected.length > MAX_OUTPUT_CHARS) {
          dropped += collected.length - MAX_OUTPUT_CHARS;
          collected = collected.slice(0, MAX_OUTPUT_CHARS);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.timeoutMs);

      child.stdout.on("data", absorb);
      child.stderr.on("data", absorb);

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          status: timedOut ? `timeout after ${this.timeoutMs}ms` : `exit ${code}`,
          output: collected,
          dropped,
        });
      });
    });

    // 丢弃统计走 tail，不跟正文抢位置：否则「丢了 1000 字符」会被 8000 字符的上限切掉，
    // 模型看到一段完整输出，其实少了一千个字符。
    const tail = dropped > 0 ? `\n… [dropped ${dropped} chars]` : "";
    return this.clip(`${status}\n${output}`, tail);
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
      // 中文对照：路径跑出了工作区：{原始路径}
      throw new Error(`path escapes workspace: ${requested}`);
    }
    return absolute;
  }

  /**
   * 守住「真实路径」：链接（symlink / junction）会让词法上看着在工作区里的路径跑到外面去，
   * 所以每次真正碰文件系统之前，都要把解析后的真实路径再比一次。
   *
   * 目标还不存在时（比如 write 新文件），沿父目录一路往上找第一个存在的路径再比 ——
   * 谁想在链接目录里新建文件，也一样得先过这道关。
   */
  private async assertInsideWorkspace(absolute: string, requested: string): Promise<void> {
    const rootReal = await this.realRoot();

    let probe = absolute;
    let real = "";
    for (;;) {
      try {
        real = await realpath(probe);
        break;
      } catch (error) {
        // 路径确实存在（哪怕是个坏链接）却解析不了：不猜它指向哪，直接拒绝。
        const exists = await lstat(probe).then(
          () => true,
          () => false,
        );
        if (exists) {
          // 中文对照：路径跑出了工作区：{原始路径}
          throw new Error(`path escapes workspace: ${requested}`);
        }
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }

    const relative = path.relative(rootReal, real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      // 中文对照：路径跑出了工作区：{原始路径}
      throw new Error(`path escapes workspace: ${requested}`);
    }
  }

  /** 工作区根目录的真实路径，只算一次。 */
  private async realRoot(): Promise<string> {
    this.rootReal ??= await realpath(this.root);
    return this.rootReal;
  }

  /**
   * 截断正文，但把尾注保住。
   *
   * 先给尾注（丢弃/截断统计、跳过说明、没列出来的条目数）让出位置，再切正文；
   * 否则最容易发生的就是：正文刚好占满 8000 字符，一句「丢了 1000 字符」被自己截掉，
   * 模型看到的是一段完整输出，其实少了一千个字符。
   */
  private clip(body: string, tail = ""): string {
    const room = Math.max(0, MAX_OUTPUT_CHARS - tail.length);
    if (body.length <= room) return body + tail;
    const hidden = body.length - room;
    return `${body.slice(0, room)}\n… [truncated ${hidden} chars]${tail}`;
  }
}

/**
 * 有界读取：最多读 limit 个字节，返回文本和「是否被截断」。
 *
 * 用文件句柄读，而不是 `stat` + `readFile`：`stat` 和 `readFile` 之间文件可能被写大，
 * 真正的上限必须落在「读了多少字节」上。buffer 由调用方传入，方便一次 grep 里反复复用。
 */
async function readTextUpTo(
  file: string,
  limit: number,
  buffer: Buffer,
): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit + 1), 0);
    return {
      text: buffer.subarray(0, Math.min(bytesRead, limit)).toString("utf8"),
      truncated: bytesRead > limit,
    };
  } finally {
    await handle.close();
  }
}

/**
 * 杀掉整棵进程树：Windows 上用 `taskkill /T`，POSIX 上杀进程组。
 * 只杀外层 shell 是不够的 —— Windows 上 `npm test` 这类命令会留下一串孤儿进程。
 *
 * 两条路都可能失败（taskkill 起不来、进程组已经没了），所以都要兜底：
 * 超时那一刻宁可「只杀掉外层 shell」，也不能抛出一个没人接的异常把整个进程带走。
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    // 不监听 'error' 的话，spawn 失败会变成未处理事件；非零退出则说明没杀成。
    // 两种情况都回落到 child.kill()，至少把外层 shell 收掉。
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
    killer.on("close", (code) => {
      if (code !== 0) child.kill();
    });
    return;
  }

  try {
    // detached 起进程组，负号 = 整组。
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * 把 glob 模式翻译成正则（给「自己走目录再匹配」用）。
 *
 * 只认三种通配：`**` 跨目录、`*` 单层内任意、`?` 单个字符；
 * 其余字符一律按字面匹配 —— 特别是 `{ }` 和 `[ ]` 不再有特殊含义，
 * 这正是防止「花括号展开跑到工作区外」的那道结构性保险。
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === "*" && pattern[index + 1] === "*") {
      // `**/` = 任意层目录（可以零层）；裸 `**` = 任意字符。
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * 深度遍历目录，产出文件路径（grep 和 glob 共用）。
 *
 * 跳过 SKIP_DIRS，也跳过符号链接（`isFile` 对链接返回 false）：
 * 链接可能指向工作区之外，顺着它走就等于把路径守卫绕开了。
 */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * 把 Workspace 的七个行为翻译成模型能调用的工具。
 *
 * 这个函数是适配器：它真正的内容不是逻辑，而是写给模型看的文案
 * （name / description / JSON Schema）。文案写得含糊，模型就会传错参数 ——
 * 所以它和上面的行为放在同一个文件里：改一个上限，顺手就能改对应的说明。
 *
 * 工具名刻意用 agent 生态的通用叫法（read / write / edit / glob / grep / ls / shell），而不是代码里的动词。
 * 方法名和工具名不一致是有意的：前者给读代码的人看，后者给模型看，模型对通用叫法有先验。
 * 其中 `shell` 就是 **bash** 那个工具：跑一条命令、拿回 exit code 和输出，和 Codex、
 * Claude Code 里的 bash 是同一件事；名字不叫 bash，是因为实现不绑定具体 shell（见 ADR-0005）。
 *
 * 下面每段英文文案（description / 参数说明）上面都有一行中文对照：
 * 英文是真正发给模型的原文，中文只存在于源码里，不会被发出去。
 */
export function createWorkspaceTools(workspace: Workspace): Tool[] {
  return [
    {
      name: "read",
      // 读一个 UTF-8 文本文件；输出超过 8000 字符会被截断。
      description: "Read a UTF-8 text file. Output is truncated to 8000 chars.",
      parameters: {
        type: "object",
        properties: {
          // 相对工作区根目录的路径。
          path: { type: "string", description: "Path relative to the workspace root." },
        },
        required: ["path"],
      },
      run: async (args) => workspace.read(String(args.path)),
    },
    {
      name: "write",
      // 创建或覆盖整个 UTF-8 文件；父目录会自动建好。只是改已有文件的一部分时，优先用 edit。
      description:
        "Create or overwrite a whole UTF-8 file; parent directories are created. Prefer edit for changing part of an existing file.",
      parameters: {
        type: "object",
        properties: {
          // 相对工作区根目录的路径。
          path: { type: "string", description: "Path relative to the workspace root." },
          // 要写入的完整文件内容。
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
      run: async (args) => workspace.write(String(args.path), String(args.content)),
    },
    {
      name: "edit",
      // 把文件里恰好一处的 old_string 换成 new_string；拿不准就先读文件。
      description:
        "Replace exactly one occurrence of old_string with new_string in an existing file. old_string must appear exactly once; read the file first when unsure.",
      parameters: {
        type: "object",
        properties: {
          // 相对工作区根目录的路径。
          path: { type: "string", description: "Path relative to the workspace root." },
          // 要替换的原文，必须恰好出现一次。
          old_string: { type: "string", description: "Exact text to replace; must appear exactly once." },
          // 替换成什么；空串表示删掉这一段。
          new_string: { type: "string", description: "Replacement text; an empty string deletes the match." },
        },
        required: ["path", "old_string", "new_string"],
      },
      run: async (args) =>
        workspace.edit(String(args.path), String(args.old_string), String(args.new_string)),
    },
    {
      name: "glob",
      // 按模式找文件（支持 *、**、?），返回相对工作区根目录的路径；例如 "src/**/*.ts"。
      description:
        'Find files by glob pattern (supports *, ** and ?) and return their paths relative to the workspace root. Example: "src/**/*.ts".',
      parameters: {
        type: "object",
        properties: {
          // 要匹配的模式；** 可以跨目录。
          pattern: { type: "string", description: 'Glob pattern such as "src/**/*.ts"; ** crosses directories.' },
        },
        required: ["pattern"],
      },
      run: async (args) => workspace.glob(String(args.pattern)),
    },
    {
      name: "grep",
      // 按正则在文件内容里搜索，返回「路径:行号: 内容」。
      description:
        "Search file contents with a JavaScript regular expression; returns one file:line: match line per hit.",
      parameters: {
        type: "object",
        properties: {
          // 要搜索的正则表达式（区分大小写）。
          pattern: { type: "string", description: "Regular expression to search for (case-sensitive)." },
          // 从哪个目录开始搜；默认工作区根目录。
          path: { type: "string", description: "Directory to search, relative to the workspace root. Defaults to the root." },
        },
        required: ["pattern"],
      },
      run: async (args) => workspace.grep(String(args.pattern), String(args.path ?? ".")),
    },
    {
      name: "ls",
      // 列目录：每一项的类型、字节数和名字。
      description: "List a directory: entry type, size in bytes, and name.",
      parameters: {
        type: "object",
        properties: {
          // 相对工作区根目录的目录。
          path: { type: "string", description: "Directory relative to the workspace root." },
        },
        required: ["path"],
      },
      run: async (args) => workspace.list(String(args.path)),
    },
    {
      name: "shell",
      // 在工作区根目录跑一条 shell 命令；返回 exit code 和 stdout/stderr。
      description: "Run a shell command in the workspace root; returns exit code plus stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          // 要执行的命令；工作区根目录就是它的 cwd。
          command: { type: "string", description: "Shell command, executed with the workspace root as cwd." },
        },
        required: ["command"],
      },
      run: async (args) => workspace.run(String(args.command)),
    },
  ];
}

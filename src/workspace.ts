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
import type { Dir } from "node:fs";
import { lstat, mkdir, opendir, open, realpath, stat, writeFile } from "node:fs/promises";
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

/** 单行被截断时追加的标记：不标出来，模型会以为那就是整行。 */
const LINE_TRUNCATED = " …[line truncated]";

/**
 * 一次 glob / grep / list 最多访问多少个目录项（文件和目录都算）。
 *
 * 限制「返回多少条」不等于限制「扫了多少东西」：在小仓库里搜一个不存在的字符串，
 * 一样会走完整棵树。大仓库里这条预算保证搜索会在有限步内停手，并明确告诉模型结果不完整。
 * 目录用 opendir 边读边走，所以这条预算是真的「读了多少项」，而不是「readdir 之后切了多少项」。
 */
const MAX_SCAN_ENTRIES = 20_000;

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
  /** 单次 glob / grep / list 的扫描预算（目录项个数），默认 20000。测试会传一个小值。 */
  scanLimit?: number;
  /**
   * 取消信号。CLI 收到 SIGINT / SIGTERM 时 abort 它，正在跑的 shell 会连同进程树一起被收掉。
   *
   * 直接传一个 signal、不新造 CancellationManager：这条链上只有「发起取消」和「响应取消」两件事，
   * 多一层管理器只会多一个需要同步的地方。
   */
  signal?: AbortSignal;
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

  private readonly scanLimit: number;

  /** 当前任务的取消信号；没有就表示不可取消（测试和库调用常见）。 */
  private readonly signal?: AbortSignal;

  /** 工作区根目录的真实路径（链接解析后）。懒算一次，之后复用。 */
  private rootReal?: string;

  constructor({ root, timeoutMs = DEFAULT_TIMEOUT_MS, scanLimit = MAX_SCAN_ENTRIES, signal }: WorkspaceOptions) {
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.scanLimit = scanLimit;
    this.signal = signal;
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

  /**
   * 列目录：类型、字节数、名称，按行排好。
   *
   * 用 `opendir` 边读边收，而不是 `readdir` 一次把整个目录读进内存再切：
   * 一个十万条目的目录，`readdir` 会先分配十万个 Dirent，再让我们丢掉九万九千个 ——
   * 上限形同虚设。现在最多只读 `scanLimit` 项、最多展示 `MAX_LIST_ENTRIES` 条。
   *
   * 扫描提前停手时必须在结果里说明「目录可能没列全」：只给 500 行而不说还有，
   * 模型会把「没列出来」当成「不存在」。
   */
  async list(requested: string): Promise<string> {
    const dir = this.resolve(requested);
    await this.assertInsideWorkspace(dir, requested);

    const entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }> = [];
    let scanned = 0;
    let scanStopped = false;
    const handle = await opendir(dir);
    try {
      for await (const entry of handle) {
        if (scanned >= this.scanLimit) {
          scanStopped = true;
          break;
        }
        scanned++;
        entries.push({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() });
      }
    } finally {
      // 提前 break 时 for await 不保证已经关掉句柄；重复关闭由 closeDir 容忍。
      await closeDir(handle);
    }

    // 先稳定排序，再截断：目录枚举顺序由文件系统决定，直接切前 500 条
    // 会让同一次 ls 在不同机器上给出不同的集合。目录排在文件前面，组内按名字排。
    // 只 stat 真正要展示的那些，而不是扫到多少 stat 多少。
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    const rows = await Promise.all(
      entries.slice(0, MAX_LIST_ENTRIES).map(async (entry) => {
        const size = entry.isFile ? (await stat(path.join(dir, entry.name))).size : 0;
        const kind = entry.isDirectory ? "dir " : "file";
        return `${kind} ${String(size).padStart(8)}  ${entry.name}`;
      }),
    );

    const hidden = entries.length - MAX_LIST_ENTRIES;
    const tails =
      (hidden > 0 ? `\n… (${scanStopped ? "at least " : ""}${hidden} more entries not listed)` : "") +
      (scanStopped ? `\n… (scan stopped after ${this.scanLimit} entries; listing may be incomplete)` : "");
    return this.clip(rows.join("\n") || "(empty directory)", tails);
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
    const budget = { remaining: this.scanLimit };
    const matches: string[] = [];
    let hitLimit = false;
    for await (const file of walkFiles(this.root, budget)) {
      const relative = toPosix(path.relative(this.root, file));
      if (!matcher.test(relative)) continue;
      // 第 MAX_RESULTS+1 条命中只用来判断「还有更多」，不塞进结果。
      if (matches.length === MAX_RESULTS) {
        hitLimit = true;
        break;
      }
      matches.push(relative);
    }

    // 排序的是「已收集到的」命中；提前停手时它只是局部顺序，不代表整棵树的全局顺序 ——
    // 尾注必须把这一点说清楚，不能让模型以为这就是全部。
    matches.sort();
    const tails =
      (hitLimit ? `\n… (stopped at ${MAX_RESULTS} matches)` : "") + scanTail(budget, this.scanLimit);
    if (matches.length === 0) return `(no matches)${tails}`;
    return this.clip(matches.join("\n"), tails);
  }

  /**
   * 在文本文件里按**字面字符串**搜索，返回「路径:行号: 内容」，最多 MAX_RESULTS 条。
   *
   * 为什么是字面而不是正则：模型给的正则可能带灾难性回溯（`(a+)+$`），而匹配跑在主线程上，
   * 一条这样的模式就能把整个 agent 挂住 —— 没有 worker、没有超时，只能等用户 Ctrl-C。
   * 第一阶段先把它降级成字面搜索：失去正则能力，换来不可能被输入卡死。
   * 要恢复正则，得先把匹配放进 worker 并带上可中断的超时，而不是只把 `new RegExp` 加回来。
   *
   * 二进制文件（含 NUL 字节）直接跳过：按 UTF-8 读出来只是乱码。
   * 超过 MAX_GREP_FILE_BYTES 的文件不读，并在结果里说明跳过了几个 ——
   * 否则模型会以为「没搜到」等于「不存在」。
   * 读不了的文件（权限、坏链接）也跳过：一次搜索不该被一个文件打断。
   */
  async grep(text: string, requested = "."): Promise<string> {
    if (text === "") {
      // 空串是每行的子串：放过去会让「搜一下」变成「列全部内容」。
      throw new Error("search text must not be empty");
    }
    const start = this.resolve(requested);
    await this.assertInsideWorkspace(start, requested);

    const hits: Array<{ file: string; line: number; text: string }> = [];
    let skippedLarge = 0;
    let unreadable = 0;
    // 一次 grep 只分配一块上限大小的读缓冲，所有文件复用 —— 不按文件数乘内存。
    const buffer = Buffer.alloc(MAX_GREP_FILE_BYTES + 1);
    const budget = { remaining: this.scanLimit };
    for await (const file of walkFiles(start, budget)) {
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
        if (!lines[index].includes(text)) continue;
        const line = lines[index].trim();
        hits.push({
          file: toPosix(path.relative(this.root, file)),
          line: index + 1,
          // 超长行必须留下截断标记：悄悄切到 200 字，模型会以为那一行就到此为止。
          text: line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}${LINE_TRUNCATED}` : line,
        });
        if (hits.length >= MAX_RESULTS) break;
      }
    }

    // 部分失败要报告：截断、跳过、读不了、扫描预算用尽，一律写进尾注，由 clip 保住。
    const tails =
      (hits.length >= MAX_RESULTS ? `\n… (stopped at ${MAX_RESULTS} matches)` : "") +
      (skippedLarge > 0 ? `\n… (skipped ${skippedLarge} files over 1 MB)` : "") +
      (unreadable > 0 ? `\n… (${unreadable} files could not be read)` : "") +
      scanTail(budget, this.scanLimit);

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
   *   - 模型要能区分「失败」「超时」「被取消」→ 结果的第一行写清是哪一种。
   *
   * 超时和取消走**同一条清理路径**（stop → terminateTree）。两条路径各写一份杀进程的代码，
   * 迟早会有一条漏掉进程树；共用之后，「为什么停」只影响状态文案，不影响怎么收尾。
   */
  async run(command: string): Promise<string> {
    const signal = this.signal;
    if (signal?.aborted) {
      // 取消之后不再启动新进程：这是「不能在取消后继续启动新工具」的最后一道闸门。
      throw new Error("cancelled before the command started");
    }

    const { status, output, dropped } = await new Promise<{
      status: string;
      output: string;
      dropped: number;
    }>((resolve, reject) => {
      const child = spawn(command, {
        cwd: this.root,
        shell: true,
        windowsHide: true,
        // POSIX 上开新进程组，超时/取消时能整组杀掉；Windows 走 taskkill /T。
        detached: process.platform !== "win32",
      });

      let collected = "";
      let dropped = 0;
      // 第一次「为什么停」获胜：超时和取消同时发生时，不能把状态改来改去。
      let stopped: string | undefined;
      let cleanup: Promise<void> | undefined;
      let settled = false;

      const absorb = (chunk: Buffer) => {
        collected += chunk.toString();
        if (collected.length > MAX_OUTPUT_CHARS) {
          dropped += collected.length - MAX_OUTPUT_CHARS;
          collected = collected.slice(0, MAX_OUTPUT_CHARS);
        }
      };

      const stop = (reason: string) => {
        // 进程已经收尾之后不再补一刀：Windows 上 PID 可能已经被复用。
        if (settled || stopped !== undefined) return;
        stopped = reason;
        cleanup = terminateTree(child);
      };

      const timer = setTimeout(() => stop(`timeout after ${this.timeoutMs}ms`), this.timeoutMs);
      const onAbort = () => stop("cancelled by signal");
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      child.stdout.on("data", absorb);
      child.stderr.on("data", absorb);

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        finish();
        // 等进程树真的被杀掉再返回：先 resolve 的话，调用方会以为任务结束了，
        // 而孙进程可能还在写文件 —— 那不叫「取消成功」。
        void (cleanup ?? Promise.resolve()).then(() =>
          resolve({
            status: stopped ?? `exit ${code}`,
            output: collected,
            dropped,
          }),
        );
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
 *
 * **必须循环读**：一次 `handle.read()` 允许只返回一部分字节（POSIX 的 read 本来就是这个语义，
 * 网络盘、被信号打断的读都会这样）。只读一次就当成整个文件，会让 `read` 悄悄少一段内容，
 * 更糟的是让 `edit` 拿着半截内容去覆盖 —— 文件尾部直接丢失。循环到 EOF 或读满 limit+1 字节为止，
 * 「没截断」就必然意味着「读到了 EOF」。
 */
async function readTextUpTo(
  file: string,
  limit: number,
  buffer: Buffer,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  const handle = await open(file, "r");
  try {
    const bytesRead = await fillBuffer(
      (target, offset, length, position) => handle.read(target, offset, length, position),
      buffer,
    );
    const truncated = bytesRead > limit;
    // 截断点可能正好切在一个多字节字符中间：stream 模式把不完整的那截留在解码器里，
    // 不吐一个 U+FFFD 出来冒充「文件里真的有这个字符」。
    const text = new TextDecoder("utf-8").decode(buffer.subarray(0, Math.min(bytesRead, limit)), {
      stream: truncated,
    });
    return { text, truncated, bytesRead };
  } finally {
    await handle.close();
  }
}

/**
 * 把 buffer 尽量读满，返回读到的字节数；只有遇到 EOF 或 buffer 满了才停。
 *
 * 单独抽出来是为了能被测试确定性地喂「半截读」—— 普通文件在本地磁盘上很少真的半截返回，
 * 而这段循环的全部价值恰恰在于处理那种情况。`read` 参数就是 `FileHandle.read` 的四个参数，
 * 返回 `{ bytesRead }`，和生产代码里的调用形状一致。
 */
export async function fillBuffer(
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>,
  buffer: Buffer,
): Promise<number> {
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const { bytesRead: justRead } = await read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    // 0 = EOF。不判它的话，循环会在文件末尾空转。
    if (justRead === 0) break;
    bytesRead += justRead;
  }
  return bytesRead;
}

/**
 * 杀掉整棵进程树，并在**确实清理完之后**才 resolve：Windows 上用 `taskkill /T`，POSIX 上杀进程组。
 * 只杀外层 shell 是不够的 —— Windows 上 `npm test` 这类命令会留下一串孤儿进程。
 *
 * 两条路都可能失败（taskkill 起不来、进程组已经没了），所以都要兜底：
 * 停下来的那一刻宁可「只杀掉外层 shell」，也不能抛出一个没人接的异常把整个进程带走。
 * 返回 Promise 而不是 void，是因为调用方必须等它 —— 先 resolve 再清理，等于假取消。
 */
function terminateTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      // 不监听 'error' 的话，spawn 失败会变成未处理事件；非零退出则说明没杀成。
      // 两种情况都回落到 child.kill()，至少把外层 shell 收掉。
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        child.kill();
        resolve();
      });
      killer.on("close", (code) => {
        if (code !== 0) child.kill();
        resolve();
      });
    });
  }

  try {
    // detached 起进程组，负号 = 整组。
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return Promise.resolve();
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
 * 深度遍历目录，产出文件路径（grep、glob 共用；list 走自己的 opendir 预算循环）。
 *
 * 用 `opendir` 逐项异步迭代，而不是 `readdir` 一次性把整层目录读进数组：
 * 预算要限制的是「真的读了多少目录项」，而 readdir 在预算生效之前就已经把目录读完了。
 *
 * 跳过 SKIP_DIRS，也跳过符号链接（`isFile` 对链接返回 false）：
 * 链接可能指向工作区之外，顺着它走就等于把路径守卫绕开了。
 *
 * budget 是调用方给的扫描预算：每访问一个目录项就减一，减到 0 立刻收手。
 * 预算耗尽时调用方用 scanTail() 告诉模型「结果不完整」。
 */
async function* walkFiles(dir: string, budget: { remaining: number }): AsyncGenerator<string> {
  if (budget.remaining <= 0) return;

  // 子目录递归时父目录还开着：深度通常只有个位数，换来的是一路都不需要先列目录。
  const handle = await opendir(dir);
  try {
    for await (const entry of handle) {
      if (budget.remaining <= 0) return;
      budget.remaining--;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        yield* walkFiles(full, budget);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  } finally {
    await closeDir(handle);
  }
}

/**
 * 关闭目录句柄，只容忍「已经关闭」这一种情况。
 *
 * `for await` 正常结束或提前 break 时，Node 会自动关闭 Dir；随后再 close() 会抛
 * `ERR_DIR_CLOSED`。这是可预期的重复关闭，不是资源泄漏 —— 但其他关闭错误照常抛出，
 * 不能被一句 catch 无声吞掉。
 */
async function closeDir(handle: Dir): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
  }
}

/** 扫描预算用尽时的尾注；说清楚「结果可能不完整」，别让模型以为已经搜遍全仓。 */
function scanTail(budget: { remaining: number }, limit: number): string {
  return budget.remaining <= 0 ? `\n… (scan stopped after ${limit} entries; results may be incomplete)` : "";
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
      // 按字面文本在文件内容里搜索，返回「路径:行号: 内容」；不是正则。
      description:
        "Search file contents for a literal string (not a regular expression); returns one file:line: match line per hit.",
      parameters: {
        type: "object",
        properties: {
          // 要搜索的字面文本（区分大小写）；按普通字符串匹配，不做正则解释。
          text: { type: "string", description: "Literal text to search for (case-sensitive; not a regular expression)." },
          // 从哪个目录开始搜；默认工作区根目录。
          path: { type: "string", description: "Directory to search, relative to the workspace root. Defaults to the root." },
        },
        required: ["text"],
      },
      run: async (args) => workspace.grep(String(args.text), String(args.path ?? ".")),
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

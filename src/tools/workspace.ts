/**
 * 文件目的：程序碰真实文件、跑真实命令的唯一入口。
 *
 * 它替调用方挡掉三件容易出事的事：
 *   1. 路径要算准。相对路径从工作区根目录算起，`..` 可以走出去，链接要解析到真实位置。
 *      这里不设边界 —— 能碰什么，由启动程序的那个操作系统账户决定（见 ADR-0019）。
 *   2. 输出要有上限。一条命令刷屏几万行，就能把给模型看的内容撑爆。
 *   3. 命令要有超时。命令可能永远不结束，比如起了个一直跑的服务。
 *
 * 文件职责：负责文件读写改、列目录、glob、grep、跑命令（前后台）、进程树清理。
 * 不负责把异常变成文本 —— 它出错就抛；折成 `ERROR:` 交给模型是 `core/tool-registry.ts` 的事。
 * 两边各管一段，改的时候不会互相牵动。
 *
 * 内容目录：
 *   - `Workspace`：九个方法 `read` / `write` / `edit` / `list` / `glob` / `grep` /
 *     `run` / `readJobOutput` / `killJob`；内部有原子替换、路径解析、输出截断、进程树清理。
 *   - `createWorkspaceTools()`：把上面这些方法翻译成模型能调用的九个工具（含英文说明书）。
 *   - `WorkspaceOptions` / `GrepOptions` / `BackgroundJob`：构造参数、grep 选项、后台任务登记。
 *   - `RegexGrep`：grep 的正则匹配线程客户端，超时或取消就 terminate。
 *   - 导出的小工具：`fillBuffer()` 读满缓冲区、`terminateTree()` 收进程树。
 *   - 常量区：各类上限（读、输出、扫描、行宽、结果数）、超时、后台任务日志目录与轮询间隔。
 *
 * 模块关系：只依赖 `protocol/types.ts`（`Tool`）与 `protocol/errors.ts`（`ProcessCleanupError`），
 * 外加 Node 内置的 fs / child_process / worker_threads / string_decoder。
 * 由 `cli.ts` 创建、`core/tool-registry.ts` 通过工具间接调用；
 * `grep-worker.ts` 是它的副线程，两边用消息协议配合。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import type { Dir, Stats } from "node:fs";
import { lstat, mkdir, opendir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import type { Tool } from "../protocol/types.ts";
import { ProcessCleanupError } from "../protocol/errors.ts";

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

/**
 * 一次 grep 花在正则匹配上的时间预算（毫秒）。
 *
 * 只统计 worker 里的匹配时间，不含读文件 —— 慢磁盘不该吃掉正则的预算。
 * 超时意味着模型给了一条会指数级回溯的模式：停手、保留已有命中、明确说结果不完整，
 * 而不是让整个 agent 陪它一起卡住。
 */
const REGEX_BUDGET_MS = 2_000;

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

/**
 * `candidate` 是否在 `base` 之外。
 *
 * 用 path.relative 判断，而不是字符串 startsWith：后者会把 `..notes` 这种合法名字误判。
 * 返回绝对路径（Windows 换了盘符）同样算在外面。
 */
function escapes(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * 把绝对 glob 模式拆成「不含通配符的静态目录」+「相对模式」。
 *
 * 没有通配符时，整条路径就是文件名：搜索它的父目录并精确匹配名字。
 * Windows 的 `D:/**` 只拆出盘符时补一个斜杠，避免 `path.resolve("D:")`
 * 被解释成「D 盘当前目录」。
 */
function splitAbsoluteGlob(pattern: string): { base: string; relative: string } {
  const segments = toPosix(pattern).split("/");
  let index = 0;
  while (index < segments.length && !/[*?]/.test(segments[index]!)) index++;
  const relative = segments.slice(index).join("/");
  if (relative === "") return { base: path.dirname(pattern), relative: path.basename(pattern) };

  const head = segments.slice(0, index).join("/");
  const base = head === "" ? path.parse(pattern).root : /^[A-Za-z]:$/.test(head) ? `${head}/` : head;
  return { base, relative };
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Windows taskkill 卡住时不能让单条 Shell 进入无限等待；超时之后只能报告清理未确认。 */
const TASKKILL_TIMEOUT_MS = 2_000;
/** 即使 taskkill 声称成功，后代进程持有管道时 close 也可能迟迟不来。 */
const PROCESS_CLOSE_TIMEOUT_MS = 4_000;

/**
 * 后台任务的日志落在系统临时目录，不落在工作区。
 *
 * 放工作区会污染用户的仓库（还得进 .gitignore），而这些日志是运行期产物、
 * 生命周期跟着进程走，跟项目源码没有任何关系。代价是模型不能再用 `read` 直接看，
 * 必须走 `shell-output` —— 这正是它存在的理由。
 */
const JOB_LOG_DIR = path.join(tmpdir(), "agent-kernel-jobs");

/** 单次 shell-output 最多返回多少字符，与 shell 前台保持同一个上限。 */
const MAX_JOB_OUTPUT_CHARS = 8_000;

/** 单次 shell-output 最多从日志读进多少字节；日志可能是几百 MB。 */
const MAX_JOB_READ_BYTES = 32_768;

/**
 * 等新输出只能靠轮询：日志是普通文件，没有可订阅的事件。
 * 50 毫秒对「等一条日志」够快，又不会把 CPU 拉满。
 */
const JOB_POLL_MS = 50;

/** shell-output 一次最多等多久；模型要等更久应该分多次调用，而不是卡住一个 Step。 */
const MAX_JOB_WAIT_MS = 60_000;

/**
 * POSIX 的 O_NOFOLLOW 防止校验后最后一段路径被换成符号链接。
 * Windows 不支持此 open 标志，因此依赖真实路径与再次校验。
 * 已知边界：恶意并发替换父目录仍需要 OS 级隔离或 dirfd/openat 系列 API 才能彻底封闭。
 */
const NO_FOLLOW_FILE = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

export interface WorkspaceOptions {
  /**
   * 工作区根目录，必须是绝对路径。相对路径以它为基准解析 ——
   * 它是「默认位置」，不是访问边界（见 ADR-0008 / ADR-0019）。
   */
  root: string;
  /** 单条 shell 命令的超时，默认 120 秒。 */
  timeoutMs?: number;
  /** 单次 glob / grep / list 的扫描预算（目录项个数），默认 20000。测试会传一个小值。 */
  scanLimit?: number;
  /** 单次 grep 花在正则匹配上的时间预算，默认 2000 毫秒。测试会传一个很小的值。 */
  regexBudgetMs?: number;
  /**
   * 取消信号。CLI 收到 SIGINT / SIGTERM 时 abort 它，正在跑的 shell 会连同进程树一起被收掉。
   *
   * 直接传一个 signal、不新造 CancellationManager：这条链上只有「发起取消」和「响应取消」两件事，
   * 多一层管理器只会多一个需要同步的地方。
   */
  signal?: AbortSignal;
  /** 仅供 TUI 展示真实已提交的编辑差异；观察者故障不能改变文件提交结果。 */
  onEditCommitted?: (requested: string, before: string, after: string) => void;
  /** 成功新建或覆盖 UTF-8 文件后，把真实文件差异交给可选展示观察者。 */
  onWriteCommitted?: (requested: string, before: string | undefined, after: string | undefined, created: boolean) => void;
  /** 真实 read 获准后才向 TUI 提供有界图片字节；不影响模型收到的文本结果。 */
  onImageRead?: (requested: string, bytes: Buffer) => void;
}

/** grep 的可选参数：默认按正则、区分大小写；只有模型明确要求时才切到字面模式。 */
export interface GrepOptions {
  /** 正则标志，只接受 i / m / s / u；g 和 y 会被忽略。 */
  flags?: string;
  /** true 时把 pattern 当字面字符串，不解释正则元字符。 */
  fixed?: boolean;
}

/**
 * 一个后台任务：进程本身、它的日志文件、以及「已经交给模型多少字节」。
 *
 * cursor 是增量的关键：模型第二次调 shell-output 时只该看到新长出来的部分，
 * 而不是把整段日志再读一遍 —— 重复内容既烧 token，又让模型误判「这条错误又出现了」。
 */
interface BackgroundJob {
  id: string;
  command: string;
  pid: number | undefined;
  child: ChildProcess;
  logPath: string;
  /** 已返回给模型的字节偏移。 */
  cursor: number;
  status: "running" | "exited" | "killed" | "unverified";
  exitCode: number | null;
  error?: string;
}

/**
 * 返回 buf 里「完整 UTF-8 字符」占的字节数。
 *
 * 日志按字节偏移切着读，切口会正好落在汉字的三个字节中间。
 * 直接 toString 会把它变成一个替换字符，下一次又从中间接着读 —— 一个字坏两次。
 * 所以末尾被切断的那截不消费，留给下一次。
 */
function completeUtf8Prefix(buf: Buffer): number {
  // UTF-8 一个字符最多 4 字节，所以最多回退 3 个字节就能找到起始字节。
  for (let back = 0; back < 4; back++) {
    const index = buf.length - 1 - back;
    if (index < 0) break;
    const byte = buf[index]!;
    // 10xxxxxx 是续字节，继续往前找。
    if ((byte & 0b1100_0000) === 0b1000_0000) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return index + need <= buf.length ? buf.length : index;
  }
  return buf.length;
}

/**
 * 一套「最小可用」的编码能力：读、写、改、找文件、搜内容、列目录、跑命令。
 *
 * 前台能力刻意只有七个。工具越多，系统提示词越长、模型选错工具的概率越高；
 * 真的需要更多能力时，优先让 shell 工具去组合，而不是继续加方法。
 *
 * 后台的两个工具（`shell-output` / `shell-kill`）不算扩张能力面：
 * 它们是 `shell` 那半个功能的收尾。只起不停，等于让模型亲手拼 `taskkill /PID x /T /F`，
 * 在 POSIX 上还得自己算进程组负号 —— 这是把内核该干的活推给了模型。
 */
export class Workspace {
  private readonly root: string;

  private readonly timeoutMs: number;

  private readonly scanLimit: number;

  private readonly regexBudgetMs: number;

  /** 当前任务的取消信号；没有就表示不可取消（测试和库调用常见）。 */
  private readonly signal?: AbortSignal;

  private readonly onEditCommitted?: (requested: string, before: string, after: string) => void;

  private readonly onWriteCommitted?: (requested: string, before: string | undefined, after: string | undefined, created: boolean) => void;

  private readonly onImageRead?: (requested: string, bytes: Buffer) => void;

  /** 展示观察者故障计数；失败已记录但不改变成功提交的工具语义。 */
  private editObserverFailures = 0;

  get editObserverFailureCount(): number { return this.editObserverFailures; }

  /**
   * 这个工作区起过的后台任务，按 id 索引。
   *
   * 跟着 Workspace 走而不是跟 WorkspaceOptions 走：任务的生命周期就是工作区的生命周期，
   * 换一个工作区就不该还能杀上一个工作区起的进程。
   */
  private readonly jobs = new Map<string, BackgroundJob>();

  /** 后台任务编号只增不减，同一会话里 `job-3` 永远指同一个进程。 */
  private jobSeq = 0;

  /** 工作区根目录的真实路径（链接解析后）。懒算一次，之后复用。 */
  private rootReal?: string;

  constructor({
    root,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    scanLimit = MAX_SCAN_ENTRIES,
    regexBudgetMs = REGEX_BUDGET_MS,
    signal,
    onEditCommitted,
    onWriteCommitted,
    onImageRead,
  }: WorkspaceOptions) {
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.scanLimit = scanLimit;
    this.regexBudgetMs = regexBudgetMs;
    this.signal = signal;
    this.onEditCommitted = onEditCommitted;
    this.onWriteCommitted = onWriteCommitted;
    this.onImageRead = onImageRead;
  }

  /**
   * 工作区方法 read（读文件）：把一个文本文件的内容读出来，超过上限就截断。
   *
   * 用有界读取：`readFile` 会把整个文件读进内存，模型一句 `read("big.log")`
   * 就能把进程撑爆。上限必须落在「读进来多少」，而不是「返回多少」。
   */
  async read(requested: string): Promise<string> {
    const file = await this.resolveReal(this.resolve(requested), requested);

    const { text, truncated } = await readTextUpTo(file, MAX_READ_BYTES, Buffer.alloc(MAX_READ_BYTES + 1));
    const cut = truncated ? `\n… [stopped after ${MAX_READ_BYTES} bytes]` : "";
    // 仅真实获准的 read 才允许提取图片字节，不以 UI 的路径猜测绕过 ToolRegistry。
    // 已知边界：预览仅为本地终端展示，模型仍收到原有文字工具结果。
    if (this.onImageRead !== undefined && /\.(png|jpe?g|gif|webp)$/i.test(requested)) {
      try {
        const image = await open(file, constants.O_RDONLY | NO_FOLLOW_FILE);
        try {
          const size = (await image.stat()).size;
          if (size >= 12 && size <= 4_000_000) {
            const data = Buffer.alloc(size);
            let offset = 0;
            while (offset < size) {
              const { bytesRead } = await image.read(data, offset, size - offset, offset);
              if (bytesRead === 0) break;
              offset += bytesRead;
            }
            if (offset === size) this.onImageRead(requested, data);
          }
        } finally { await image.close(); }
      } catch {
        this.editObserverFailures++;
      }
    }
    return this.clip(text, cut);
  }

  /**
   * 临时文件写完并 fsync 后才 rename：写入中断不能先把旧文件 truncate(0)。
   * 保存原权限并在提交前检查目标身份，尽量拒绝同一文件被外部进程修改后覆盖。
   * 已知边界：父目录并发替换仍有 TOCTOU；rename 覆盖会更换 inode / hardlink，
   * Windows ACL / 持有句柄的语义也可能不同。这不是沙箱或完整事务。
   */
  private async replaceFileAtomically(
    target: string,
    requested: string,
    content: string,
    original?: Stats,
  ): Promise<void> {
    const temporary = path.join(path.dirname(target), `.agent-kernel-${randomUUID()}.tmp`);
    this.stopIfCancelledBeforeWrite();
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, original?.mode ?? 0o666);
    try {
      try {
        await handle.writeFile(content, "utf8");
        if (original !== undefined) await handle.chmod(original.mode & 0o7777);
        await handle.sync();
      } finally {
        await handle.close();
      }

      // 临时写入可能经过多轮异步 I/O；在提交点前再次复查路径、并发修改和取消。
      const current = await this.resolveReal(target, requested);
      if (current !== target) throw new Error(`file target changed before commit: ${requested}`);
      if (original !== undefined) {
        const latest = await lstat(target);
        if (!latest.isFile() || latest.dev !== original.dev || latest.ino !== original.ino ||
            latest.size !== original.size || latest.mtimeMs !== original.mtimeMs) {
          throw new Error(`file changed before commit: ${requested}`);
        }
      }
      this.stopIfCancelledBeforeWrite();
      await rename(temporary, target);
    } finally {
      // 出错时只清理自己的临时文件，绝不能回滚删除原文件。
      try {
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  /** 工作区方法 write（写文件）：新建一个文件，或者整个覆盖；父目录自动补齐，写入失败时保留原有内容。 */
  async write(requested: string, content: string): Promise<string> {
    const file = await this.resolveReal(this.resolve(requested), requested);
    this.stopIfCancelledBeforeWrite();
    await mkdir(path.dirname(file), { recursive: true });
    const target = await this.resolveReal(file, requested);
    this.stopIfCancelledBeforeWrite();

    // 既有文件先检查可写权限，但不截断；Windows/Unix 的普通权限拒绝仍保持原语义。
    let original: Stats | undefined;
    try {
      const existing = await open(target, constants.O_WRONLY | NO_FOLLOW_FILE);
      try {
        original = await existing.stat();
      } finally {
        await existing.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // 回显真实的旧文本必须发生在原子覆盖之前；读取不到时只放弃 UI Diff，不阻止 write。
    const withinPreviewLimit = Buffer.byteLength(content) <= MAX_EDIT_FILE_BYTES;
    let beforeForDiff: string | undefined = original === undefined ? "" : undefined;
    if (this.onWriteCommitted !== undefined && original !== undefined &&
        original.size <= MAX_EDIT_FILE_BYTES && withinPreviewLimit) {
      try {
        const handle = await open(target, constants.O_RDONLY | NO_FOLLOW_FILE);
        try {
          const read = await readTextUpToHandle(handle, MAX_EDIT_FILE_BYTES,
            Buffer.alloc(MAX_EDIT_FILE_BYTES + 1), { preserveBom: true });
          if (!read.truncated) beforeForDiff = read.text;
        } finally { await handle.close(); }
      } catch { this.editObserverFailures++; }
    }
    await this.replaceFileAtomically(target, requested, content, original);
    // 写入成功时始终通知展示层；快照过大/不可读取用 undefined 明确标示，
    // 而不是静默丢失 Diff。此回调仍为旁路，不影响真实写入结果。
    try {
      this.onWriteCommitted?.(requested, beforeForDiff,
        withinPreviewLimit ? content : undefined, original === undefined);
    } catch { this.editObserverFailures++; }
    return `wrote ${content.length} chars to ${requested}`;
  }

  /**
   * 工作区方法 edit（改文件）：把文件里唯一出现的那段原文换成新内容。
   *
   * 用同目录临时文件替换：写到一半崩了也不会留下半截文件；保留 BOM / CRLF 和旧文件权限。
   * 编辑仍先用单一文件句柄读取、校验并记录身份；然后关闭句柄，便于 Windows rename。
   * 已知边界：提交前身份复查减少并发覆盖，但不能消除复查与 rename 之间的竞态。
   */
  async edit(requested: string, oldString: string, newString: string): Promise<string> {
    const file = await this.resolveReal(this.resolve(requested), requested);
    if (oldString === "") {
      // 中文对照：old_string 不能是空串。
      throw new Error("old_string must not be empty");
    }

    const handle = await open(file, constants.O_RDWR | NO_FOLLOW_FILE);
    let before: string;
    let after: string;
    let original: Stats;
    try {
      original = await handle.stat();
      const read = await readTextUpToHandle(
        handle,
        MAX_EDIT_FILE_BYTES,
        Buffer.alloc(MAX_EDIT_FILE_BYTES + 1),
        { preserveBom: true },
      );
      before = read.text;
      if (read.truncated) {
        throw new Error(`file is larger than ${MAX_EDIT_FILE_BYTES} bytes; edit it through shell instead`);
      }

      const toStyle = (text: string) =>
        before.includes("\r\n") ? text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : text.replace(/\r\n/g, "\n");

      const needle = toStyle(oldString);
      let occurrences = 0;
      for (let at = before.indexOf(needle); at !== -1; at = before.indexOf(needle, at + 1)) {
        occurrences++;
      }
      if (occurrences === 0) throw new Error(`old_string not found in ${requested}`);
      if (occurrences > 1) {
        throw new Error(`old_string appears ${occurrences} times in ${requested}; include more surrounding text`);
      }

      const at = before.indexOf(needle);
      after = before.slice(0, at) + toStyle(newString) + before.slice(at + needle.length);
    } finally {
      await handle.close();
    }

    await this.replaceFileAtomically(file, requested, after, original);
    // 只有写入成功提交才通知 UI。观察者错误不回滚真实 edit，也不改工具返回。
    try { this.onEditCommitted?.(requested, before, after); } catch { this.editObserverFailures++; }
    // 中文对照：已编辑 {文件}（字符数从 {旧} 变成 {新}）。
    return `edited ${requested} (${before.length} → ${after.length} chars)`;
  }
  /**
   * 工作区方法 list（列目录）：看看一个目录里有什么，类型、大小、名字按行排好。
   *
   * 用 `opendir` 边读边收，而不是 `readdir` 一次把整个目录读进内存再切：
   * 一个十万条目的目录，`readdir` 会先分配十万个 Dirent，再让我们丢掉九万九千个 ——
   * 上限形同虚设。现在最多只读 `scanLimit` 项、最多展示 `MAX_LIST_ENTRIES` 条。
   *
   * 扫描提前停手时必须在结果里说明「目录可能没列全」：只给 500 行而不说还有，
   * 模型会把「没列出来」当成「不存在」。
   */
  async list(requested: string): Promise<string> {
    const dir = await this.resolveReal(this.resolve(requested), requested);

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
   * 工作区方法 glob（找文件）：按名字模式找文件，一行一个，排好序。
   *
   * 搜索根默认是工作区根目录，也可以用 `path` 指向别的目录（含工作区外）；
   * 模式里的绝对路径同样可用。返回路径在工作区内时相对工作区根目录，
   * 在工作区外时用绝对路径 —— 同一个显示规则也适用于 grep，模型不需要猜。
   *
   * 做法是「在搜索根里走，拿模式去套」，而不是把模式交给 `fs.glob` 去展开：
   * 自己走目录才能让扫描预算、跳过规则和结果上限都真实生效。
   *
   * 代价：支持的语法只有 `*`、`**`、`?`，其余字符（含 `{ } [ ]`）按字面匹配。
   */
  async glob(pattern: string, requested = "."): Promise<string> {
    if (pattern === "") throw new Error("pattern must not be empty");
    const search = await this.resolveGlobRoot(pattern, requested);

    const matcher = globToRegExp(search.pattern);
    const rootReal = await this.realRoot();
    const outsideRoot = escapes(rootReal, search.base);
    const budget = { remaining: this.scanLimit };
    const matches: string[] = [];
    let hitLimit = false;
    for await (const file of walkFiles(search.base, budget)) {
      const relative = toPosix(path.relative(search.base, file));
      if (!matcher.test(relative)) continue;
      // 第 MAX_RESULTS+1 条命中只用来判断「还有更多」，不塞进结果。
      if (matches.length === MAX_RESULTS) {
        hitLimit = true;
        break;
      }
      matches.push(outsideRoot ? toPosix(file) : toPosix(path.relative(rootReal, file)));
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
   * 把 glob 模式拆成「遍历起点 + 相对模式」。
   *
   * 允许三种写法：相对模式（相对 `path`）、绝对模式、以及开头带 `../` 的相对模式。
   * 模式中间的 `..` 一律拒绝：它在 glob 语义里没有唯一解释，猜错就是静默搜错地方。
   */
  private async resolveGlobRoot(pattern: string, requested: string): Promise<{ base: string; pattern: string }> {
    if (path.isAbsolute(pattern)) {
      const split = splitAbsoluteGlob(pattern);
      if (split.relative.split("/").includes("..")) {
        throw new Error(`invalid absolute glob pattern: ${pattern}`);
      }
      return { base: await this.resolveReal(split.base, requested), pattern: split.relative };
    }

    const segments = toPosix(pattern).split("/");
    let index = 0;
    let base = this.resolve(requested);
    while (segments[index] === "..") {
      base = path.dirname(base);
      index++;
    }
    const rest = segments.slice(index).join("/");
    if (rest === "") throw new Error(`glob pattern must name something to match: ${pattern}`);
    if (rest.split("/").includes("..")) {
      throw new Error(`glob pattern may only use ".." at the start: ${pattern}`);
    }
    return { base: await this.resolveReal(base, requested), pattern: rest };
  }

  /**
   * 工作区方法 grep（搜内容）：按文字内容找，每条给出「文件:行号: 内容」，最多 MAX_RESULTS 条。
   *
   * 正则由模型提供，`(a+)+$` 这类模式会指数级回溯。匹配因此跑在 `grep-worker.ts` 的线程里，
   * 主线程只守 `regexBudgetMs` 的时间预算：超时就 terminate 线程，回溯跟着线程一起消失。
   * 「不会被输入卡死」这条不变量还在，模型拿回了正则能力 —— 取舍记在 ADR-0010。
   *
   * `fixed` 把 pattern 转义成等价的正则源码，复用同一条匹配路径：转义后的字面量
   * 不可能回溯，但没必要为它维护第二套匹配逻辑和第二种错误口径。
   *
   * 二进制文件（含 NUL 字节）直接跳过：按 UTF-8 读出来只是乱码。
   * 超过 MAX_GREP_FILE_BYTES 的文件不读，并在结果里说明跳过了几个 ——
   * 否则模型会以为「没搜到」等于「不存在」。
   * 读不了的文件（权限、坏链接）也跳过：一次搜索不该被一个文件打断。
   */
  async grep(pattern: string, requested = ".", options: GrepOptions = {}): Promise<string> {
    if (pattern === "") {
      // 空模式会匹配每一行（`new RegExp("")` 恒真），放过去等于「列出所有内容」。
      throw new Error("search pattern must not be empty");
    }
    const flags = normalizeGrepFlags(options.flags ?? "");
    const source = options.fixed === true ? escapeRegExp(pattern) : pattern;
    assertValidPattern(source, flags);

    // grep 是读取已有目录，不是 write 的创建路径：起点必须真实存在。
    // realpath 同时把链接解析成实际目标，后续遍历不会在解析后被别名换掉。
    const start = await realpath(this.resolve(requested));
    const rootReal = await this.realRoot();
    const outsideRoot = escapes(rootReal, start);

    const hits: Array<{ file: string; line: number; text: string }> = [];
    let skippedLarge = 0;
    let unreadable = 0;
    let regexStopped = false;
    let spentMs = 0;
    // 一次 grep 只分配一块上限大小的读缓冲，所有文件复用 —— 不按文件数乘内存。
    const buffer = Buffer.alloc(MAX_GREP_FILE_BYTES + 1);
    const budget = { remaining: this.scanLimit };
    const matcher = new RegexGrep(source, flags);
    try {
      for await (const file of walkFiles(start, budget)) {
        if (hits.length >= MAX_RESULTS) break;

        const remaining = this.regexBudgetMs - spentMs;
        if (remaining <= 0) {
          // 预算在「还有文件没搜」的时候用完了：结果不完整，必须说出来。
          regexStopped = true;
          break;
        }

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

        const startedAt = Date.now();
        let lineNumbers: number[];
        try {
          lineNumbers = await matcher.match(content, MAX_RESULTS - hits.length, remaining, this.signal);
        } catch (error) {
          // 超时是预期结果，不是失败：停在当前文件，保留已经拿到的命中。
          if (error instanceof Error && error.message === REGEX_TIMEOUT) {
            regexStopped = true;
            break;
          }
          throw error;
        }
        // 只累计匹配时间：读文件和 worker 启动不该吃掉正则的预算。
        spentMs += Date.now() - startedAt;

        if (lineNumbers.length > 0) {
          const lines = content.split("\n");
          for (const lineNumber of lineNumbers) {
            const line = lines[lineNumber - 1].trim();
            hits.push({
              // 工作区内相对工作区根目录；工作区外用绝对路径，避免一串 ../../ 无法定位。
              file: outsideRoot ? toPosix(file) : toPosix(path.relative(rootReal, file)),
              line: lineNumber,
              // 超长行必须留下截断标记：悄悄切到 200 字，模型会以为那一行就到此为止。
              text: line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}${LINE_TRUNCATED}` : line,
            });
            if (hits.length >= MAX_RESULTS) break;
          }
        }
      }
    } finally {
      await matcher.close();
    }

    // 部分失败要报告：截断、跳过、读不了、扫描预算用尽、正则超时，一律写进尾注，由 clip 保住。
    const tails =
      (hits.length >= MAX_RESULTS ? `\n… (stopped at ${MAX_RESULTS} matches)` : "") +
      (skippedLarge > 0 ? `\n… (skipped ${skippedLarge} files over 1 MB)` : "") +
      (unreadable > 0 ? `\n… (${unreadable} files could not be read)` : "") +
      (regexStopped ? `\n… (regex stopped after ${this.regexBudgetMs}ms; results may be incomplete)` : "") +
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
   * 已知边界：Windows taskkill 失败后的直接 child.kill 不能清理全部后代；必须在有界等待后报错，
   * 而不是把「已经尝试停止」冒充「已完成进程树清理」。
   */
  /**
   * 后台执行：起服务这类永不退出的命令。
   *
   * 不并入 run 的等待逻辑：后台进程本来就不会 close，等它就是等超时。
   * 输出写文件而不是接管道 —— 这是实测出来的：`stdio: "pipe"` 加上 `unref()` 之后，
   * 管道的 handle 仍然挂在宿主的 event loop 上，任务跑完了 agent 也退不出去（要等 4 秒硬杀）。
   * 写文件则一个句柄都不留，`unref()` 的语义才真的成立。
   */
  private async runInBackground(command: string): Promise<string> {
    const id = `job-${++this.jobSeq}`;
    // 编号只在 Workspace 内唯一；同一宿主里的多个 Workspace 也必须隔离日志。
    const logPath = path.join(JOB_LOG_DIR, `${process.pid}-${id}-${randomUUID()}.log`);
    mkdirSync(JOB_LOG_DIR, { recursive: true });

    // 独占创建，避免覆盖已有文件；日志可能含敏感输出，POSIX 上只让当前用户读写。
    const fd = openSync(logPath, "wx", 0o600);
    let child: ChildProcess;
    try {
      // POSIX 的 EXIT trap 会等待命令显式启动的后台子进程，避免 shell 先退出、
      // 进程组却留下孤儿；这样 job 的组长仍在，shell-kill 才能安全地停止整组。
      const launchCommand = process.platform === "win32"
        ? command
        : `trap 'status=$?; trap - EXIT; wait; exit "$status"' EXIT
${command}`;
      child = spawn(launchCommand, {
        cwd: this.root,
        shell: true,
        windowsHide: true,
        // POSIX 上开新进程组，`kill -- -pid` 才能连后代一起收掉；
        // Windows 上**不能** detached：`shell:true` + `detached:true` 时 cmd.exe 的输出
        // 会整个丢掉（实测日志恒为 0 字节，连 shell 自己的 `> file` 重定向都救不回来），
        // 而 Windows 本来就不靠进程组收尾，用的是 `taskkill /T`。
        // 前台 run 用的是同一条规则，两处必须一致。
        detached: process.platform !== "win32",
        // 进程要脱离父进程，但输出不能丢：丢掉的正是「起没起来」的证据。
        stdio: ["ignore", fd, fd],
      });
    } finally {
      // child 已经复制了 fd；父进程再留着它只是多一个句柄，而且 Windows 上会锁住文件。
      closeSync(fd);
    }

    const job: BackgroundJob = {
      id,
      command,
      pid: child.pid,
      child,
      logPath,
      cursor: 0,
      status: "running",
      exitCode: null,
    };
    let spawned = false;
    const onChildError = (error: Error) => {
      if (spawned && job.status === "running") {
        job.status = "unverified";
        job.error = error.message;
      }
    };
    child.on("error", onChildError);
    child.on("exit", (code) => {
      if (job.status !== "running") return;
      job.status = "exited";
      job.exitCode = code;
    });

    // spawn() 的失败是异步 error 事件，不是同步 throw。必须等到 spawn 事件后才能报告 started；
    // 否则无效 cwd 会先返回成功，再因未处理的 error 事件把整个 Agent 进程打崩。
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          spawned = true;
          child.off("error", onSpawnError);
          resolve();
        };
        const onSpawnError = (error: Error) => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onSpawnError);
      });
    } catch (error) {
      child.off("error", onChildError);
      await unlink(logPath).catch(() => {});
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not start background command: ${detail}`);
    }

    child.unref();
    this.jobs.set(id, job);

    return `started ${id} (pid ${child.pid ?? "unknown"}) in the background; ` +
      `read new output with shell-output, stop it with shell-kill`;
  }

  /**
   * 工作区方法 readJobOutput（看后台输出）：读一个后台任务从上次查看之后新产生的输出。
   *
   * 三个决定：
   *   - **增量**：只返回新字节，模型不会把同一段日志反复读进上下文；
   *   - **有界**：单次最多 8k 字符，超出的不消费，明确告诉模型「还有，再调一次」；
   *   - **带状态**：第一行永远是「还在跑 / 退出了，exit N / 被我停了」，否则模型会把
   *     「服务已经崩了」看成「服务还没输出」。
   *
   * wait 期间只能轮询：日志是普通文件，没有事件可订阅。
   */
  async readJobOutput(jobId: string, waitMs = 0): Promise<string> {
    const job = this.job(jobId);
    const budget = Math.min(Math.max(waitMs, 0), MAX_JOB_WAIT_MS);
    const deadline = Date.now() + budget;

    let text = "";
    for (;;) {
      const size = await this.jobLogSize(job);
      if (size > job.cursor) {
        text = await this.readJobText(job, size);
        // 空串只可能是「末尾只剩半个多字节字符」：这时候必须继续等，
        // 否则第一次调用返回空、第二次调用又立刻返回空，永远等不到那个字补齐。
        if (text !== "") break;
      }
      // 进程已经不在了就没什么可等的；再等下去只是把 Step 拖长。
      if (job.status !== "running") break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    }

    const header = this.jobHeader(job);
    if (text === "") return `${header}\n(no new output)`;

    const characters = Array.from(text);
    let shown = text;
    let tail = "";
    if (characters.length > MAX_JOB_OUTPUT_CHARS) {
      // 按 Unicode code point 截断，不能用 String.slice 的 UTF-16 code unit 边界切开代理对。
      shown = characters.slice(0, MAX_JOB_OUTPUT_CHARS).join("");
      // 只推进「真正给出去的字节」，剩下的留在日志里等下一次调用。
      tail = `
… [${characters.length - MAX_JOB_OUTPUT_CHARS} chars not shown; call shell-output again]`;
    }
    job.cursor += Buffer.byteLength(shown);

    return `${header}\n${shown}${tail}`;
  }

  /** 从 cursor 开始读到 size，只返回完整的 UTF-8 字符；末尾被切断的那截不消费。 */
  private async readJobText(job: BackgroundJob, size: number): Promise<string> {
    const take = Math.min(size - job.cursor, MAX_JOB_READ_BYTES);
    const handle = await open(job.logPath, "r");
    try {
      const buffer = Buffer.alloc(take);
      const { bytesRead } = await handle.read(buffer, 0, take, job.cursor);
      return buffer.subarray(0, completeUtf8Prefix(buffer.subarray(0, bytesRead))).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  /**
   * 工作区方法 killJob（停后台任务）：停掉一个后台任务，连同它的后代进程。
   *
   * 未确认时抛异常而不是返回「已停止」：`taskkill` 只杀外层、POSIX 上回退只杀直接子进程，
   * 这两种情况后代可能还活着。冒充成功会让模型以为端口已经释放，然后在一个还占着端口的
   * 世界里继续排查 —— 那是把一次失败变成一串莫名其妙的失败。
   */
  async killJob(jobId: string): Promise<string> {
    const job = this.job(jobId);
    if (job.status === "exited") return `${job.id} already exited with code ${job.exitCode ?? "unknown"}`;
    if (job.status === "killed") return `${job.id} is already stopped`;

    const confirmed = await terminateTree(job.child);
    job.status = confirmed ? "killed" : "unverified";
    if (!confirmed) {
      // 中文对照：进程树清理未确认；后代进程可能仍在运行。
      throw new ProcessCleanupError(
        `process tree cleanup unverified for ${job.id}; descendant processes may still be running`,
      );
    }
    // 等进程真的退场再回答。pid 不再响应信号，不等于系统已经放掉它的 cwd 和句柄 ——
    // 宿主紧接着删目录会撞上 EBUSY，而模型会以为「停了」之后立刻能重用那个目录。
    await this.awaitExit(job);
    return `stopped ${job.id}`;
  }

  /** 有界地等一个任务退出；已经退出就立刻返回。 */
  private awaitExit(job: BackgroundJob): Promise<void> {
    if (job.child.exitCode !== null || job.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, PROCESS_CLOSE_TIMEOUT_MS);
      job.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 取一个后台任务，取不到就报出还有哪些可用 —— 模型据此改正编号，而不是重新起一个。 */
  private job(jobId: string): BackgroundJob {
    const job = this.jobs.get(jobId);
    if (job !== undefined) return job;
    const known = this.jobs.size === 0 ? "none" : [...this.jobs.keys()].join(", ");
    throw new Error(`unknown background job "${jobId}" (known: ${known})`);
  }

  /** 日志文件的当前字节数；文件被外部删掉时当作 0，不让读输出这件事整个失败。 */
  private async jobLogSize(job: BackgroundJob): Promise<number> {
    try {
      return (await stat(job.logPath)).size;
    } catch {
      return 0;
    }
  }

  /** 状态行：模型先看这一行，再决定是继续等、去修，还是收工。 */
  private jobHeader(job: BackgroundJob): string {
    const status = job.status === "exited" ? `exited with code ${job.exitCode ?? "unknown"}` :
      job.status === "unverified" && job.error !== undefined ? `unverified: ${job.error}` : job.status;
    const pid = job.pid === undefined ? "unknown pid" : `pid ${job.pid}`;
    return `${job.id} (${status}, ${pid}) ran: ${job.command}`;
  }

  /**
   * 工作区方法 run（跑命令）：执行一条系统命令，返回退出码、正常输出、错误输出。
   *
   * 前台命令有超时上限；永不退出的命令（服务、监听）必须走 background，
   * 否则会一直等到超时，再被判成「进程树没杀干净」而终止整个任务。
   */
  async run(command: string, options: { background?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const signal = this.signal;
    if (signal?.aborted) {
      // 取消之后不再启动新进程：这是「不能在取消后继续启动新工具」的最后一道闸门。
      throw new Error("cancelled before the command started");
    }
    // 后台进程：起服务这类永不退出的命令必须走这里，否则会一直等到超时，
    // 再被判成「进程树没杀干净」而终止整个任务。Claude Code 的 run_in_background 同理。
    if (options.background === true) return this.runInBackground(command);

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
      let cleanup: Promise<boolean> | undefined;
      let settled = false;
      let closeDeadline: ReturnType<typeof setTimeout> | undefined;

      // stdout/stderr 各有自己的 UTF-8 解码状态：一个汉字的三个字节可能跨两个 data 事件。
      // 直接 chunk.toString() 会把它拆成替换字符；两个流也不能共用一个 decoder。
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const absorbText = (text: string) => {
        collected += text;
        if (collected.length > MAX_OUTPUT_CHARS) {
          dropped += collected.length - MAX_OUTPUT_CHARS;
          collected = collected.slice(0, MAX_OUTPUT_CHARS);
        }
      };

      const effectiveTimeout = options.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => stop(`timeout after ${effectiveTimeout}ms`), effectiveTimeout);
      const onAbort = () => stop("cancelled by signal");
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = () => {
        clearTimeout(timer);
        if (closeDeadline !== undefined) clearTimeout(closeDeadline);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectUnverifiedCleanup = () => {
        if (settled) return;
        settled = true;
        finish();
        // 孙进程可能仍持有 stdout/stderr；不能等 close 事件无限挂住 Agent。
        child.stdout?.destroy();
        child.stderr?.destroy();
        // 中文对照：进程树清理未确认；后代进程可能仍在运行。
        reject(new ProcessCleanupError(`process tree cleanup unverified after ${stopped ?? "stop"}; descendant processes may still be running`));
      };
      const stop = (reason: string) => {
        // 进程已经收尾之后不再补一刀：Windows 上 PID 可能已经被复用。
        if (settled || stopped !== undefined) return;
        stopped = reason;
        cleanup = terminateTree(child);
        // 直接子进程 close 迟迟不来时必须有硬截止时间；不能让模型等待无限久。
        closeDeadline = setTimeout(rejectUnverifiedCleanup, PROCESS_CLOSE_TIMEOUT_MS);
        void cleanup.then((confirmed) => {
          if (!confirmed) rejectUnverifiedCleanup();
        }, rejectUnverifiedCleanup);
      };

      child.stdout.on("data", (chunk: Buffer) => absorbText(stdoutDecoder.write(chunk)));
      child.stderr.on("data", (chunk: Buffer) => absorbText(stderrDecoder.write(chunk)));
      child.stdout.on("end", () => absorbText(stdoutDecoder.end()));
      child.stderr.on("end", () => absorbText(stderrDecoder.end()));

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
        // 先等清理结论，只有系统报告成功才给出正常的超时/取消结果。
        // cleanup 失败由 rejectUnverifiedCleanup 直接拒绝，不允许假装进程树已清空。
        void (cleanup ?? Promise.resolve(true)).then((confirmed) => {
          if (!confirmed) {
            // 中文对照：进程树清理未确认；后代进程可能仍在运行。
            reject(new ProcessCleanupError(`process tree cleanup unverified after ${stopped ?? "stop"}; descendant processes may still be running`));
            return;
          }
          resolve({
            status: stopped ?? `exit ${code}`,
            output: collected,
            dropped,
          });
        }, reject);
      });
    });

    // 丢弃统计走 tail，不跟正文抢位置：否则「丢了 1000 字符」会被 8000 字符的上限切掉，
    // 模型看到一段完整输出，其实少了一千个字符。
    const tail = dropped > 0 ? `\n… [dropped ${dropped} chars]` : "";
    return this.clip(`${status}\n${output}`, tail);
  }

  /**
   * 把模型给的路径解析成绝对路径。
   *
   * 相对路径相对工作区根目录；绝对路径直接使用；`..` 可以走出工作区。
   * 这里刻意不做「是否在工作区内」的判断：Full Access 下能碰什么由启动 Agent 的
   * 操作系统账户决定，把工作区根目录当成权限边界只会让 Shell 与文件工具能力不一致。
   */
  private resolve(requested: string): string {
    return path.resolve(this.root, requested);
  }

  /**
   * 把路径解析到真实位置（链接解析后）。
   *
   * 链接（symlink / junction）会让词法路径与实际目标分叉，所以真正碰文件系统之前
   * 一律换成真实路径：后续 I/O 使用的是同一个位置，不会在解析后被别名换成别处。
   *
   * 目标还不存在时（比如 write 新文件），沿父目录一路往上找第一个存在的路径，
   * 再把尚不存在的部分拼回去 —— 在链接目录里新建文件，也照样落到真实目标上。
   * 路径存在却解析不了（坏链接）时不猜它指向哪，直接报错。
   */
  private async resolveReal(absolute: string, requested: string): Promise<string> {
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
        if (exists) throw new Error(`cannot resolve path: ${requested}`);
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }

    // 已存在的路径返回 realpath；尚未创建的文件拼回最接近的真实父目录。
    return path.resolve(real, path.relative(probe, absolute));
  }

  /** 最后的副作用提交点必须重新读取 signal，不能只在 Run/Tool 开始时检查。 */
  private stopIfCancelledBeforeWrite(): void {
    if (this.signal?.aborted) throw new Error("cancelled before file write");
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
  options: { preserveBom?: boolean } = {},
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  const handle = await open(file, constants.O_RDONLY | NO_FOLLOW_FILE);
  try {
    return await readTextUpToHandle(handle, limit, buffer, options);
  } finally {
    await handle.close();
  }
}

/** edit 读写复用一个已校验的文件句柄，杜绝读完后再次按路径打开另一个文件。 */
async function readTextUpToHandle(
  handle: FileHandle,
  limit: number,
  buffer: Buffer,
  options: { preserveBom?: boolean } = {},
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  const bytesRead = await fillBuffer(
    (target, offset, length, position) => handle.read(target, offset, length, position),
    buffer,
  );
  const truncated = bytesRead > limit;
  // TextDecoder 默认剥开头的 BOM；edit 需要保留它。
  const text = new TextDecoder("utf-8", { ignoreBOM: options.preserveBom === true }).decode(
    buffer.subarray(0, Math.min(bytesRead, limit)),
    { stream: truncated },
  );
  return { text, truncated, bytesRead };
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
 * 尽力停止整棵进程树，并报告是否得到系统级的成功信号。
 * Windows 上 `taskkill /T /F` 返回 0 才算确认；启动失败、非零退出和挂起都回退
 * 到 `child.kill()`，但它只能停止直接子进程，不能冒充「孙进程已经被清理」。
 * POSIX 上成功向整个进程组发 SIGKILL 算确认，回退只杀外层进程算未确认。
 *
 * 已知边界：成功信号不等于跨平台的 OS 级孤儿进程证明；异常路径必须显式失败。
 * 测试可注入 taskkill 的进程事件及截止时间，不修改 WorkspaceOptions 公开配置。
 */
export function terminateTree(
  child: ChildProcess,
  options: {
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    spawnTaskkill?: (pid: number) => Pick<ChildProcess, "once"> & Partial<Pick<ChildProcess, "kill">>;
  } = {},
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve(false);

  if ((options.platform ?? process.platform) === "win32") {
    return new Promise((resolve) => {
      let finished = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let killer: (Pick<ChildProcess, "once"> & Partial<Pick<ChildProcess, "kill">>) | undefined;
      const complete = (confirmed: boolean) => {
        if (finished) return;
        finished = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (!confirmed) {
          try {
            child.kill();
          } catch {
            // 直接子进程可能已退出，但不能因此把孙进程视为已清理。
          }
        }
        resolve(confirmed);
      };

      try {
        killer = options.spawnTaskkill?.(pid) ?? spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        // 一次 taskkill 可能先发 error 后发 close；后来的事件不能推翻首次结论。
        killer.once("error", () => complete(false));
        killer.once("close", (code) => complete(code === 0));
        // taskkill 的超时结果必须先固定为未确认，迟到的 close(0) 不能改写结论。
        if (!finished) timeout = setTimeout(() => {
          complete(false);
          try {
            killer?.kill?.();
          } catch {
            // 连 taskkill 自己都可能无法停止；已尝试回退外层进程，仍须报告未确认。
          }
        }, options.timeoutMs ?? TASKKILL_TIMEOUT_MS);
      } catch {
        complete(false);
      }
    });
  }

  try {
    // detached 起进程组，负号 = 整组。只有成功发出整组 kill 才报告确认。
    process.kill(-pid, "SIGKILL");
    return Promise.resolve(true);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 子进程可能已经退出；仅杀外层进程不是完整的进程树清理。
    }
    return Promise.resolve(false);
  }
}

/** 超时用的是这条固定消息：调用方靠它区分「正则跑太久」和真正的 worker 故障。 */
const REGEX_TIMEOUT = "regex matching timed out";

type PendingMatch = {
  resolve: (lines: number[]) => void;
  reject: (error: Error) => void;
};

type MatchReply = { id: number; lines?: number[]; error?: string };

/**
 * 一个 grep 调用对应一个匹配线程。
 *
 * 线程只做逐行匹配；遍历、读文件、截断、排序都留在主线程 —— worker 不该再实现一套工作区规则。
 * 超时和取消都走 terminate：回溯是同步循环，没有任何办法让 `regex.test()` 自己停下来。
 */
class RegexGrep {
  private readonly worker: Worker;

  private readonly pattern: string;

  private readonly flags: string;

  private readonly pending = new Map<number, PendingMatch>();

  private nextId = 1;

  constructor(pattern: string, flags: string) {
    this.pattern = pattern;
    this.flags = flags;
    this.worker = new Worker(new URL("./grep-worker.ts", import.meta.url));
    this.worker.on("message", (reply: MatchReply) => this.settle(reply));
    // 线程崩了：所有等待中的调用统一失败，不能留下永远不会 settle 的 promise。
    this.worker.on("error", (error: Error) => this.failAll(new Error(`grep worker failed: ${error.message}`)));
    this.worker.on("exit", () => this.failAll(new Error("grep worker exited unexpectedly")));
  }

  /**
   * 把一份文件内容送进线程匹配，最多等 timeoutMs。
   * signal 触发时 terminate 线程并拒绝 —— 取消不该等当前文件匹配完。
   */
  match(text: string, limit: number, timeoutMs: number, signal?: AbortSignal): Promise<number[]> {
    if (signal?.aborted === true) return Promise.reject(new Error("cancelled by signal"));

    const id = this.nextId++;
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        // 先 terminate 再拒绝：线程里可能正卡在指数级回溯上。
        void this.worker.terminate();
        reject(new Error(REGEX_TIMEOUT));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        void this.worker.terminate();
        reject(new Error("cancelled by signal"));
      };

      this.pending.set(id, {
        resolve: (lines) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(lines);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.worker.postMessage({ id, text, pattern: this.pattern, flags: this.flags, limit });
    });
  }

  async close(): Promise<void> {
    this.failAll(new Error("grep worker closed"));
    await this.worker.terminate();
  }

  private settle(reply: MatchReply): void {
    const pending = this.pending.get(reply.id);
    if (pending === undefined) return;
    this.pending.delete(reply.id);
    if (reply.error !== undefined) pending.reject(new Error(reply.error));
    else pending.resolve(reply.lines ?? []);
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const pending of waiting) pending.reject(error);
  }
}

/** 把字面字符串转成等价的正则源码：fixed 模式复用同一条匹配路径。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 只接受 i / m / s / u；g 和 y 直接丢掉 —— 逐行匹配每次都从 lastIndex = 0 开始，
 * 这两个标志带进来只会让模型以为自己控制了什么。其它字母说明参数写错了，直接报错。
 */
function normalizeGrepFlags(flags: string): string {
  const unknown = [...flags].filter((flag) => !"gimsuy".includes(flag));
  if (unknown.length > 0) {
    throw new Error(`unsupported regex flags: ${unknown.join("")}; use i, m, s, u`);
  }
  return [...new Set([...flags].filter((flag) => "imsu".includes(flag)))].join("");
}

/** 先在主线程编译一次：坏正则要在开始扫描前失败，不能扫到一半才抛。 */
function assertValidPattern(source: string, flags: string): void {
  try {
    new RegExp(source, flags);
  } catch (error) {
    throw new Error(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 把 glob 模式翻译成正则（给「自己走目录再匹配」用）。
 *
 * 只认三种通配：`**` 跨目录、`*` 单层内任意、`?` 单个字符；
 * 其余字符一律按字面匹配 —— 特别是 `{ }` 和 `[ ]` 不再有特殊含义。
 * 这既是「模式语义可预测」的要求，也让扫描范围只由搜索根和模式本身决定。
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
 * 链接可能指向任意位置，顺着它走既可能绕圈，也会让扫描预算落在无法预期的目录树上。
 * 链接本身仍然可以被直接访问 —— 把它作为搜索起点时，realpath 会解析到实际目标。
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
/** 文件路径说明：相对路径以工作区根目录为基准，绝对路径和 ../ 都能用。 */
const PATH_DESCRIPTION =
  "File path. Relative paths resolve from the workspace root; absolute paths and ../ are allowed.";

/** 目录说明：默认工作区根目录，也可以指向任意其他目录。 */
const DIR_DESCRIPTION =
  "Directory path. Relative paths resolve from the workspace root; absolute paths and ../ are allowed. Defaults to the workspace root.";

export function createWorkspaceTools(workspace: Workspace): Tool[] {
  return [
    {
      name: "read",
      // 读工具 read：把一个文本文件的内容读出来。
      // 一次最多读 8000 个字符；文件比这更大时，只读到前面这一截，
      // 并且明确告诉你被截断了，不会假装已经读完。
      description: "Read a UTF-8 text file. Output is truncated to 8000 chars.",
      parameters: {
        type: "object",
        properties: {
          // 文件路径：相对路径以工作区根目录为基准，绝对路径与 ../ 同样可用。
          path: { type: "string", description: PATH_DESCRIPTION },
        },
        required: ["path"],
      },
      run: async (args) => workspace.read(String(args.path)),
    },
    {
      name: "write",
      // 写工具 write：新建一个文件，或者把已有文件整个覆盖掉。
      // 文件所在的目录不存在时，会先自动建好。
      // 如果只是想改文件里的一小段，别用这个——用下面的改工具，它不会动其他地方。
      description:
        "Create or overwrite a whole UTF-8 file; parent directories are created. Prefer edit for changing part of an existing file.",
      parameters: {
        type: "object",
        properties: {
          // 文件路径：相对路径以工作区根目录为基准，绝对路径与 ../ 同样可用。
          path: { type: "string", description: PATH_DESCRIPTION },
          // 要写入的完整文件内容。
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
      run: async (args) => workspace.write(String(args.path), String(args.content)),
    },
    {
      name: "edit",
      // 改工具 edit：把文件里的一段文字换成另一段。
      // 要求「要找的那段原文」在文件里只出现一次——出现两次以上会被拒绝，
      // 因为分不清你想改哪一个。拿不准的时候，先用读工具看一眼。
      // 新内容留空，就等于把那段删掉。
      description:
        "Replace exactly one occurrence of old_string with new_string in an existing file. old_string must appear exactly once; read the file first when unsure.",
      parameters: {
        type: "object",
        properties: {
          // 文件路径：相对路径以工作区根目录为基准，绝对路径与 ../ 同样可用。
          path: { type: "string", description: PATH_DESCRIPTION },
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
      // 找文件工具 glob：按文件名找，支持通配符——* 代表任意几个字符，
      // ** 代表可以跨目录，? 代表一个字符。
      // 例如 "src/**/*.ts" 的意思是「src 下面所有层级里的 .ts 文件」。
      // 从哪个目录开始找可以指定，默认从工作区根目录开始。
      description:
        'Find files by glob pattern (supports *, ** and ?). The pattern may be relative to the search root or absolute. ' +
        'Results are relative to the workspace root, or absolute when the search root is outside it. ' +
        'Example: "src/**/*.ts".',
      parameters: {
        type: "object",
        properties: {
          // 要匹配的模式；** 可以跨目录。
          pattern: { type: "string", description: 'Glob pattern such as "src/**/*.ts"; ** crosses directories.' },
          // 从哪个目录开始找；默认工作区根目录，也可以指向任意其他目录。
          path: { type: "string", description: DIR_DESCRIPTION },
        },
        required: ["pattern"],
      },
      run: async (args) => workspace.glob(String(args.pattern), String(args.path ?? ".")),
    },
    {
      name: "grep",
      // 搜内容工具 grep：按文字内容找，每条结果给出「文件路径:行号: 那一行的内容」。
      // 默认按「正则表达式」匹配——一种写查找规则的方式，比如 ^import 表示「以 import 开头」。
      // 如果只想搜一段普通文字，把 fixed 设成 true，就不用管正则里那些符号了。
      description:
        "Search file contents by JavaScript regular expression; returns one file:line: match line per hit. Set fixed=true to search a literal string.",
      parameters: {
        type: "object",
        properties: {
          // 要搜索的正则（JavaScript 语法，逐行匹配）；fixed=true 时按字面字符串解释。
          pattern: { type: "string", description: "JavaScript regular expression, matched line by line." },
          // 从哪个目录开始搜；默认工作区根目录，也可以指向任意其他目录。
          path: { type: "string", description: DIR_DESCRIPTION },
          // 正则标志：i 忽略大小写，m / s / u 按 JS 语义；g 会被忽略。
          flags: { type: "string", description: "Regex flags: i, m, s, u (g is ignored)." },
          // true 时把 pattern 当字面字符串，不解释正则元字符。
          fixed: { type: "boolean", description: "Treat pattern as a literal string instead of a regular expression." },
        },
        required: ["pattern"],
      },
      run: async (args) =>
        workspace.grep(String(args.pattern), String(args.path ?? "."), {
          flags: args.flags === undefined ? "" : String(args.flags),
          fixed: args.fixed === true,
        }),
    },
    {
      name: "ls",
      // 列目录工具 ls：看看一个目录里有什么。
      // 每一项会给出三样东西：它是文件还是目录、有多大（字节数）、叫什么名字。
      description: "List a directory: entry type, size in bytes, and name.",
      parameters: {
        type: "object",
        properties: {
          // 目录路径：相对路径以工作区根目录为基准，绝对路径与 ../ 同样可用。
          path: { type: "string", description: DIR_DESCRIPTION },
        },
        required: ["path"],
      },
      run: async (args) => workspace.list(String(args.path)),
    },
    {
      name: "shell",
      // 跑命令工具 shell：执行一条系统命令，返回三样东西——退出码、正常输出、错误输出。
      // 命令默认在工作区根目录下执行，命令里面也可以自己切换目录、用绝对路径。
      // 如果这条命令不会自己结束（比如启动一个服务），必须把 background 设成 true，
      // 否则会一直卡着，直到超时。
      description: "Run a shell command; returns exit code plus stdout/stderr. " +
        "The working directory defaults to the workspace root, and the command may cd anywhere or use absolute paths. " +
        "Use background:true for servers or anything that never exits - a foreground call blocks until it times out.",
      parameters: {
        type: "object",
        properties: {
          // 要执行的命令；工作区根目录是默认 cwd，命令内部可以自行 cd。
          command: { type: "string", description: "Shell command, executed with the workspace root as cwd unless it cds elsewhere." },
          // 后台执行：立即返回任务编号，进程不会随这次调用结束；用 shell-output 看输出，shell-kill 停掉。
          background: {
            type: "boolean",
            description:
              "Start detached and return a job id immediately; the process keeps running. " +
              "Read it with shell-output and stop it with shell-kill.",
          },
          // 前台命令的超时（毫秒），默认 120000，上限 600000。
          timeout: {
            type: "number",
            description: "Timeout in milliseconds for a foreground command (default 120000, max 600000).",
          },
        },
        required: ["command"],
      },
      run: async (args) => workspace.run(String(args.command), {
        background: args.background === true,
        timeoutMs: typeof args.timeout === "number"
          ? Math.min(600_000, Math.max(1_000, args.timeout))
          : undefined,
      }),
    },
    {
      name: "shell-output",
      // 看后台输出工具 shell-output：读一个后台任务「从上次查看之后」新产生的输出。
      // 第一行是它的状态：还在跑、已经退出（附退出码）、还是被停掉了。
      // 可以设置等多久——设了就等有新内容再返回，不设就立刻返回现有的。
      description:
        "Read the output a background shell job produced since your last read. " +
        "The first line reports its status (running / exited with a code / killed). " +
        "Set wait to block until something new appears.",
      parameters: {
        type: "object",
        properties: {
          // shell 带 background:true 时返回的任务编号，例如 "job-1"。
          job_id: { type: "string", description: 'Job id returned by shell, such as "job-1".' },
          // 最多等多少毫秒再返回（默认 0，立即返回已有输出），上限 60000。
          wait: {
            type: "number",
            description: "Milliseconds to wait for new output before returning (default 0, max 60000).",
          },
        },
        required: ["job_id"],
      },
      run: async (args) => workspace.readJobOutput(
        String(args.job_id),
        typeof args.wait === "number" ? Math.min(60_000, Math.max(0, args.wait)) : 0,
      ),
    },
    {
      name: "shell-kill",
      // 停后台工具 shell-kill：把一个后台任务，连同它启动的所有子进程一起停掉。
      // 如果没法确认真的停干净了，会明确报错，不会假装已经停了。
      description:
        "Stop a background shell job and its descendant processes. " +
        "Fails loudly when the process tree cleanup cannot be confirmed.",
      parameters: {
        type: "object",
        properties: {
          // shell 带 background:true 时返回的任务编号。
          job_id: { type: "string", description: 'Job id returned by shell, such as "job-1".' },
        },
        required: ["job_id"],
      },
      run: async (args) => workspace.killJob(String(args.job_id)),
    },
  ];
}

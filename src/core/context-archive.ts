/**
 * 文件目的：压缩会把原文换成预览，这份文件负责把「即将被省略的原文」按会话落盘，
 * 让模型和人都还能读回来。没有它，压缩就等于静默丢数据 —— 工具结果被剪掉一半，
 * 事后没人知道中间那 9000 行里写了什么，只能重新跑一遍可能带副作用的命令。
 *
 * 文件职责：负责建会话目录、写存档文件、交回一条能直接交给 `read` 的绝对路径。
 * 不负责决定「什么时候压缩」（那是 `core/session-context.ts`）、不负责摘要（那是 `core/context-compact.ts`）、
 * 不负责清理过期存档（本课不做自动清理，见下方「已知边界」）。
 *
 * 内容目录：
 *   - `ContextArchiveRef`：一条存档的引用 —— 编号、绝对路径、字符数。
 *   - `ContextArchive`：一个会话一个实例；`save()` 写入一份原文并返回引用，失败就抛异常；
 *     `discard()` 撤回一份没被提交的存档。
 *   - 目录布局：`<root>/<时间戳>-<短随机>/<序号>-<kind>-<id>.txt`。
 *
 * 模块关系：只依赖 Node 内置模块（`node:fs/promises`、`node:path`、`node:crypto`），
 * 不认识 `Message`、不认识模型。由 `core/session-context.ts` 在真正要裁剪之前调用，
 * 拿到的 `path` 会被写进给模型看的预览标记里。
 *
 * 已知边界：
 *   - 存档落在系统临时目录（默认 `<tmp>/agent-kernel-context/`），不进项目仓库、不上传、不写进普通日志；
 *     但内容可能包含密钥或源代码，宿主需要知道它在那里。
 *   - 不做保留期限与自动清理：进程崩溃后目录仍在，由宿主或操作系统清理临时目录。
 *   - 单份存档上限由调用方决定；这里不做二次截断 —— 存档的意义就是「完整」。
 */
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

/** 一条存档的引用。`path` 是绝对路径，模型可以直接 `read` 它，必要时用 offset/limit 分段读。 */
export interface ContextArchiveRef {
  /** 存档编号（文件名），写进预览标记便于人对上号。 */
  id: string;
  /** 可直接读取的绝对路径。 */
  path: string;
  /** 原文长度（UTF-16 码元数），与预览标记里的省略数字同一把尺子。 */
  chars: number;
}

/** 一次会话的原文存档目录。一个 Agent 实例一个，子 Agent 各建一个，互不覆盖。 */
export class ContextArchive {
  private readonly root: string;

  /** 会话子目录名；第一次真正要写文件时才创建，不压缩就不落盘。 */
  private readonly sessionName: string;

  private directoryReady = false;

  /** 文件名序号：同一毫秒内写两份也不能互相覆盖。 */
  private sequence = 0;

  constructor(root: string) {
    this.root = path.resolve(root);
    // 时间戳给人看，短随机串防同秒并发冲突。
    this.sessionName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  }

  /** 本次会话的存档目录（绝对路径）。写进报告、排查「原文到底存哪了」时用。 */
  get directory(): string {
    return path.join(this.root, this.sessionName);
  }

  /**
   * 存一份原文，返回它的引用。
   *
   * 用 `wx` 打开：同名文件已存在就失败，绝不覆盖另一份存档 —— 预览可以再剪，
   * 原文只有一份，被覆盖就真没了。目录权限 0700（Windows 忽略），因为里面可能有敏感内容。
   */
  async save(kind: string, id: string, text: string): Promise<ContextArchiveRef> {
    await this.ensureDirectory();
    this.sequence++;
    const label = `${String(this.sequence).padStart(3, "0")}-${sanitize(kind)}-${sanitize(id)}.txt`;
    const file = path.join(this.directory, label);
    await writeFile(file, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { id: label, path: file, chars: text.length };
  }

  /**
   * 撤回一份刚写下、但最终没有任何消息引用的存档。
   *
   * 只在「已经落盘、后来决定不提交」时用：那份原文还在 Transcript 里，存档是多余的副本。
   * 留着它就成了既不在 system 清单里、也没人指向的孤儿文件 —— 内容却是完整历史
   * （可能含密钥与源码），按清单清理的人也不会发现它。
   *
   * 删除失败不抛：它只是清理。一次「不提交」不该因为清理不成功而变成一次异常。
   * 序号不回退：编号只要唯一，跳号无妨。
   */
  async discard(ref: ContextArchiveRef): Promise<void> {
    try {
      await unlink(ref.path);
    } catch {
      // 文件已经被清掉、目录被删、权限不足 —— 都只留下一个多余文件，不影响本次决定。
    }
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.directoryReady = true;
  }
}

/** 文件名只留安全字符：工具调用 id 与 kind 都来自外部，不能直接拼进路径。 */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  return cleaned === "" ? "item" : cleaned;
}

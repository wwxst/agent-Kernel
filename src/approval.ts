/**
 * 审批提示的显示与读取：把一条 Tool call 变成终端上的一行问题，并让等待可以被取消。
 *
 * 为什么单独一个模块：`readline.question()` 只认输入行或接口关闭，不接 AbortSignal。
 * 取消时如果只 `close()`，Promise 在部分 Node/终端组合下不会 settle，整个 Run 卡在审批上。
 * 这里用一次显式 race 把 abort、close、正常回答都收口，CLI 只负责提供 readline 和策略。
 */
import type { PermissionRequest } from "./permission.ts";

/** 审批提示里最多显示多少字符的命令；完整命令仍然原样执行。 */
const APPROVAL_PREVIEW_CHARS = 160;

/**
 * 审批提示压成一行：命令里的换行会把提示符和问题撕开，用户就不知道自己在回答哪一句。
 * 这里只截断**显示**，不会改动真正要执行的命令；放行的是原始参数。
 */
export function formatApproval(request: PermissionRequest): string {
  const command = request.args.command;
  // shell 的 command 已由 ToolRegistry 的 Schema 校验为字符串；这里只做显示层的收窄，
  // 不重复承担校验。拿不到时明确写出来，不展示一个空命令。
  const oneLine = typeof command === "string" ? command.replace(/\s+/g, " ").trim() : "(command unavailable)";
  const preview =
    oneLine.length > APPROVAL_PREVIEW_CHARS ? `${oneLine.slice(0, APPROVAL_PREVIEW_CHARS)}…` : oneLine;
  // 中文对照：\n[permission] 允许 {工具} 执行一次：{命令}？[y/N]
  return `\n[permission] allow ${request.tool} once${preview === "" ? "" : `: ${preview}`}? [y/N] `;
}

/**
 * 读取一行所需的最小接口。
 *
 * readline.Interface 满足它，测试里的假 reader 也满足它；这样取消/EOF 的竞态
 * 不需要真的开一个终端就能确定性地覆盖。
 */
export interface QuestionReader {
  question(prompt: string): Promise<string>;
  close(): void;
  once(event: "close", listener: () => void): void;
  removeListener(event: "close", listener: () => void): void;
}

/** 把 signal 上的取消原因变成非空 Error；没有原因时用固定文案。 */
function cancellationError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.trim() !== "") return new Error(reason);
  return new Error("cancelled by signal");
}

/**
 * 问一行，同时监听 AbortSignal 与 readline 的 close。
 *
 * 三条路谁先到谁收口：正常回答 resolve，abort/EOF reject，之后的结果一律忽略。
 * reject 之后仍然接住底层 question 的 resolve/reject，避免取消瞬间留下一个未处理的 Promise。
 */
export async function askWithSignal(
  reader: QuestionReader,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reader.removeListener("close", onClose);
      settle();
    };

    const onAbort = (): void => {
      finish(() => reject(cancellationError(signal)));
      try {
        reader.close();
      } catch {
        // 拒绝已经收口；关闭失败不影响这次审批的结果。
      }
    };

    const onClose = (): void => {
      finish(() => reject(new Error("approval prompt closed before an answer")));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    reader.once("close", onClose);
    try {
      reader.question(prompt).then(
        (answer) => finish(() => resolve(answer)),
        (error: unknown) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

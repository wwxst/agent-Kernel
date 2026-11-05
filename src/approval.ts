/**
 * 审批提示的显示与读取：把一条 Tool call 变成终端上的问题，并让等待可以被取消。
 *
 * 为什么单独一个模块：`readline.question()` 只认输入行或接口关闭，不接 AbortSignal。
 * 取消时如果只 `close()`，Promise 在部分 Node/终端组合下不会 settle，整个 Run 卡在审批上。
 * 这里用一次显式 race 把 abort、close、正常回答都收口，CLI 只负责提供 readline 和策略。
 */
import type { PermissionRequest } from "./permission.ts";

/**
 * 把审批提示里的控制字符转成可见转义，防止终端控制序列重写/覆盖审批界面。
 *
 * 换行不在这里处理：调用方按行拆开并加前缀，既保留多行命令，又不让命令行伪造提示符。
 * 除换行外的 C0/C1、DEL、Unicode 行分隔符和 bidi 控制字符一律转义。
 */
function escapeControlCharacters(text: string): string {
  return text.replace(
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * 审批提示：完整展示待执行命令、实际 cwd 和一次性确认问题。
 *
 * 不折叠换行、不截断命令尾部：多行命令每行加 `|` 前缀，控制字符转义后显示。
 * 用户看到的是要执行的完整文本，而不是一段可能误导的摘要。
 */
export function formatApproval(request: PermissionRequest, cwd: string): string {
  const command = request.args.command;
  // shell 的 command 已由 ToolRegistry 的 Schema 校验为字符串；这里只做显示层的收窄，
  // 不重复承担校验。拿不到时明确写出来，不展示一个空命令。
  const actual = typeof command === "string" ? command : "(command unavailable)";
  const commandLines =
    actual === "" ? ["(empty command)"] : actual.split("\n").map((line) => `  | ${escapeControlCharacters(line)}`);
  const cwdText = escapeControlCharacters(cwd).replace(/\n/g, "\\u000a");
  // 中文对照：\n[permission] {工具} 在 {cwd} 执行\n命令：\n  | {命令行}\n允许一次？[y/N]
  return [
    "",
    `[permission] ${request.tool} in ${cwdText}`,
    "command:",
    ...commandLines,
    "allow once? [y/N] ",
  ].join("\n");
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

/**
 * 把任意抛出物转成一行**非空**的错误文本。
 *
 * 这是「Fail Explicitly, Never Fail Silently」的第一条：空消息、空字符串、
 * 没有 message 的 Error，都不能变成一句 `ERROR: ` 后面什么都没有 ——
 * 模型看到空错误，只能瞎猜，重试也没方向。
 *
 * 放在单独模块里，是为了让 Toolbelt 和 CLI 用同一套兜底：
 * 错误文案出现两套互相矛盾的处理，比错误本身更难查。
 */

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) return message;
    // `throw new Error()` 的 message 是空串，但 name 至少是 "Error"。
    return error.name.trim() || "Unknown error";
  }

  if (typeof error === "string") {
    const message = error.trim();
    return message.length > 0 ? message : "Unknown error (empty string thrown)";
  }

  if (error === null) return "Unknown error (null)";

  if (typeof error === "object") {
    try {
      // 空对象/空数组序列化成 "{}"/"[]"，等于没说，继续往下落。
      const json = JSON.stringify(error);
      if (json !== undefined && json !== "{}" && json !== "[]") return json;
    } catch {
      // 循环引用、BigInt 之类：序列化本身失败，落到下面的兜底。
    }
  } else if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }

  return `Unknown error (${typeof error})`;
}

/**
 * grep 的正则匹配线程。
 *
 * 为什么需要它：正则由模型提供，`(a+)+$` 这类模式会指数级回溯。匹配如果跑在主线程上，
 * 整个 agent 会跟着它一起卡死，连取消都进不来；「单文件 1 MB + 扫描预算」限制的是输入规模，
 * 拦不住指数级的匹配时间。放进 worker 之后，主线程只守一个时间预算，超时就 terminate ——
 * 回溯随线程一起消失。这是 ADR-0009 给「恢复正则」留的前提。
 *
 * 协议：主线程 postMessage({ id, text, pattern, flags, limit })，这里回
 * `{ id, lines }`（命中行号，从 1 开始）或 `{ id, error }`（正则编译失败）。
 * 只回行号不回文本：文本本来就在主线程手里，没必要再结构化克隆一份大字符串。
 */
import { parentPort } from "node:worker_threads";

type MatchRequest = {
  id: number;
  text: string;
  pattern: string;
  flags: string;
  limit: number;
};

type MatchReply = { id: number; lines: number[] } | { id: number; error: string };

parentPort?.on("message", (request: MatchRequest) => {
  parentPort?.postMessage(matchLines(request));
});

/**
 * 逐行匹配：返回值只带行号，主线程按行号去原文里取文本。
 *
 * `limit` 是主线程还想要多少条命中。到线就停，不能把一份命中几千行的文件
 * 整包传回去 —— 那等于换了个地方堆内存。
 */
function matchLines({ id, text, pattern, flags, limit }: MatchRequest): MatchReply {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
  if (limit <= 0) return { id, lines: [] };

  const lines: number[] = [];
  let start = 0;
  for (let index = 0; ; index++) {
    const end = text.indexOf("\n", start);
    const line = end === -1 ? text.slice(start) : text.slice(start, end);
    // 每行都从 lastIndex = 0 开始：即使 g / y 标志漏进来，也不会因为上一行的残留而漏匹配。
    regex.lastIndex = 0;
    if (regex.test(line)) {
      lines.push(index + 1);
      if (lines.length >= limit) break;
    }
    if (end === -1) break;
    start = end + 1;
  }
  return { id, lines };
}

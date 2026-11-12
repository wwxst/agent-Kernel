/**
 * 文件目的：把「按正则逐行搜索」这件可能算到卡死的事，挪到副线程里跑。
 *
 * 搜索规则是模型给的，有些规则（灾难性回溯）会让电脑算到卡死。限制文件大小没用 ——
 * 卡住它的是规则本身，不是文件有多大。放进副线程，主程序掐表，超时就把这条线程整个扔掉，
 * 自己继续干活。
 *
 * 文件职责：负责在副线程里逐行匹配，只回传命中行号。
 * 不负责读文件、不负责拼结果文本、不负责超时判断 —— 那些都在 `tools/workspace.ts` 的主线程侧。
 *
 * 内容目录：
 *   - `matchLines()`：逐行匹配，只回传命中行号。
 *   - 消息协议：主线程发 `{ id, text, pattern, flags, limit }`，本线程回 `{ id, lines }` 或 `{ id, error }`。
 *
 * 模块关系：只依赖 `node:worker_threads`，不认识项目里任何模块。
 * 由 `tools/workspace.ts` 用 `new Worker(new URL("./grep-worker.ts", import.meta.url))` 起线程。
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

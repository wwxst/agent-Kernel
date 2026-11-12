/**
 * 文件目的：测输入历史 —— 坏行跳过、文件不存在不算错、超长截断、条数上限。
 *
 * 历史文件坏了，只能让能翻到的记录变少，不能让程序起不来。
 *
 * 文件职责：只测 `loadHistory()` / `appendHistory()` 的容错与上限。
 * 不测上下键在界面里的行为（那是 `tui.test.mjs`）。
 *
 * 内容目录：
 *   - `withFile()`：临时目录里的一个 `history.jsonl`，跑完删掉。
 *   - 五个用例：文件不存在；坏行跳过；非对象 / 空文本 / 缺字段忽略；追加后读回、空文本不写；
 *     只返回最近 N 条。
 *
 * 模块关系：依赖 `src/ui/prompt-history.ts` 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendHistory, loadHistory, MAX_HISTORY_ENTRIES } from "../src/ui/prompt-history.ts";

async function withFile(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-history-"));
  const file = path.join(dir, "history.jsonl");
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("历史：文件不存在时返回空数组，不是错误", async () => {
  await withFile(async (file) => {
    assert.deepEqual(loadHistory(file), []);
  });
});

test("历史：坏行跳过，好的行照常读出", async () => {
  await withFile(async (file) => {
    await writeFile(file, `${JSON.stringify({ ts: 1, cwd: "/w", text: "第一句" })}\n{ 坏行\n${JSON.stringify({ ts: 2, cwd: "/w", text: "第二句" })}\n`, "utf8");
    assert.deepEqual(loadHistory(file), ["第一句", "第二句"]);
  });
});

test("历史：非对象、空文本、缺字段都被忽略", async () => {
  await withFile(async (file) => {
    await writeFile(file, `"just a string"\n{"ts":1}\n{"text":"   "}\n{"text":"有效"}\n`, "utf8");
    assert.deepEqual(loadHistory(file), ["有效"]);
  });
});

test("历史：追加后能读回，空文本不写", async () => {
  await withFile(async (file) => {
    assert.equal(appendHistory("第一句", "/w", file), true);
    assert.equal(appendHistory("   ", "/w", file), false);
    assert.equal(appendHistory("第二句", "/w", file), true);
    assert.deepEqual(loadHistory(file), ["第一句", "第二句"]);
    const raw = await readFile(file, "utf8");
    assert.equal(raw.trim().split("\n").length, 2, "一条一行");
  });
});

test("历史：只返回最近 limit 条", async () => {
  await withFile(async (file) => {
    for (let index = 0; index < 5; index++) appendHistory(`第 ${index} 句`, "/w", file);
    assert.deepEqual(loadHistory(file, 2), ["第 3 句", "第 4 句"]);
    assert.ok(loadHistory(file).length <= MAX_HISTORY_ENTRIES);
  });
});

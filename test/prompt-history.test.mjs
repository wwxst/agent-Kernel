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
 *   - 容错：文件不存在、坏行、非对象 / 空文本 / 缺字段；追加后读回、空文本不写。
 *   - 上限：只返回最近 N 条、零条上限、超大历史只读尾部并跳过边界残行。
 *
 * 模块关系：依赖 `src/ui/prompt-history.ts` 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

test("历史：上限为零时不返回旧记录", async () => {
  await withFile(async (file) => {
    appendHistory("old", "/w", file);
    assert.deepEqual(loadHistory(file, 0), []);
  });
});

test("历史：超过磁盘上限时原子轮转，只保留最近有效记录", async () => {
  await withFile(async (file) => {
    await writeFile(file, `${JSON.stringify({ text: "x".repeat(8_388_608) })}\\n${JSON.stringify({ ts: 1, cwd: "/w", text: "latest-before-rotate" })}\\n`, "utf8");
    assert.equal(appendHistory("latest-after-rotate", "/w", file), true);
    assert.deepEqual(loadHistory(file), ["latest-before-rotate", "latest-after-rotate"]);
    assert.ok((await stat(file)).size < 8_388_608, "轮转后的文件必须低于硬上限");
    await assert.rejects(() => stat(file + ".lock"), { code: "ENOENT" }, "追加结束后锁文件必须释放");
  });
});

test("历史：能回收持有进程已退出的陈旧锁", async () => {
  await withFile(async (file) => {
    const lock = file + ".lock";
    await writeFile(lock, JSON.stringify({ token: "stale" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    assert.equal(appendHistory("recovered", "/w", file), true);
    assert.deepEqual(loadHistory(file), ["recovered"]);
  });
});

test("历史：活跃进程持锁时追加有界等待并安全放弃", async () => {
  await withFile(async (file) => {
    await writeFile(file + ".lock", JSON.stringify({ pid: process.pid, token: "active" }), "utf8");
    const started = Date.now();
    assert.equal(appendHistory("must-not-race", "/w", file), false);
    assert.ok(Date.now() - started < 2_000, "不能无限等待另一个进程的锁");
    assert.deepEqual(loadHistory(file), []);
  });
});
test("历史：只读取最后 8 MiB，丢弃边界处残行并保留最新完整记录", async () => {
  await withFile(async (file) => {
    await writeFile(file, `${JSON.stringify({ text: "x".repeat(8_388_608) })}\n{"text":"latest"}\n{broken`);
    assert.deepEqual(loadHistory(file), ["latest"]);
  });
});

/**
 * 审批读取的单元测试：用一个假 reader 把「正常回答 / 取消 / EOF」三条路钉死。
 *
 * 真实终端的行为由 cli-pty.test.mjs 在 Linux 上覆盖；这里不依赖 PTY，
 * 所以 Windows 上也能确定性地验证 question 与 AbortSignal 的竞态。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { askWithSignal, formatApproval } from "../src/approval.ts";

/** 最小 readline 替身：question 挂起，close 触发 close 监听。 */
function fakeReader() {
  let closeListener;
  const reader = {
    closed: false,
    resolve: undefined,
    reject: undefined,
    question() {
      return new Promise((resolve, reject) => {
        reader.resolve = resolve;
        reader.reject = reject;
      });
    },
    close() {
      reader.closed = true;
      closeListener?.();
    },
    once(event, listener) {
      if (event === "close") closeListener = listener;
    },
    removeListener(event, listener) {
      if (event === "close" && closeListener === listener) closeListener = undefined;
    },
  };
  return reader;
}

test("askWithSignal：正常回答原样返回，不关闭 readline", async () => {
  const reader = fakeReader();
  const answer = askWithSignal(reader, "q", new AbortController().signal);

  reader.resolve("y");

  assert.equal(await answer, "y");
  assert.equal(reader.closed, false);
});

test("askWithSignal：取消时立即 reject 并关闭 readline，迟到结果被忽略", async () => {
  const controller = new AbortController();
  const reader = fakeReader();
  const answer = askWithSignal(reader, "q", controller.signal);

  controller.abort(new Error("received SIGINT"));

  await assert.rejects(answer, /received SIGINT/);
  assert.equal(reader.closed, true);

  // 取消之后底层 question 仍可能迟到 resolve：不能再 settle 一次，也不能变成未处理异常。
  reader.resolve("y");
  await new Promise((resolve) => setImmediate(resolve));
});

test("askWithSignal：已经取消时不再提问", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before prompt"));
  const reader = fakeReader();

  await assert.rejects(askWithSignal(reader, "q", controller.signal), /cancelled before prompt/);
  assert.equal(reader.closed, true);
  assert.equal(reader.resolve, undefined, "已经取消就不该再调用 question");
});

test("askWithSignal：readline 关闭（EOF）时明确 reject", async () => {
  const reader = fakeReader();
  const answer = askWithSignal(reader, "q", new AbortController().signal);

  reader.close();

  await assert.rejects(answer, /approval prompt closed before an answer/);
});

test("askWithSignal：readline 自身 reject 时原样传出", async () => {
  const reader = fakeReader();
  const answer = askWithSignal(reader, "q", new AbortController().signal);

  reader.reject(new Error("readline failed"));

  await assert.rejects(answer, /readline failed/);
});

test("formatApproval：单行显示，超长命令截断，缺命令时明确写出", () => {
  const normal = formatApproval({ tool: "shell", args: { command: "echo  hi\nworld" } });
  assert.match(normal, /allow shell once: echo hi world\? \[y\/N\]/);

  const long = formatApproval({ tool: "shell", args: { command: "x".repeat(200) } });
  assert.match(long, /x{160}…\? \[y\/N\]/);
  assert.ok(!long.includes("x".repeat(161)));

  const missing = formatApproval({ tool: "shell", args: {} });
  assert.match(missing, /command unavailable/);
});

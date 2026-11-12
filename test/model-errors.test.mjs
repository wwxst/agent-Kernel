/**
 * 文件目的：测错误分类 —— 配置错、网络错、服务端错、流式中断，必须靠类型分清，
 * 不能靠猜错误文字里有没有某个词。
 *
 * 文件职责：只测 `modelFailure()` 的分类与建议、`isRetryableModelError()` 的重试口径。
 * 不测真实 HTTP 行为（那是 `llm.test.mjs`）、不测界面怎么显示。
 *
 * 内容目录：
 *   - 用例一：八种错误各自的标题与建议；技术详情保留原文；未识别的错误返回 `undefined`。
 *   - 用例二：404 不能武断说成「模型名不存在」，建议里要同时提 `MODEL` 与 `BASE_URL`。
 *   - 用例三：可重试与不可重试两张清单，鉴权、404、SSE 残缺一律不许重放。
 *
 * 模块关系：依赖 `src/protocol/errors.ts` 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatResponseError, ModelConfigError, ModelConnectionError, ModelHttpError,
  isRetryableModelError, modelFailure,
} from "../src/protocol/errors.ts";

test("模型错误分类：缺配置、鉴权、404、网络和 SSE 未完成各有对应建议", () => {
  const cases = [
    [new ModelConfigError("missing API_KEY"), "未配置模型", "Model not configured"],
    [new ModelHttpError(401, "bad token"), "模型认证失败", "Model authentication failed"],
    [new ModelHttpError(403, "denied"), "模型认证失败", "Model authentication failed"],
    [new ModelHttpError(404, "not found"), "模型服务不可用", "Model service unavailable"],
    [new ModelHttpError(429, "rate limit"), "模型服务不可用", "Model service unavailable"],
    [new ModelConnectionError("connection refused"), "模型服务不可用", "Model service unavailable"],
    [new ChatResponseError("stream ended", undefined, "stream_incomplete"), "模型服务不可用", "Model service unavailable"],
    [new ChatResponseError("invalid body"), "模型服务不可用", "Model service unavailable"],
  ];
  for (const [error, zh, en] of cases) {
    assert.equal(modelFailure(error, "zh")?.title, zh);
    assert.equal(modelFailure(error, "en")?.title, en);
    assert.equal(modelFailure(error, "en")?.detail, error.message, "技术错误原文保留");
    assert.ok(modelFailure(error, "zh")?.advice, "每个已识别错误都应给解决方向");
  }
  assert.match(modelFailure(new ChatResponseError("bad stream"), "zh")?.advice ?? "", /已作废/);
  assert.match(modelFailure(new ChatResponseError("bad stream"), "en")?.advice ?? "", /discarded/);
  assert.equal(modelFailure(new Error("tool failed"), "zh"), undefined);
});

test("404 不能武断判断一定是模型名不存在", () => {
  const failure = modelFailure(new ModelHttpError(404, "path not found"), "zh");
  assert.match(failure.advice, /MODEL/);
  assert.match(failure.advice, /BASE_URL/);
  assert.match(failure.advice, /无法单独确定/);
});

test("自动恢复只处理真实网络/暂时 HTTP 错误，不重试鉴权、404 或 SSE 残缺", () => {
  for (const error of [
    new ModelConnectionError("fetch failed"),
    new ModelHttpError(408, "timeout"),
    new ModelHttpError(429, "rate limit"),
    new ModelHttpError(500, "server"),
    new ModelHttpError(503, "overloaded"),
  ]) assert.equal(isRetryableModelError(error), true);
  for (const error of [
    new ModelConfigError("missing key"),
    new ModelHttpError(401, "unauthorized"),
    new ModelHttpError(403, "forbidden"),
    new ModelHttpError(404, "bad model"),
    new ChatResponseError("stream ended", undefined, "stream_incomplete"),
    new ChatResponseError("invalid"),
  ]) assert.equal(isRetryableModelError(error), false);
});

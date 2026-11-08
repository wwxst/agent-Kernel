/** 模型配置、HTTP、网络和流式响应错误的展示类别必须由类型决定，不能靠字符串猜测。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatResponseError, ModelConfigError, ModelConnectionError, ModelHttpError,
  modelFailure,
} from "../src/errors.ts";

test("模型错误分类：缺配置、鉴权、404、网络和 SSE 未完成各有对应建议", () => {
  const cases = [
    [new ModelConfigError("missing API_KEY"), "尚未配置模型服务", "Model service is not configured"],
    [new ModelHttpError(401, "bad token"), "模型鉴权失败", "Model authentication failed"],
    [new ModelHttpError(403, "denied"), "模型鉴权失败", "Model authentication failed"],
    [new ModelHttpError(404, "not found"), "模型或接口地址不存在", "Model or endpoint not found"],
    [new ModelHttpError(429, "rate limit"), "模型服务请求失败", "Model service request failed"],
    [new ModelConnectionError("connection refused"), "无法连接模型服务", "Cannot connect to model service"],
    [new ChatResponseError("stream ended", undefined, "stream_incomplete"), "模型回复中断", "Model response interrupted"],
    [new ChatResponseError("invalid body"), "模型响应格式异常", "Invalid model response"],
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

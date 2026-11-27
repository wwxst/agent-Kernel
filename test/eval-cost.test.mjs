import assert from "node:assert/strict";
import test from "node:test";
import { estimateCost, validatePricingConfig } from "../eval/cost.mjs";

const config = validatePricingConfig({
  version: 1,
  currency: "USD",
  models: {
    "mock-model": {
      inputPerMillion: 2,
      outputPerMillion: 8,
      cachedInputPerMillion: 0.2,
    },
  },
});

test("费用估算：分别按普通输入、缓存输入和输出价格计算", () => {
  const cost = estimateCost({
    promptTokens: 1_000,
    completionTokens: 100,
    cachedPromptTokens: 400,
    cacheUsageUnknown: 0,
    unknown: 0,
  }, config, "mock-model");

  assert.deepEqual(cost, {
    currency: "USD",
    amount: 0.00208,
    complete: true,
    coverage: "complete",
  });
});

test("费用估算：没有价格表时不猜测费用或币种", () => {
  const cost = estimateCost({ promptTokens: 100, completionTokens: 10 }, undefined, "mock-model");
  assert.equal(cost.amount, null);
  assert.equal(cost.currency, null);
});

test("费用估算：模型没有配置价格时不套用其他模型价格", () => {
  const cost = estimateCost({ promptTokens: 100, completionTokens: 10 }, config, "other-model");
  assert.equal(cost.amount, null);
  assert.equal(cost.reason, "model_price_not_configured");
});

test("费用估算：usage 缺失时只报告已知请求小计，不冒充完整账单", () => {
  const cost = estimateCost({
    promptTokens: 1_000,
    completionTokens: 100,
    cachedPromptTokens: 0,
    cacheUsageUnknown: 0,
    unknown: 1,
  }, config, "mock-model");

  assert.equal(cost.complete, false);
  assert.equal(cost.coverage, "reported_requests_only");
  assert.equal(cost.unknownRequests, 1);
  assert.equal(cost.amount, 0.0028);
});

test("费用估算：缓存价格与普通输入相同时，缓存用量未知不影响费用准确性", () => {
  const sameRate = validatePricingConfig({
    version: 1, currency: "USD",
    models: { "mock-model": { inputPerMillion: 2, outputPerMillion: 8 } },
  });
  const cost = estimateCost({
    promptTokens: 1_000, completionTokens: 100, cachedPromptTokens: 0,
    cacheUsageUnknown: 1, unknown: 0,
  }, sameRate, "mock-model");
  assert.equal(cost.complete, true);
  assert.equal(cost.amount, 0.0028);
});

test("费用估算：缓存价格有折扣但缓存 Token 未知时拒绝估算", () => {
  const cost = estimateCost({
    promptTokens: 1_000,
    completionTokens: 100,
    cachedPromptTokens: 0,
    cacheUsageUnknown: 1,
    unknown: 0,
  }, config, "mock-model");

  assert.equal(cost.amount, null);
  assert.equal(cost.reason, "cache_usage_unknown");
});

test("费用估算：金额使用价格表声明的币种，不固定标成美元", () => {
  const cny = validatePricingConfig({
    version: 1, currency: "CNY",
    models: { "mock-model": { inputPerMillion: 2, outputPerMillion: 8 } },
  });
  const cost = estimateCost({
    promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 0,
    cacheUsageUnknown: 0, unknown: 0,
  }, cny, "mock-model");
  assert.deepEqual(cost, {
    currency: "CNY", amount: 2, complete: true, coverage: "complete",
  });
});

test("价格配置：拒绝负数、NaN 和缺少必需费率", () => {
  for (const rate of [-1, NaN, Infinity, "2"]) {
    assert.throws(() => validatePricingConfig({
      version: 1, currency: "USD",
      models: { model: { inputPerMillion: rate, outputPerMillion: 1 } },
    }), /pricing rate inputPerMillion/);
  }
  assert.throws(() => validatePricingConfig({
    version: 1, currency: "USD", models: { model: { inputPerMillion: 1 } },
  }), /pricing rate outputPerMillion/);
});

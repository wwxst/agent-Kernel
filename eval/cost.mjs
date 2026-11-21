/**
 * 评测费用估算。只按用户提供的模型价格表计算，不内置或猜测服务商价格。
 * 没有价格、缓存用量不完整或请求 usage 缺失时，明确标记为不完整。
 */
import { readFile } from "node:fs/promises";

export function validatePricingConfig(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new Error("pricing config.version must be a positive integer");
  }
  if (typeof value.currency !== "string" || value.currency.trim() === "") {
    throw new Error("pricing config.currency must be a non-empty string");
  }
  if (!isRecord(value.models)) throw new Error("pricing config.models must be an object");

  const models = {};
  for (const [model, raw] of Object.entries(value.models)) {
    if (model.trim() === "" || !isRecord(raw)) throw new Error("pricing model entries must be objects with non-empty names");
    const rates = {
      inputPerMillion: readRate(raw, "inputPerMillion", true),
      outputPerMillion: readRate(raw, "outputPerMillion", true),
    };
    const cached = readRate(raw, "cachedInputPerMillion", false);
    if (cached !== undefined) rates.cachedInputPerMillion = cached;
    models[model] = rates;
  }

  return { version: value.version, currency: value.currency, models };
}

export async function loadPricingConfig(filePath) {
  if (filePath === undefined || filePath === null || filePath === "") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read pricing config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validatePricingConfig(parsed);
}

/**
 * amountUsd 是已知请求的估算小计；complete=false 时不能当作整轮真实账单。
 * 缓存价格与普通输入价格不同时，如果有请求未报告缓存用量，就拒绝给出金额。
 */
export function estimateCost(usage, config, model) {
  const rates = config?.models?.[model] ?? config?.models?.["*"];
  if (rates === undefined) {
    return {
      currency: config?.currency ?? "USD",
      amountUsd: null,
      complete: false,
      reason: config === undefined ? "pricing_not_configured" : "model_price_not_configured",
    };
  }

  const promptTokens = usage.promptTokens ?? usage.prompt_tokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.completion_tokens ?? 0;
  const cachedPromptTokens = usage.cachedPromptTokens ?? usage.cached_prompt_tokens ?? 0;
  const unknownRequests = usage.unknown ?? usage.unknownResponses ?? 0;
  const cacheUsageUnknown = usage.cacheUsageUnknown ?? 0;
  if (cachedPromptTokens > promptTokens) {
    return { currency: config.currency, amountUsd: null, complete: false, reason: "cached_tokens_exceed_prompt_tokens" };
  }

  const cachedRate = rates.cachedInputPerMillion ?? rates.inputPerMillion;
  if (cacheUsageUnknown > 0 && cachedRate !== rates.inputPerMillion) {
    return { currency: config.currency, amountUsd: null, complete: false, reason: "cache_usage_unknown" };
  }

  const uncachedPromptTokens = promptTokens - cachedPromptTokens;
  const amountUsd = (
    uncachedPromptTokens * rates.inputPerMillion +
    cachedPromptTokens * cachedRate +
    completionTokens * rates.outputPerMillion
  ) / 1_000_000;

  return {
    currency: config.currency,
    amountUsd: Number(amountUsd.toFixed(10)),
    complete: unknownRequests === 0 && cacheUsageUnknown === 0,
    coverage: unknownRequests > 0 ? "reported_requests_only" : "complete",
    ...(unknownRequests > 0 ? { unknownRequests } : {}),
    ...(cacheUsageUnknown > 0 ? { cacheUsageUnknown } : {}),
    ...((unknownRequests > 0 || cacheUsageUnknown > 0)
      ? { reason: "some_usage_details_are_unknown" }
      : {}),
  };
}

function readRate(record, field, required) {
  const value = record[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`pricing rate ${field} must be a non-negative finite number`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

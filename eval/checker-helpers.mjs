/**
 * 文件目的：把任务工作区里「文件不存在 / 模块无法加载 / JSON 无效」转换成断言失败。
 *
 * 为什么需要：这些通常是 Agent 没完成任务，不是评测检查器自身坏了。
 * 如果直接把 ENOENT、ERR_MODULE_NOT_FOUND 或 JSON SyntaxError 抛出去，
 * selfcheck 会把任务失败误分类成 INFRA。
 *
 * 文件职责：提供三个很小的读取辅助函数，不负责判定任务业务行为。
 * 模块关系：由 eval/tasks/<task>/check.mjs 使用；不依赖 src/，不启动模型。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readTaskFile(file, label = path.basename(file)) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") assert.fail(`${label} 不存在`);
    throw error;
  }
}

export async function readTaskJson(file, label = path.basename(file)) {
  const source = await readTaskFile(file, label);
  try {
    return JSON.parse(source);
  } catch (error) {
    assert.fail(`${label} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function importTaskModule(url, label) {
  try {
    return await import(url);
  } catch (error) {
    assert.fail(`${label} 无法加载：${error instanceof Error ? error.message : String(error)}`);
  }
}

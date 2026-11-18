/**
 * 文件目的：让模型请求的实际形状和上下文预算使用同一套工具说明与默认输出额度。
 * 文件职责：将内部工具说明编码为请求字段；网络发送归 Llm，窗口估算归 Core。
 * 内容目录：
 *   - encodeToolDefinitions：只保留可发送的字段，无工具时省略整个字段。
 *   - DEFAULT_MAX_OUTPUT_TOKENS：模型默认输出上限，也是窗口默认预留。
 * 模块关系：只依赖协议类型，供模型客户端、Core 和 CLI 使用。
 */
import type { ToolDefinition } from "./types.ts";

export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export function encodeToolDefinitions(tools: readonly ToolDefinition[]) {
  if (tools.length === 0) return undefined;
  return tools.map(({ name, description, parameters }) => ({
    type: "function" as const,
    function: { name, description, parameters },
  }));
}

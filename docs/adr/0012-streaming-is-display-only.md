# 流式输出：SSE 增量只用于显示

`Llm` 支持 SSE 流式响应。CLI 默认打开它，评测与非交互调用保持非流式。

## 决定

- `LlmOptions.stream` 默认 **false**；打开后请求带 `stream: true` 和 `stream_options: { include_usage: true }`。
- `chat(messages, tools, { onDelta })` 把**正文**增量交给回调；回调只负责显示，不参与拼装。
- 流式 chunk 由 `StreamAssembly` 还原成一条完整 Message：正文拼接、`reasoning_content` 拼接、`tool_calls` 按 `index` 合并 `id / name / arguments`，`finish_reason` 取最后一帧。
- 拼装结果最后仍交给 `readMessage`：`stop` 与 `tool_calls` 的一致性、id 唯一性、`length` / `content_filter` 的拒绝，流式与非流式共用同一套判定。
- usage 从 `choices` 为空的最后一帧读；读不到就是未知，不补 0。
- 连接在收到 `finish_reason` 之前断掉 → 报错「stream ended before the model finished」，不把半截正文当成完整回复。

## 理由

交互式 CLI 里，模型一开口就能看到字，长回复不再是一段黑屏。把增量限制在「显示」这一侧，是不让流式改变内核的原因：Agent 的消息顺序、工具配对、预算与账单都只看最终返回的 Message，回调晚到或漏掉都不影响正确性。

评测保持非流式：跨天/基线要的是可复现的完整响应，SSE 的分片与网络时序只会引入新的方差。

## 代价与风险

- 依赖端点的 `stream_options.include_usage`；不支持的端点可能直接 400。评测不打开流式，所以基准不受影响；CLI 遇到这种端点会明确报 HTTP 错误。
- `reasoning_content` 也会分片到达：这边只累积、不回显，但必须原样回传（请求带 tools 时缺了它会 400），所以拼装时不能只挑正文。
- `tool_calls` 的分片格式各端点略有差异（name 是否重复发送）；`mergeFragment` 处理了「重复发完整名字」这一种，但不能覆盖所有历史写法。
- 流式失败时可能已经打印了半段文字：CLI 会把错误打在它后面，不会假装成功。

## 不变量

- 显示与正确性分离：`onDelta` 不是消息来源，最终 Message 永远以拼装 + `readMessage` 的结果为准。
- 没有 `finish_reason` 的流不算完成；`length` / `content_filter` 不算成功。
- usage 缺失仍然记 unknown，流式不改变「账单未知就是未知」这条口径。

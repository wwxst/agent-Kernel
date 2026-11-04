# 字段名沿用协议原文，不翻译成驼峰

**Message** 和 **Tool call** 在 TypeScript 里也用 `tool_calls`、`tool_call_id` 这些下划线字段名，不转换成驼峰。

理由：请求体可以原样 `JSON.stringify`，少一层双向映射就少一类「翻译错了但没人发现」的 bug。代价是局部命名和仓库其余部分的 camelCase 不一致；改回驼峰意味着每次请求和响应都要多走一道翻译层。

# 运行时零依赖

生产代码只用 Node 内置的 `fetch`、`fs/promises` 和 `child_process`，不引入模型 SDK 或 agent 框架。

理由：这个仓库的用途是被完整读懂，依赖越少越好；而 OpenAI 兼容端点已经是最小公分母，换供应商只需要改 `BASE_URL`。代价是协议细节要自己维护（比如把 `content: null` 归一成空串）。

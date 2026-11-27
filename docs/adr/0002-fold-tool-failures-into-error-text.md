# 工具失败折成 ERROR 文本，不抛异常

工具名不存在、参数不是合法 JSON、工具自身抛错，一律折成一条以 `ERROR: ` 开头的 **Tool result** 回灌给模型。

理由：抛异常会终止整个 **Run**，用户得从头再来；文本回灌则让模型在下一个 **Step** 自己纠正（换个路径、改个参数）。代价是宿主代码不能靠 `try/catch` 感知工具失败 —— 需要感知时看文本前缀。

## 补充（2026-11-27）

文本折叠的决定对模型仍然成立：工具失败仍以结果文本回灌，不抛进 **agent loop**。但宿主侧代码不得再嗅探文本前缀来判断成败 —— `ToolRegistry.executeWithStatus()` 返回的 `isError` 是唯一权威信号，见 [ADR-0033](./0033-tool-failure-is-explicit.md)。`isToolResultFailure()` 里对 `shell` 原始文本的兜底只为拿不到宿主状态的旧调用方保留，不是第二套契约。

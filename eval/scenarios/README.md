# 离线专项场景

这些场景使用假模型和真实 Agent / ToolRegistry，不调用外部 API、不产生模型费用。它们补充真实模型任务集，专门验证内核机制。

| 场景 | 验证内容 |
| --- | --- |
| context-compaction | 长对话触发历史压缩，摘要成功后任务仍能完成 |
| serial-tool-batch | 同一回复中的多工具调用严格按顺序执行 |
| tool-error-feedback | 工具失败状态回传给模型，模型能据此继续完成任务 |

运行：npm run eval:scenarios。场景结果是内核行为证据，不代表真实模型在所有任务上的成功率。

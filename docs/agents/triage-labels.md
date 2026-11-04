# 分诊标签

技能按五个标准角色说话。本仓库用本地 markdown 做 tracker，角色体现在工单文件顶部那行 `Status:` 上。

| 技能里的角色 | 本仓库的 `Status:` 取值 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 待维护者评估 |
| `needs-info` | `needs-info` | 等报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已写清，agent 可独立开工 |
| `ready-for-human` | `ready-for-human` | 需要人来实现 |
| `wontfix` | `wontfix` | 不处理 |

技能提到某个角色时（例如「打上 AFK-ready 标签」），用上表对应的取值。

改词表就改「本仓库的 `Status:` 取值」这一列。

# 17 课课程资料

> **定位：研究路线 / 设计参考。不是当前功能清单。**

这里保存“Agent 内核设计课程：一个循环，贯穿十七课”的整理稿。

课程的核心观点是：

> **Agent 的核心循环尽量保持稳定，其他能力围绕这个循环逐步扩展。**

课程从 Agent Loop 开始，一路讨论 Tool、Permission、Hooks、TodoWrite、Subagent、Skill Loading、Context Compact、Memory、Task System、Background Tasks、Cron、Agent Teams、MCP、Integrated Harness、Workflow Runtime 和 Goal Loop。

完整整理稿：

- [agent-kernel-course.md](./agent-kernel-course.md)

## 这份资料怎么用

正确用法是：

~~~text
课程提出一个能力
    ↓
看当前 agent-Kernel 是否真的需要
    ↓
研究 Claude / Codex / DeepSeek Harness / Pi 等实际实现
    ↓
形成自己的设计
    ↓
必要时写 ADR
    ↓
实现 + 测试 + eval
~~~

不要直接把课程代码搬进内核，也不要因为课程有第 10、12、13、16、17 课，就默认当前项目必须马上实现 Task、Cron、Teams、Workflow、Goal Loop。

课程整理稿本身也注明：其中代码片段来自图片转录/归纳，部分细节可能不完整，不能直接视为可运行实现；具体实现应该以对应源码仓库为准。

## 当前实现和课程的关系

| 课程方向 | 当前仓库处理方式 |
| --- | --- |
| Agent Loop | 已是 Core 的基础 |
| Tool Use | 已实现 Tool Registry + 内置 Tool |
| Permission | 研究过，但当前选择只保留 Full Access |
| Hooks | 已实现 Tool Hooks |
| TodoWrite | 已实现 Session-local Todo |
| Subagent | 已实现 |
| Skill Loading | 已实现按需加载 |
| Context Compact | 当前已有基础的有界 Transcript 压缩；更复杂方案要单独验证 |
| Memory | 当前没有独立 Memory System |
| Task System | 当前没有持久化 Task System |
| Background Tasks | 已实现 Shell background job |
| Cron | 当前没有 Cron Scheduler |
| Agent Teams | 当前没有 Teams Runtime |
| MCP | 当前没有 MCP Runtime |
| Integrated Harness | 当前以 CLI + Core + Tools + Model + UI 组合运行 |
| Workflow | 当前没有独立 Workflow Runtime |
| Goal Loop | 当前没有独立 Goal Evaluator |

这里的“已实现”只表示当前代码有对应能力，不代表课程实现方式原样照搬。
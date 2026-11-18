# ADR：架构决策记录

ADR（Architecture Decision Record）只记录那些以后很可能会被问到“为什么这么做”的决定。

一条 ADR 主要回答四个问题：

1. 当时遇到了什么问题？
2. 最终选择了什么？
3. 为什么没有选其他方案？
4. 这个选择带来了什么代价和不变量？

## 当前有效的重要决定

| ADR | 当前结论 |
| --- | --- |
| [0001](./0001-keep-wire-field-names.md) | 保留线上协议字段名，避免无意义转换 |
| [0002](./0002-fold-tool-failures-into-error-text.md) | Tool 普通失败折成 `ERROR` 文本交回模型 |
| [0003](./0003-run-tool-calls-serially.md) | 一批 Tool call 串行执行 |
| [0004](./0004-zero-runtime-dependencies.md) | 运行时保持零第三方依赖 |
| [0005](./0005-name-tools-after-the-ecosystem.md) | Tool 名称尽量采用生态通用叫法 |
| [0008](./0008-trusted-local-agent.md) | 这是开发者机器上的受信任本地 Agent |
| [0011](./0011-agent-can-run-many-times.md) | 一个 Agent Session 可以连续跑多个 Run |
| [0012](./0012-streaming-is-display-only.md) | 流式只影响展示，不改变核心消息结果 |
| [0017](./0017-tui-renders-on-main-screen.md) | TUI 主屏追加，transcript 再用备用屏 |
| [0019](./0019-full-access-is-the-only-mode.md) | 当前只保留 Full Access |
| [0020](./0020-tool-hooks-live-in-the-registry.md) | Hook 挂在唯一 ToolRegistry 执行入口 |
| [0021](./0021-tool-log-is-opt-in.md) | 工具日志默认关闭，显式设置才启用 |
| [0024](./0024-todo-write-is-session-local.md) | TodoWrite 只属于当前 Session |
| [0025](./0025-subagent-uses-fresh-agent-instance.md) | Subagent 使用独立 Agent 实例和上下文 |
| [0027](./0027-background-job-lifecycle.md) | 后台任务用独立日志文件管理生命周期 |
| [0028](./0028-skills-are-files-read-on-demand.md) | Skill 目录进入提示，正文按需用 `read` 读取 |
| [0029](./0029-context-compaction-is-bounded-and-recoverable.md) | 上下文压缩有界、可追溯，失败不提交 |

目录里还有其他当前有效 ADR；上表只列最影响整体架构的决定。

## 已被取代的决定

这些 ADR 保留是为了说明历史，而不是当前实现：

| ADR | 现在以什么为准 |
| --- | --- |
| [0013](./0013-permission-is-a-policy-not-a-sandbox.md) | [0019](./0019-full-access-is-the-only-mode.md) |
| [0014](./0014-tui-is-a-lightweight-shell.md) | [0017](./0017-tui-renders-on-main-screen.md) 及当前代码 |
| [0015](./0015-tui-v0.2-chat-interface.md) | [0017](./0017-tui-renders-on-main-screen.md) 及当前代码 |
| [0016](./0016-tui-v0.3-top-down-layout.md) | [0017](./0017-tui-renders-on-main-screen.md) 及当前代码 |
| [0018](./0018-project-permission-rules.md) | [0019](./0019-full-access-is-the-only-mode.md) |

被取代的 ADR 不删除。它们解释历史选择，但不能用来证明当前代码仍然支持旧机制。

## 怎么新增 ADR

只有满足下面条件才值得新增：

- 这是一个架构或长期行为决定。
- 半年以后可能还会有人问“为什么”。
- 选择有明显的取舍。
- 这个选择会影响后续开发方式。

普通 Bug 修复、变量改名、单个测试补充、UI 小文案调整，一般不用写 ADR。

## ADR 和其他文档的区别

- README：告诉第一次来的人项目是什么。
- architecture：告诉现在代码怎么工作。
- ADR：告诉为什么这么设计。
- GLOSSARY：统一词汇。
- eval：用真实任务证明行为。

不要把一份 ADR 写成教程，也不要把源码逐行抄进 ADR。
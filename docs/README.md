# 文档导航

如果第一次看项目，先看 [README.md](../README.md)。

## 我想……

### 第一次认识项目

- [README](../README.md)：项目是什么、为什么做、怎么跑。

### 理解 Agent 怎么工作

- [当前架构](./architecture.md)：Core、Transcript、Tool、Hook、Subagent、Skill、Model、UI 的真实关系。

### 把 Agent 跑起来

- [配置与启动](./configuration.md)：环境变量、CLI 参数、工作区、预算。

### 了解 TUI

- [TUI](./tui.md)：当前交互方式、快捷键和展示边界。

### 想知道为什么这样设计

- [ADR](./adr/)：架构决定、理由、代价和不变量。

### 想研究完整的 Agent 能力路线

- [17 课课程资料](./course/)：研究路线和设计参考。

### 想改代码

- [研发流程](./development-workflow.md)：任务分类、方案确认、实现、验证、Review 和交付。
- [Spec 模板](./agents/spec-template.md)：新功能和架构改造的设计、范围与验收模板。
- [本地任务管理](./agents/issue-tracker.md)：`.scratch/` 的 Spec 和任务拆分约定。
- [AGENTS.md](../AGENTS.md)：AI / 开发者执行规则。
- [CODING_STANDARDS.md](../CODING_STANDARDS.md)：编码规范。
- [GLOSSARY.md](../GLOSSARY.md)：统一术语。

### 想看行为契约

- [docs/contracts/](./contracts/)：行为验证和长期契约。

### 想知道 Agent 到底好不好用

- [eval/README.md](../eval/README.md)：评测方法。
- [eval/baseline.md](../eval/baseline.md)：历史基线。
- [docs/eval-diagnostics.md](./eval-diagnostics.md)：固定基线和诊断。

## 文档怎么分工

| 文件 / 目录 | 负责什么 |
| --- | --- |
| `README.md` | 项目首页 |
| `docs/README.md` | 文档导航 |
| `docs/architecture.md` | 当前真实架构 |
| `docs/configuration.md` | 配置和启动 |
| `docs/tui.md` | TUI 使用和设计边界 |
| `docs/development-workflow.md` | 研发流程 |
| `docs/agents/spec-template.md` | 功能设计模板 |
| `docs/design/` | 稳定设计原则 |
| `docs/contracts/` | 行为契约 |
| `docs/adr/` | 为什么这么设计 |
| `docs/course/` | 研究课程，不代表当前实现 |
| `AGENTS.md` | AI / 开发者怎么改 |
| `CODING_STANDARDS.md` | 代码怎么写 |
| `GLOSSARY.md` | 术语怎么统一 |
| `eval/` | Agent 实际表现 |

## 一个硬规则：课程不是实现

课程里讲到的能力，不会自动进入 agent-Kernel。

必须经过：

~~~text
研究
 ↓
当前需求判断
 ↓
设计
 ↓
实现
 ↓
测试
 ↓
eval
 ↓
成为当前能力
~~~

所以判断当前项目“有没有某个功能”，永远先看当前代码和当前架构文档，不看课程目录。

## 文档可信顺序

发生冲突时按这个顺序检查：

1. 当前代码。
2. 当前架构文档。
3. `AGENTS.md` / `CODING_STANDARDS.md`。
4. 当前有效 ADR。
5. README。
6. 历史 ADR、课程和其他研究资料。

历史资料可以解释“为什么走到今天”，但不能覆盖当前实现。
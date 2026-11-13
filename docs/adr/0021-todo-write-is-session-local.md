# ADR-0021：TodoWrite 是会话内计划，不是持久任务系统

- 状态：已采纳（2026-11-13）
- 影响范围：`src/tools/todo.ts`、`src/core/tool-registry.ts`、`src/cli.ts`、测试和文档

## 背景

Agent 接到复杂任务时，直接调用工具容易忘记后续步骤。第 5 课要求执行前列计划，并更新 `pending`、`in_progress`、`done` 三种状态。现有九个工具依靠 `ToolRegistry.execute()` 统一做参数校验、Hooks 和错误回传，主循环不应该为计划功能改动。

## 决定

- `todo_write` 作为第十个工具，模型每次提交**完整**清单，原子替换当前计划。
- 最多 20 项、每项最长 200 字符，单行非空、不重复；最多一项 `in_progress`，未知状态拒绝，错误更新保留旧计划。「单行」按渲染结果算：C0/C1 控制字符（含 DEL、U+0085）与 Unicode 行/段分隔符（U+2028、U+2029）一律拒绝，不只是 `\n`。
- 统一的 `ToolRegistry` 增加嵌套 `array.items`、`object.properties`、`required` 校验；不假称支持其他 JSON Schema 关键字。
- 在 `createAgent()` 构造 `TodoManager`，同一会话的多个 Run 共享；`/reset` 或重启后清空。
- 复杂任务由系统提示引导使用，简单任务不强制，`done` 是模型报告而不是内核验收。

## 取舍与边界

第 10 课才做持久任务、依赖和恢复，第 17 课才做独立目标验收；本课不提前建设持久化、调度和常驻 TUI 面板。使用真正的嵌套 JSON Schema 而不是 JSON 字符串，保证参数校验在统一入口进行。增加的工具说明和计划更新会消耗少量 token 与工具调用预算；现有九个工具和 Agent Loop 行为不变。

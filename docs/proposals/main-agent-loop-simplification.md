# Main Agent Loop 精简重构提案

> 状态：待用户评审，未批准实施
> 类型：架构重构（仅调整 Core 内部职责边界）
> 目标仓库：wwxst/agent-Kernel
> 基线分支：main
> 基线提交：76a024a496a424614c47ebc6660c2b94ae6c347d
> 提案分支：docs/simplify-agent-loop-spec
> 创建日期：2026-11-21

## 1. 目标

整理 Main Agent Loop 的内部职责，让 Agent 继续作为主控制器，RunState 专门保存一次 Run 的状态和进展记录。

这次是一次小范围结构重构，不是修复已确认的运行故障，也不是重新设计 Agent 架构。

目标不是单纯减少 agent.ts 的行数，而是让状态归属更清楚、主执行流程更容易理解，同时保持现有行为不变。

## 2. 背景与当前问题

### 当前代码事实

以下结论以基线提交 76a024a496a424614c47ebc6660c2b94ae6c347d 为准。

1. src/core/agent.ts 当前为 786 行。Agent.run() 负责启动一次 Run，runLoop() 负责循环，requestStep() 负责模型请求，executeToolBatch() 负责一批工具调用。
2. agent.ts 内部的 RunState 位于约第 250–303 行，保存一次 Run 的请求数、重试数、上下文溢出重试数、工具调用数、Token 用量、assistant 回复，以及最近工具批次的无进展检测状态。
3. RunState 依赖的工具批次签名与结果比较逻辑，包括 canonicalizeJson、canonicalizeArguments、toolBatchSignature、sameToolResults，以及 MAX_IDENTICAL_TOOL_BATCHES，目前也在 agent.ts。
4. Agent 类持有 currentRun，并通过它读取预算、记录模型请求和工具调用、保存本轮回复及判断是否出现重复工具批次。
5. Session 级累计数据与 Run 级数据分开保存。sessionRequests、sessionToolCalls、sessionUsage、runCount 属于整个 Agent Session，不应误移入 RunState。
6. AgentUsage 是当前从 agent.ts 导出的公开类型；AgentStats、AgentSessionStats、AgentOptions 也在该文件中声明。
7. SessionContext 已独立负责 Transcript 与上下文准备、压缩和恢复；ToolRegistry 已独立负责工具注册、参数校验、执行及 Hook。

源码依据：

- [agent.ts：RunState 与工具批次判定](https://github.com/wwxst/agent-Kernel/blob/76a024a496a424614c47ebc6660c2b94ae6c347d/src/core/agent.ts#L250-L303)
- [agent.ts：Agent 的 Run / Session 状态](https://github.com/wwxst/agent-Kernel/blob/76a024a496a424614c47ebc6660c2b94ae6c347d/src/core/agent.ts#L305-L370)
- [agent.ts：公开快照与用量记账](https://github.com/wwxst/agent-Kernel/blob/76a024a496a424614c47ebc6660c2b94ae6c347d/src/core/agent.ts#L421-L520)
- [agent.ts：run、请求、工具批次与主循环](https://github.com/wwxst/agent-Kernel/blob/76a024a496a424614c47ebc6660c2b94ae6c347d/src/core/agent.ts#L545-L786)
- [当前架构文档](https://github.com/wwxst/agent-Kernel/blob/76a024a496a424614c47ebc6660c2b94ae6c347d/docs/architecture.md)

### 问题判断

已确认的问题是：Run 级状态数据、状态转移辅助逻辑和 Agent 的执行控制代码集中在同一个文件里，职责边界不够清楚。

目前没有证据证明主循环算法本身存在必须重写的缺陷，也没有证据证明拆成多个 Manager 能带来实际收益。

因此，本次只调整 RunState 的归属，不把普通的可维护性整理扩大成全面架构重构。

## 3. 本次范围

### 要做

- 新增 src/core/run-state.ts。
- 将 RunState 类整体迁移到新文件。
- 将只服务于 RunState 的工具批次规范化、签名、结果比较和重复阈值一并迁移。
- 将 AgentUsage 类型和空用量初始化函数放入 run-state.ts，避免新模块反向依赖 agent.ts。
- agent.ts 继续导出 AgentUsage，保持现有导入路径兼容。
- Agent 继续持有当前 RunState 实例，并负责创建、重置和协调它。
- 更新 AGENTS.md 的源码地图和 docs/architecture.md 中相关职责说明。
- 使用现有 Agent 与后台等待测试验证行为；如果发现覆盖缺口，再补最小回归测试。

### 明确不做

- 不重写 runLoop()。
- 不拆分 requestStep()、executeToolBatch() 为新的 Manager 或 Service。
- 不改变 Agent.run() 的公开行为。
- 不改变 AgentOptions、AgentStats、AgentSessionStats 的字段和语义。
- 不改变 Session / Run 生命周期。
- 不改变 Transcript 消息顺序、tool_call_id 配对和工具串行执行顺序。
- 不改变 Step、Tool Call、Token 预算。
- 不改变网络重试、上下文溢出恢复和取消行为。
- 不改变无进展检测规则和后台任务等待规则。
- 不修改 SessionContext、ToolRegistry、ChatClient、协议类型、Tool Schema、CLI、TUI、Subagent、Skill 或 Hook 的执行行为。
- 不增加第三方运行时依赖。
- 不在本次引入事件总线、状态机、Workflow、Goal Loop 或其他新的架构层。

## 4. 推荐方案

### 4.1 目标文件结构

~~~text
src/core/
├── agent.ts
│   ├── Agent 主控制器
│   ├── AgentOptions / AgentStats / AgentSessionStats
│   ├── Agent.run() 与 Session 生命周期
│   ├── runLoop()
│   ├── requestStep()
│   ├── executeToolBatch()
│   ├── 预算准入、取消和观察回调
│   └── Session 累计统计
│
├── run-state.ts
│   ├── AgentUsage 类型
│   ├── 空用量初始化函数
│   ├── RunState
│   ├── Run 级请求 / 重试 / 工具调用计数
│   ├── Run 级 Token 用量和回复列表
│   └── 工具批次签名、结果比较与无进展状态
│
├── session-context.ts
└── tool-registry.ts
~~~

只新增一个文件，不为每个方法单独建模块。

### 4.2 run-state.ts 负责什么

迁移以下现有内容，原则上保持算法和字段语义不变：

- RunState 的 requests、retries、overflowRetries、toolCalls。
- RunState 的 usage 和 replies。
- 最近工具批次记录、repetitions、allWaiting。
- recordToolBatch()。
- shouldStopToolBatch()。
- MAX_IDENTICAL_TOOL_BATCHES。
- canonicalizeJson()。
- canonicalizeArguments()。
- toolBatchSignature()。
- sameToolResults()。
- AgentUsage 类型与空用量初始化函数。

RunState 只保存和判断本次 Run 的状态，不请求模型、不执行工具、不访问 SessionContext、不通知 UI。

### 4.3 agent.ts 继续负责什么

Agent 仍是唯一的执行控制器，保留：

- 构造参数和预算校验。
- Agent.run()、runLoop()。
- requestStep()：模型请求、网络重试、上下文溢出恢复。
- executeToolBatch()：工具预算、重复批次准入、串行执行、结果回写。
- 取消处理、进程清理失败保护。
- 观察回调及其异常隔离。
- Session 累计统计和 Session 生命周期。
- transcript、stats、sessionStats、runReplies、retryAttempts 等现有只读快照。

Agent 负责决定何时更新 RunState；RunState 不反过来控制 Agent。

### 4.4 类型与兼容性

AgentUsage 当前从 src/core/agent.ts 导出。迁移后必须通过 agent.ts 重新导出该类型，现有调用方仍然可以从原路径导入。

AgentStats、AgentSessionStats、AgentOptions 继续留在 agent.ts。

RunState 仅作为 Core 内部实现使用，不从 agent.ts 重新导出，不新增面向宿主的配置项或公共能力。

空用量初始化逻辑需要由 Agent 初始化 Session 累计用量，因此新模块可以提供内部使用的工厂函数；不要为了共享一个简单对象再引入第三个状态模块。

### 4.5 依赖方向

~~~text
agent.ts
   │
   ├──→ run-state.ts
   ├──→ session-context.ts
   ├──→ tool-registry.ts（类型）
   └──→ protocol/

run-state.ts
   └──→ protocol/（只导入必要类型）
~~~

保持 core 内部依赖简单。run-state.ts 不允许 import Agent，也不允许依赖 UI、Tools 实现或 Model 实现。

## 5. 备选方案与选择理由

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A：保持现状 | 不拆 RunState | 风险最低，但状态和控制代码仍集中在 agent.ts |
| B：只拆 RunState | 状态与重复检测迁移到一个文件，Agent 保留控制流程 | 推荐，边界清楚，改动有限 |
| C：全面拆分 | 再增加 RequestManager、ToolExecutionManager、BudgetManager 等 | 当前没有足够证据证明收益，可能增加传参、抽象和维护成本 |

选择 B。

理由：

- 这是职责归属调整，不需要改变执行算法。
- RunState 本身已有完整边界，迁移成本和收益比较明确。
- requestStep() 与 executeToolBatch() 仍然需要协调 Agent、SessionContext、ToolRegistry、预算和回调。现在拆成多个服务可能只是把复杂度转移到构造参数和对象协作上。
- 不追求文件数量或行数指标，优先减少职责混杂和跨文件理解成本。
- 不增加模型请求，不增加 Token 消耗，不改变工具执行次数。

## 6. 关键行为不变量

重构前后必须保持以下行为：

1. 一个 Agent Session 可以顺序执行多个 Run，同一时刻只允许一个 Run。
2. 每次 run() 创建新的 RunState；Run 级计数、用量、回复列表和重复检测状态不跨 Run 继承。
3. Session 级请求数、工具调用数、Token 用量和 Run 数跨 Run 累计。
4. Step、Tool Call、Token 三类预算仍按原规则工作。
5. 每个真实模型请求只记账一次；失败且 usage 缺失时记录 unknown，不得补 0。
6. 网络重试和上下文溢出重发继续分别计数；不得重复执行已经完成的工具。
7. 工具按模型给出的顺序串行执行；每条工具结果的 tool_call_id 必须与调用 ID 一致。
8. 取消、预算跳过、最后一步跳过和进程清理失败时，仍然补齐需要的 not run 结果。
9. 连续三批工具调用只有在调用签名和宿主侧结果都相同、且不属于有效等待豁免时，才阻止下一批。
10. 工具参数对象键递归排序、数组顺序保留、工具调用顺序保留；非法 JSON 参数仍使用原文形成稳定签名。
11. 只有整批都是有效等待时才允许等待豁免；wait=0、出现新输出、任务已结束或混入普通工具都不能错误获得豁免。
12. 展示回调异常不能影响 Agent 执行结果。
13. AgentUsage 仍能从原来的 agent.ts 路径导入。
14. 对外快照仍返回副本，宿主修改快照不能污染内部状态。

重复工具批次的详细不变量以现有 ADR-0030 为准，不重新定义、不另起一套规则。

参考：[ADR-0030](https://github.com/wwxst/agent-Kernel/blob/76a024a496a424614c47ebc6660c2b94ae6c347d/docs/adr/0030-stop-repeated-identical-tool-batches.md)。

## 7. 预计影响文件

| 文件 | 预计操作 | 说明 |
| --- | --- | --- |
| src/core/run-state.ts | 新增 | Run 状态及其纯辅助逻辑 |
| src/core/agent.ts | 修改 | 导入 RunState，保持 AgentUsage 原导出路径 |
| AGENTS.md | 修改 | 增加新文件的职责说明 |
| docs/architecture.md | 修改 | 说明 Agent 与 RunState 的边界 |
| test/agent.test.mjs | 视需要修改 | 现有行为测试优先复用，只补真实缺口 |
| test/background-wait.test.mjs | 默认不修改 | 保留真实后台等待集成验证 |

不修改 docs/adr/0030，因为本次不改变其架构决定和行为不变量。

不修改 README、Tool Registry、SessionContext、协议、模型请求和 UI。

## 8. 验收标准

### 行为验收

- [ ] Agent 的公开接口、类型导入路径和返回数据保持兼容。
- [ ] 多 Run、失败后继续、并发 Run 拒绝等生命周期行为不变。
- [ ] 三类预算和用量统计行为不变。
- [ ] 网络重试、上下文溢出恢复和取消行为不变。
- [ ] 工具调用顺序、结果配对、跳过原因和进程清理保护不变。
- [ ] 无进展检测和有效等待豁免行为不变。
- [ ] CLI、TUI、Subagent 的现有观察行为不变。
- [ ] run-state.ts 不依赖 Agent、UI、Tools 实现或 Model 实现。

### 结构验收

- [ ] RunState 及其专属辅助逻辑只在 run-state.ts 维护。
- [ ] Agent 继续负责执行顺序和生命周期，不出现第二套 Loop。
- [ ] 不增加 Manager、Service、EventBus 或新的状态机。
- [ ] agent.ts 重新导出 AgentUsage，原调用方无需改导入路径。
- [ ] AGENTS.md 和 docs/architecture.md 与实际代码一致。
- [ ] 没有无关文件和功能变更。

### 自动化检查

基线测试文件当前包含：

- test/agent.test.mjs：64 个测试用例。
- test/background-wait.test.mjs：8 个集成测试用例。

必须执行：

~~~bash
npm run typecheck
npm test
npm run architecture:check
npm run eval:check
~~~

全部退出码必须为 0。

真实模型 eval 不作为本次默认验收项：本次不改变提示词、模型请求、工具定义或执行行为。若实现中发现行为变化，必须停止扩大修改，先分析原因；确实影响 Agent 能力时再补充真实任务评测。

## 9. 风险与回滚

### 主要风险

- 迁移 RunState 时遗漏某个读写点，导致统计、回复快照或重复检测出现偏差。
- AgentUsage 类型迁移后没有保持原导出路径。
- 重复检测辅助函数迁移时出现细微行为差异，特别是有效等待链的豁免规则。
- RunState 重置时机改变，导致状态错误地跨 Run 保留。

### 控制措施

- 迁移前完整搜索 currentRun 的所有读写位置。
- 先移动完整实现，不顺手改算法。
- 以现有 64 个 Agent 测试和 8 个后台等待集成测试作为行为基线。
- 完成后检查完整 diff，并安排独立 Reviewer 检查。
- Review 修复后重新运行全部检查。

### 回滚

本次不涉及持久化数据格式、外部协议或 Session 数据迁移。若重构造成回归，可以回退该重构分支的变更，恢复原有 agent.ts 实现。

## 10. 实施任务拆分

| 顺序 | 任务 | 完成标准 |
| --- | --- | --- |
| P1 | 盘点 agent.ts 内所有 currentRun 读写位置 | 没有遗漏的状态访问 |
| P2 | 新建 run-state.ts 并迁移状态及辅助逻辑 | 逻辑原样迁移，无算法改动 |
| P3 | 调整 agent.ts 导入、初始化和 AgentUsage 重新导出 | 原有接口兼容 |
| P4 | 更新 AGENTS.md 和 docs/architecture.md | 文档与代码一致 |
| P5 | 运行类型检查、全量测试、架构检查和 eval 自检 | 全部通过 |
| P6 | 独立 Review 完整 diff | 无阻断或重要问题；问题修复后重新验证 |

## 11. 用户可见变化

预期没有用户可见变化：

- 对话流程不变。
- 工具调用行为不变。
- CLI / TUI 展示不变。
- Token 消耗不变。
- 配置项不变。
- 错误处理和取消语义不变。

本次只改变源码内部职责归属。

## 12. 确认记录

- 当前状态：待用户评审，未批准实施。
- 用户已要求：先将方案推送到 GitHub 供评审。
- 实施授权：尚未获得。
- 只有用户明确确认本方案后，才开始创建实现分支和修改功能代码。
- 若实施前 main 已前进，必须重新检查相关代码和测试；本提案的行号与基线只用于定位，不覆盖更新后的源码事实。

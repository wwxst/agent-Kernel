# 当前架构

> 本文描述当前 `main` 的真实实现，不描述未来计划，也不把课程里的概念当成已经实现的模块。

## 1. 先看最简单的图

~~~text
                         ┌─────────────┐
                         │    用户      │
                         └──────┬──────┘
                                ↓
                         ┌─────────────┐
                         │    Agent    │
                         │  Agent Loop │
                         └──────┬──────┘
                                ↓
                         ┌─────────────┐
                         │ ChatClient  │
                         │    Model    │
                         └──────┬──────┘
                                ↓
                           tool_calls
                                ↓
                       ┌────────────────┐
                       │  ToolRegistry  │
                       └───────┬────────┘
                               ↓
                            Tool.run
                               ↓
                         Tool Result
                               ↓
                          Transcript
                               │
                               └──────→ Model
~~~

外面还有 CLI / TUI / eval，它们负责组装、展示和验证，不应该把第二套 Agent Loop 塞进去。

## 2. Core：Agent Loop

核心在 `src/core/agent.ts` 的 `Agent.run()`。

一次 Run 的主流程：

1. 检查取消状态和预算。
2. 把用户任务放进 Transcript。
3. 每个 Step 开始时刷新 system prompt，确定本步可执行的工具。最后一步、工具额度用尽或进程树清理未确认时，发出只允许文本回答的请求。
4. 请求 `ChatClient`。
5. 先把 assistant Message 放进 Transcript。
6. 没有 `tool_calls` 就结束，返回最终消息。
7. 有 Tool call 就交给 `ToolRegistry` 串行执行。
8. 每个结果变成 `tool` Message 放回 Transcript。
9. 再进入下一 Step。

代码里用 `for` 加 `maxSteps`，而不是裸 `while (true)`。这样核心循环仍然简单，但不会无限请求。

### 三个预算不是一个东西

| 预算 | 数什么 |
| --- | --- |
| Step limit | 本次 Run 允许的业务 Step 数，重发和辅助摘要单独计数 |
| Tool call budget | 真正执行了多少次 Tool |
| Token budget | 已收到 usage 的累计 token |

一次模型回复可以同时要求多个 Tool，所以 Step 和 Tool call 必须分开统计。

### 无进展不等于步数用完

`maxSteps` 是通用刹车：它只会说「步数用完了」，说不清模型是在推进还是在原地打转。所以循环里另有一道判定 —— 连续三批工具调用**调用与结果都相同**（参数按键排序后比较，调用顺序保留）时，不执行下一批，给被跳过的调用补上 `not run` 结果，再以明确错误结束。工具可以在宿主侧结果里标记 `isWaiting`，表示这是一次**有效等待**：真的等过、没有新输出、任务仍在运行。只有整批都是有效等待，重复轮询才不触发无进展熔断，且仍受 `maxSteps` 约束。

只看调用会误伤轮询工具（同一个调用、结果在变），所以结果必须一起比。等待中的暂态由工具通过宿主侧状态明确标记，不从结果文本解析 —— `wait: 0` 的立即返回、拿到新输出、任务已结束都不算等待；一批里混进任何一个普通工具，这一批也照普通规则处理。未标记的稳定结果仍按普通规则处理。计数按 Run 重算，批次不完整（进程树清理未确认、取消）时不参与判定。取舍见 [ADR-0030](./adr/0030-stop-repeated-identical-tool-batches.md)。

## 3. Session、Run、Step、Transcript

这几个词以后统一这么理解：

- **Session**：一个 `Agent` 实例从创建到销毁的整段会话。
- **Run**：一次具体任务，从用户任务开始到最终回复、失败或取消。
- **Step**：一次模型请求加上它要求的那一批 Tool call。
- **Transcript**：当前保留下来的 Message 序列，是模型下一次请求看到的上下文。

一个 Session 可以顺序执行多个 Run，但同一时刻只允许一个 Run。

预算按 Run 重算；Session 统计跨 Run 累积。

## 4. Transcript 和上下文压缩

当前内核已经实现 Session 内的有界上下文压缩。它维护下一次模型请求需要的 Transcript，**不是跨会话 Memory System**。

Agent 负责请求和工具预算。SessionContext 持有当前 Transcript、未消费的工具结果和存档索引，在每个 Step 的业务请求前准备上下文。

1. 测量整份请求：system prompt（包括动态项目指令、Skill 目录和存档清单）、摘要消息、工具定义，以及每条消息和工具参数。
2. 没有达到触发线就不做额外工作；超过后，优先裁剪最早、已经被模型读过的 Tool Result。模型尚未消费的最新结果受到保护。
3. 仍然超出目标时，先把可安全移除的完整历史存档，再让模型生成九节结构化交接摘要。新摘要替换旧摘要；候选上下文通过工具调用配对、当前任务和实际体积检查后才提交。
4. 如果仍超过已知窗口，才允许对尚未消费的工具结果执行更强的存档后预览，并经过最后一道请求准入检查。压缩后仍装不下就明确报错，不发送已知超限的请求。
5. 如果上游明确返回上下文窗口溢出，执行一次更强压缩，目标同时参考被拒请求和本地预算。上游已经拒绝请求时，本地目标只能用于估算。唯一一次重发前，先裁剪工具结果，再检查是否有值得折叠的旧轮次。一次 Step 最多恢复一次，后续网络故障仍可使用网络重试配额。

### 预算与恢复边界

- 配置了 `CONTEXT_WINDOW_TOKENS` 时，按 Token 估算窗口，并先扣除输出预留；80% 触发、70% 收手。
- 未配置窗口时，退回默认 120,000 字符预算。这条路径只是字符软预算，不把字符数冒充 Token。
- Token 估算优先用上一次请求返回的真实 `prompt_tokens` 校准；它不是 Tokenizer 的精确结果，首次请求和内容分布变化时仍可能有误差。
- 所有有损裁剪都先保存完整原文。存档失败时不做依赖该存档的替换；没提交的存档会被回滚，不留没人引用的孤儿文件。压缩后的 system prompt 会提供可读取的存档路径。
- 摘要失败、取消、格式不合格或候选验证失败，都不提交替换，原上下文保持不动。
- 历史摘要以 **system 之后的一条 user 消息**承载，不拼进 system：它替换的是历史，指令等级必须留在数据那一档，不能让工具输出借压缩升成系统规则（见 `docs/design/s08-context-compact.md` §8.4）。这条消息不参与折叠，也不会被当成一轮用户发言交给摘要模型。
- 存档默认位于系统临时目录，可通过 `AGENT_CONTEXT_ARCHIVE` 指定位置；当前不自动清理，存档可能包含密钥或源代码。

这里的目标是让长任务能在有限窗口里继续执行，同时保留原文恢复路径；它不负责提取跨会话记忆。

## 5. ToolRegistry

`src/core/tool-registry.ts` 是所有 Tool call 的统一执行入口。

它负责：

- 根据名字找到 Tool。
- 校验 JSON Schema。
- 解析参数。
- 执行 Tool。
- 把普通失败折成 `ERROR: ...` 文本。
- 在执行前后触发 Hook。

它不负责：

- 具体文件操作。
- Shell 实现。
- 模型请求。
- TUI 展示。

这条边界很重要：以后新增 Tool，尽量只改 `tools/` 和装配，不去改 Agent Loop。

## 6. Tool Hooks

Hook 挂在 `ToolRegistry.execute()` 上：

~~~text
PreToolUse
    ↓
Tool.run()
    ↓
PostToolUse       成功
PostToolUseFailure 失败
~~~

`PreToolUse` 可以阻止一次调用；后两个只观察结果。

Hook 自己出错不会把 Tool 变成失败，也不会修改 Transcript，只增加诊断计数。

当前还有一个真实 Hook 用户：`AGENT_TOOL_LOG` 对应的工具调用日志。

## 7. Tools

`src/tools/workspace.ts` 提供文件和 Shell 能力，包括：

- `read` / `write` / `edit`
- `glob` / `grep` / `ls`
- `shell`
- `shell-output` / `shell-kill`

另外还有：

- `todo_write`：Session 内任务计划。
- `run_subagent`：临时子 Agent。

Tool 的定义通过 `ToolRegistry` 统一提供给模型。

## 8. Workspace 和 Full Access

`Workspace` 的 `root` 是相对路径的默认基准，不是安全边界。

当前 Full Access 设计意味着：

- 绝对路径可以访问。
- `../` 可以离开默认目录。
- Shell 可以在默认 cwd 下执行，也可以在命令里 `cd`。
- 能否访问某个位置，最终取决于启动进程的操作系统账户权限。

所以 `Workspace` 是“默认从哪里开始找”，不是 Sandbox。

## 9. Model 层

`src/model/llm.ts` 实现 `ChatClient`。

它只负责：

- 发送 OpenAI 兼容的 `chat/completions` 请求。
- 解析普通 JSON 或 SSE。
- 校验响应结构。
- 提取 `usage`。
- 处理超时和取消。

重试、预算和循环控制属于 Core，不放进 LLM 层。

## 10. 项目指令和 Skill

每次模型请求前，CLI 会重新读取工作区里的 `AGENTS.md`，这样本轮工具刚改了项目规则，下一轮就能看到。

Skill 也在每次请求前重新扫描：

- 项目级：`<workspace>/.agents/skills/`。
- 用户级：`~/.agents/skills/`。
- 项目级同名 Skill 优先。
- system prompt 只放目录，不放 Skill 正文。
- 模型需要时使用普通 `read` 读取 `SKILL.md`。

因此 Skill 没有第二套执行引擎，也不需要专用 Tool。

## 11. Subagent

主 Agent 通过 `run_subagent` 委派独立任务。

当前有两个角色：

| 角色 | 工具 | 用途 |
| --- | --- | --- |
| `explore` | `read` / `glob` / `grep` / `ls` | 只读调查 |
| `execute` | 文件工具 + 前台 `shell` + Todo | 可写执行 |

子 Agent 使用全新的 Agent 实例、Transcript、Tool registry 和预算。

它不会再向下创建 Subagent，完成后只把最终报告交回父 Agent。

## 12. UI

`src/ui/` 只负责展示。

TUI 通过 Agent 的观察回调得到：

- 请求开始。
- Tool call。
- Tool result。
- 流式正文。
- 重试等状态。

UI 出错只计观察者失败，不应该改变 Agent 的执行结果。

这也是为什么 Core 不 import TUI。

## 13. CLI：唯一组装入口

`src/cli.ts` 把：

~~~text
环境变量 / 参数
      ↓
Workspace + Tools + ToolRegistry
      +
ChatClient
      +
Agent
      +
TUI / CLI presenter
~~~

装成最终运行实例。

`bin/agent.mjs` 只负责 `npm link` 后的命令入口。

## 14. 依赖方向

~~~text
cli
 ├── core
 ├── tools
 ├── model
 ├── ui
 └── protocol

core  ──→ protocol
tools ──→ protocol
model ──→ protocol
ui    ──→ core / protocol
~~~

`protocol` 是最底层词汇。Core 不应该反过来认识具体 Tool 或 UI。

### 自动边界检查

运行 `npm run architecture:check` 可以用 TypeScript AST 检查 `src/` 内的静态导入、导出、类型导入、动态导入、`require` 和 `import = require`，包括 `.d.ts` 等声明文件：

- `protocol` 只依赖自身；
- `core`、`tools`、`model` 只依赖自身和 `protocol`；
- `ui` 可以依赖自身、`core` 和 `protocol`；
- 只有 `src/cli.ts` 是唯一组装入口，可以依赖所有模块；不能通过新建 `src/entry/` 等目录增加特权入口。

检查器无法静态判断的动态路径、无法解析的项目内相对路径，以及没有声明边界的新模块，都会让检查失败。该检查已接入 Linux、Windows、macOS 的 GitHub Actions；它只保护 `src/` 的模块依赖，不替代 TypeScript 类型检查和代码 Review。

## 15. 当前刻意没有的层

下面这些不是当前 Core 的一部分：

- 持久化 Task System。
- Cron Scheduler。
- Agent Teams。
- MCP Runtime。
- Workflow Runtime。
- 独立 Goal Evaluator。
- OS Sandbox。
- 跨进程 Session 恢复。

课程里有这些概念，不等于当前代码有这些模块。研究资料见 [docs/course/](./course/)。

## 16. 看源码从哪里开始

如果第一次看代码，建议顺序：

1. `src/protocol/types.ts`：先看消息和 Tool 的形状。
2. `src/core/agent.ts`：看完整 Agent Loop。
3. `src/core/tool-registry.ts`：看 Tool 怎么统一执行。
4. `src/tools/workspace.ts`：看真实文件和 Shell 能力。
5. `src/cli.ts`：看这些零件怎么组起来。
6. `src/ui/tui.ts`：最后再看展示层。

如果想知道“为什么这样设计”，再去看对应 ADR。

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
3. 每次模型请求前刷新 system prompt。
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
| Step limit | 请求了模型多少次 |
| Tool call budget | 真正执行了多少次 Tool |
| Token budget | 已收到 usage 的累计 token |

一次模型回复可以同时要求多个 Tool，所以 Step 和 Tool call 必须分开统计。

## 3. Session、Run、Step、Transcript

这几个词以后统一这么理解：

- **Session**：一个 `Agent` 实例从创建到销毁的整段会话。
- **Run**：一次具体任务，从用户任务开始到最终回复、失败或取消。
- **Step**：一次模型请求加上它要求的那一批 Tool call。
- **Transcript**：当前保留下来的 Message 序列，是模型下一次请求看到的上下文。

一个 Session 可以顺序执行多个 Run，但同一时刻只允许一个 Run。

预算按 Run 重算；Session 统计跨 Run 累积。

## 4. Transcript 和上下文压缩

当前内核已经有一个简单的、有界的 Transcript 压缩机制，但它不是独立的 Memory System。

默认 Transcript 字符预算为 `120000`。超过预算后，Core 按顺序处理：

1. 优先移除最旧、Tool call 配对完整的旧轮次。
2. 把旧轮次压成短摘要，放进唯一的 system Message。
3. 再压缩较旧的 Tool Result。
4. 必要时缩短旧的 assistant 最终回答。
5. 当前正在等待模型读取的 Tool Result 受到保护，不提前截断。

这里的目标是防止上下文无限增长，不是建立长期记忆。

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
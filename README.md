# agent-Kernel

> 一个极简的 Coding Agent 内核：**模型负责决定下一步，内核负责执行工具，再把结果交回模型。**

`agent-Kernel` 从一个最小 Agent Loop 开始，把模型、工具和执行过程拆开。功能可以继续增加，但尽量不要把核心循环搞复杂。

> 当前版本：`0.5.0`。项目仍在快速迭代中，接口和行为可能变化。
> 运行时不依赖第三方 npm 包；开发时的类型检查和测试依赖写在 `package.json`。

## 这个项目是干什么的？

简单说：

**让模型负责“想做什么”，让程序负责“真的去做”。**

最核心的过程只有这一条循环：

~~~text
用户提出任务
    ↓
Agent 请求模型
    ↓
模型决定：直接回答，还是调用工具
    ↓
需要工具？
  ├─ 否 → 返回最终答案
  └─ 是 → 执行工具
             ↓
         把结果放回消息
             ↓
         再请求模型
             ↓
            ……
             ↓
         最终答案
~~~

这就是 Agent Loop。

项目的核心原则很简单：

- 模型负责决策。
- Tool 负责具体能力。
- Core 负责循环和状态。
- UI 只负责展示。
- 其他能力尽量通过独立模块挂在循环周围。

## 为什么做这个项目？

现在的 Coding Agent 很容易越做越大：权限、工具、Skill、Subagent、Memory、Task、Workflow 等能力都可以不断往里加。

`agent-Kernel` 先反过来做：

> **先把最底层的 Agent Loop 做干净，再根据真实需求往外扩。**

所以这里不会因为“某个课程讲到了”就自动实现一个系统。课程、研究资料和未来设计都只是输入；当前代码、测试和评测才决定项目现在到底有什么。

## 当前有什么？

| 能力 | 现在怎么做 |
| --- | --- |
| Agent Loop | 模型 → Tool → Tool Result → 模型，直到最终回答 |
| Tool Registry | 统一注册、Schema 校验和执行 Tool |
| 文件工具 | `read` / `write` / `edit` / `glob` / `grep` / `ls` |
| Shell | 前台命令、后台任务、输出读取和进程清理 |
| TodoWrite | 当前 Session 内的任务清单 |
| Subagent | `explore` 只读调查、`execute` 可写执行 |
| Skill | 扫描 Skill catalog，需要时由模型用 `read` 读取正文 |
| Hooks | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` |
| Full Access | 只有一种运行模式，不做 agent 自己的权限审批层 |
| TUI | 主屏追加 + transcript 视图的轻量终端界面 |
| 预算 | Step、Tool call、Token 三种预算分开控制 |
| 模型接口 | OpenAI 兼容的 `chat/completions`，支持 SSE 流式展示 |
| 上下文控制 | Transcript 超过预算时，对旧轮次和旧 Tool Result 做有界压缩 |

## Full Access

当前只有一种运行模式：**Full Access（完全访问）**。

这不是“提权”，也不是 Sandbox。它只是取消 agent-Kernel 自己施加的权限审批和工作区边界。

- 文件工具可以访问当前操作系统账户有权限访问的位置。
- `shell` 直接执行，不弹审批框。
- 不再维护 `read-only` / `workspace-write` 等模式。
- 不再维护权限规则文件和 `/permission`。
- 真正的隔离交给容器、虚拟机、独立用户、只读挂载等操作系统级方案。

详细原因见 [ADR-0019：只保留完全访问](./docs/adr/0019-full-access-is-the-only-mode.md)。

## 快速开始

需要 Node.js `>= 22.18`。

复制配置：

~~~powershell
Copy-Item .env.example .env
~~~

然后在 `.env` 填好 `API_KEY`、`BASE_URL` 和 `MODEL`。

运行一次任务：

~~~powershell
npm run agent -- "看看这个仓库的结构，并告诉我主要模块是干什么的"
~~~

不带任务直接进入 TUI：

~~~powershell
npm run agent --
~~~

指定另一个项目目录：

~~~powershell
npm run agent -- --cwd "C:\path\to\project" "先看看这个项目的结构"
~~~

如果任务参数有多行，Windows 下不要经过 `npm run` 转发，直接运行：

~~~powershell
node --env-file-if-exists=.env src/cli.ts "<多行任务>"
~~~

## 在任意目录里运行

在仓库里执行一次：

~~~powershell
npm link
~~~

之后可以进入其他项目直接运行：

~~~powershell
cd D:\some\project
agent
~~~

`agent` 和 `agent-kernel` 都指向 `bin/agent.mjs`。工作区默认是当前目录，模型配置仍从 agent-Kernel 自己的 `.env` 读取。

## 架构

当前代码按职责分成几层：

~~~text
CLI / TUI
   ↓
Agent（Core / Agent Loop）
   ├── Model / ChatClient
   └── ToolRegistry
          ↓
        Tools
          ↓
       Tool Result
          ↓
       Transcript
          └────────→ Model
~~~

关键边界：

- `core/agent.ts` 不直接认识具体 Tool，也不负责 UI。
- `ToolRegistry` 是 Tool 执行的统一入口。
- `model/` 负责模型请求、项目 `AGENTS.md` 和 Skill catalog。
- `tools/` 负责文件、Shell、Todo、Subagent 等实际能力。
- `ui/` 只观察 Agent 事件并展示，不修改 Transcript。
- `cli.ts` 负责把这些零件组装起来。

详细架构见 [docs/architecture.md](./docs/architecture.md)。

## Tool

当前主 Agent 有 11 个内置 Tool：

| Tool | 用途 |
| --- | --- |
| `read` | 读取文件 |
| `write` | 创建或覆盖文件 |
| `edit` | 唯一匹配后修改文件 |
| `glob` | 查找文件 |
| `grep` | 搜索文件内容 |
| `ls` | 查看目录 |
| `shell` | 执行 Shell 命令 |
| `shell-output` | 读取后台任务的新输出 |
| `shell-kill` | 停止后台任务 |
| `todo_write` | 更新任务清单 |
| `run_subagent` | 委派独立子任务 |

Tool 的详细行为放在架构和源码里，不继续把实现细节塞进 README。

## Skill、Subagent、Hook

### Skill

Skill 放在 `.agents/skills/`。系统提示只提供名字、用途和路径；真正需要时，模型用普通 `read` 读取 `SKILL.md`。

这样做的目的就是一句话：**不要一开始把所有知识塞进上下文。**

### Subagent

主 Agent 可以把独立任务交给临时子 Agent。

- `explore`：只读调查。
- `execute`：可以改文件和跑前台 Shell。
- 子 Agent 有自己的 Transcript、Tool registry 和预算。
- 子 Agent 完成后只把最终结果交回主 Agent。

### Hook

Tool 执行统一经过：

~~~text
PreToolUse
    ↓
Tool 执行
    ↓
PostToolUse / PostToolUseFailure
~~~

Hook 是扩展点，不是第二套执行循环。

## TUI

`agent-Kernel` 自带轻量 TUI。

当前设计是：

- 主屏就地追加，已完成的历史进入终端 scrollback。
- `Ctrl+T` 进入独立 transcript 视图。
- `Ctrl+E` 翻阅/展开轮次。
- `Ctrl+G` 定位并展开工具详情。
- `Ctrl+O` 切换最近工具组的展开状态。
- `Ctrl+X` 后按 `Ctrl+E` 使用外部编辑器。
- `PgUp` 暂停活动区刷新，`PgDn` / `Esc` 恢复。
- 非 TTY 自动退化成普通文本输出。

完整按键和展示边界见 [docs/tui.md](./docs/tui.md)。

## 开发

类型检查：

~~~bash
npm run typecheck
~~~

全部确定性检查：

~~~bash
npm run check
~~~

真实 Agent 评测：

~~~bash
npm run eval
~~~

评测需要真实模型配置，会产生模型调用费用。先做不花钱的自检：

~~~bash
npm run eval:check
~~~

## 文档怎么分？

记住这五句话就行：

> **README 讲“是什么”，docs 讲“怎么工作”，AGENTS 讲“怎么改”，ADR 讲“为什么这样改”，eval 讲“到底好不好”。**

| 位置 | 负责什么 |
| --- | --- |
| `README.md` | 项目首页、快速开始、当前能力和边界 |
| `docs/README.md` | 全部文档导航 |
| `docs/architecture.md` | 当前真实架构 |
| `docs/configuration.md` | 配置和命令行 |
| `docs/tui.md` | TUI 使用和设计边界 |
| `docs/design/` | 稳定的跨模块设计原则 |
| `docs/contracts/` | 行为契约和验证口径 |
| `docs/adr/` | 架构决策及历史原因 |
| `docs/course/` | 17 课课程资料，研究和设计参考 |
| `AGENTS.md` | AI / 开发者修改项目时的规则 |
| `CODING_STANDARDS.md` | 编码规范 |
| `GLOSSARY.md` | 统一术语 |
| `eval/` | 真实任务评测和历史基线 |

## 当前没有什么？

没有实现的能力，不会为了让 README 看起来完整而先写成“已支持”。目前刻意没有做成独立系统的包括：

- 跨进程 Session 恢复。
- 持久化 Task System。
- Cron Scheduler。
- Agent Teams。
- MCP Plugin Runtime。
- Workflow Runtime。
- 独立 Goal Loop / 验收控制器。
- 操作系统级 Sandbox。

这些方向可以研究，但进入当前内核前要经过设计、实现、测试和评测。

## 研究资料和当前实现必须分开

`docs/course/` 里的 17 课讲的是一条从 Agent Loop 向外扩展的能力路线。它是研究资料，不是当前功能清单。

以后一个课程能力如果真的进入内核，应该走：

~~~text
研究 / 课程
    ↓
当前需求判断
    ↓
设计
    ↓
ADR（需要时）
    ↓
实现
    ↓
测试
    ↓
eval
    ↓
才成为当前能力
~~~

## 最重要的一句话

> **功能可以越来越多，但尽量不要把核心循环搞复杂。**

模型负责决定。

内核负责执行。

工具负责具体能力。

结果回到模型。

然后继续循环。
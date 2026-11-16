# ADR-0025：子 Agent 复用全新 Agent 实例，不新建第二套循环

- 状态：已采纳（2026-11-16）
- 影响范围：`src/tools/subagent.ts`（新增）、`src/core/agent.ts`、`src/cli.ts`、测试和文档

## 背景

第 6 课要求主 Agent 能把一件相对独立的子任务交给临时子 Agent，让它用自己的上下文和更窄的工具集跑完，只把最终结果交回来。

难点不在「怎么跑」，而在「跑几次」。当前 `Agent` 已经是一个可独立运行的完整实例：它自己持有 `messages[]`、Transcript、请求与工具统计、三道预算（步数 / 工具调用 / token）和取消状态。如果为子 Agent 另写一套循环，取消、预算、工具配对、模型错误处理就会出现两份实现；以后修一处，另一处照旧错，而这类错误正好都发生在最难复现的路径上。

## 决定

- **一个 Agent 类、一套 Agent Loop、多个独立实例。** 每次委派 `new Agent(...)`，直接调用它已有的 `run(task)`；不复制、不继承、不包装循环。
- 子 Agent 的 `messages[]` 从空开始：一条自己的 system，加一条 `user` 任务。父 Agent 的历史、Todo 清单、工具调用记录一概不传。
- 父子通过**一条工具结果**交接：`run_subagent` 返回子 Agent 的最终回复正文加它自己的统计，不返回 Transcript。
- 工具集按角色在装配层筛：`explore` 只有 `read` / `glob` / `grep` / `ls`；`execute` 再加 `write` / `edit` / `shell` 和它自己的 `todo_write`。两种角色都没有 `run_subagent`，所以不能嵌套委派。
- `execute` 的 `shell` 被改成纯前台：Schema 删掉 `background`，执行时强制 `background: false`。子 Agent 起一个后台进程后立刻结束，会留下没人收尾的任务，而任务管理属于第 11 课。
- 子 Agent 各建一份 `Workspace`：隔离的是后台任务等**运行状态**，不是文件系统 —— 两者改的是同一批文件。
- 子 Agent 的系统提示只给方向：角色、职责、交付物，加上**真实工作区根目录**（`subagentWorkspaceContext()`）。不写「先读哪个文件、搜几次、按什么顺序做」—— 那些是模型该自己判断的事，写死了会让它在需要灵活时不灵活；可靠执行由工具表、预算和取消保证，不靠提示词。
- 提示词里只保留一条硬约束：提交、推送、合并、变基、重置这类 git 动作必须由任务明确授权。
- 当时的两处工具缺口已由 [ADR-0026](./0026-read-window-and-grep-single-file.md) 修掉：`read` 现在有 `offset` / `limit`，`grep` 的 `path` 也接受单个文件。它们一度只靠提示词提醒模型，后来为了保持提示简短而移除 —— 真正的修法在工具本身，不在提示词。
- 预算取「子 Agent 上限」与「用户配置」的较小值（20 步 / 30 次工具 / 100000 token）。统计不并入父 Agent 的 `stats` 和 `[usage]`，避免把「这一轮主任务花了多少」和「含子 Agent 一共花了多少」混成一个数。
- 取消只用一个 `AbortSignal`：父 Agent 被取消时，子 Agent 的模型请求和 shell 一起停。没有单独停某个子 Agent 的入口 —— 它是前台同步执行的。
- 子 Agent 的展示回调全是空函数：它的流式正文和工具进度不进主界面，过程只体现在父 Agent 那一条工具结果里。
- `Agent` 新增只读属性 `toolExecutionDisabled`。子 Agent 的进程树清理未确认时，委派执行器抛 `ProcessCleanupError`，让父 Agent 进入既有的「禁用后续工具、只许收尾」状态。

## 取舍与边界

- **不并行。** 一次只跑一个子 Agent，且是同步的。并行、Mailbox、Worktree 属第 13 课。
- **不驻留、不恢复。** 子 Agent 跑完即丢，没有 ID、没有历史、不能再追问。
- **`explore` 不是沙箱。** 它只是工具层的只读角色；Full Access 下 `read` 仍能读当前操作系统账户有权读的任何路径。文档与提示都不能把它说成安全隔离。
- **失败不回滚。** `execute` 改了文件之后失败，那些改动仍在。失败结果里明确写了这一点，主 Agent 要先看工作区。
- **子 Agent 改的文件不进 TUI 的 Diff 视图。** `execute` 能改文件，但编辑回调按「父 Agent 这次工具调用的 id」归属（`pendingEditId`），子 Agent 的写/改没有对应的父调用，界面只会显示一条 `run_subagent` 结果。核对子 Agent 到底改了什么，要靠 `git diff` / `git status`。同理，`AGENT_TOOL_LOG` 的记录不区分父子，排障时要结合时间顺序看。
- **父 Agent 的账单不含子 Agent。** 这是有意的：预算按 Run 算，混在一起就既限不住单轮、也看不清总量。真要统一账单，需要共享 Usage Ledger，那是后续的事。
- **子 Agent 关掉模型重试。** 第一版让它一次一请求：委派本来就有父 Agent 兜底，多一层重试只会让「失败」来得更慢。

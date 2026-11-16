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
- 子 Agent 的系统提示里注入**真实工作区根目录**（`subagentWorkspaceContext()`），只读角色还写明两条工具事实：`read` 没有 `offset` / `limit`（重复读同一路径只会拿回同样的开头）、`grep` 的 `path` 必须是目录。这些是实测出来的无效调用来源：模型会凭空猜 `/workspace/...`，也会以为 `read` 能翻页、把文件当目录交给 `grep`。提示词只能降低概率，不能替代预算闸门，更不是沙箱。
- 预算取「子 Agent 上限」与「用户配置」的较小值（20 步 / 30 次工具 / 100000 token）。统计不并入父 Agent 的 `stats` 和 `[usage]`，避免把「这一轮主任务花了多少」和「含子 Agent 一共花了多少」混成一个数。
- 取消只用一个 `AbortSignal`：父 Agent 被取消时，子 Agent 的模型请求和 shell 一起停。没有单独停某个子 Agent 的入口 —— 它是前台同步执行的。
- 子 Agent 的展示回调全是空函数：它的流式正文和工具进度不进主界面，过程只体现在父 Agent 那一条工具结果里。
- `Agent` 新增只读属性 `toolExecutionDisabled`。子 Agent 的进程树清理未确认时，委派执行器抛 `ProcessCleanupError`，让父 Agent 进入既有的「禁用后续工具、只许收尾」状态。

## 取舍与边界

- **不并行。** 一次只跑一个子 Agent，且是同步的。并行、Mailbox、Worktree 属第 13 课。
- **不驻留、不恢复。** 子 Agent 跑完即丢，没有 ID、没有历史、不能再追问。
- **`explore` 不是沙箱。** 它只是工具层的只读角色；Full Access 下 `read` 仍能读当前操作系统账户有权读的任何路径。文档与提示都不能把它说成安全隔离。
- **失败不回滚。** `execute` 改了文件之后失败，那些改动仍在。失败结果里明确写了这一点，主 Agent 要先看工作区。
- **父 Agent 的账单不含子 Agent。** 这是有意的：预算按 Run 算，混在一起就既限不住单轮、也看不清总量。真要统一账单，需要共享 Usage Ledger，那是后续的事。
- **子 Agent 关掉模型重试。** 第一版让它一次一请求：委派本来就有父 Agent 兜底，多一层重试只会让「失败」来得更慢。

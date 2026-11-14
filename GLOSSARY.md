# agent-Kernel

一个最小 coding agent 的领域语言：模型只负责说，内核负责把「说」变成「做」，再把做的结果说回去。

## Language

**Core**:
这个仓库的全部内容：一个把模型回复变成工具调用、再把工具结果送回去的循环（生态里叫 **Agent loop**）。除了步数上限，它不自带任何策略。
旧称 **Kernel**：2026-11 统一改名为 Core，历史 ADR 与提交信息里仍可能用旧名。
_Avoid_: engine, runtime, framework

**Agent loop**:
这个循环在生态里的通用叫法，本仓库给它起的名字是 **Core**：问模型 → 执行它要的工具 → 把结果塞回去，直到模型不再要工具。
_Avoid_: ReAct（那是另一种带显式推理步的循环）

**Run**:
对一条任务的一次完整执行，终止于最终回复（正常）、预算耗尽或取消（失败）。同一个 Agent 可以按顺序跑多个 Run，Transcript 跨 Run 累积；预算按 Run 算，会话账单看 `sessionStats`。
_Avoid_: job, turn

**Session**:
一个 Agent 实例从创建到丢弃之间的一段对话，由按顺序执行的多个 Run 组成。CLI 的 TUI 就是它的外壳；`/reset` 等于换一个新 Session。
_Avoid_: conversation（口语可以，代码里没有单独的 Session 类型）

**Step**:
一次模型请求，加上它索要的那一轮工具调用。循环按步计数，步数上限数的就是它。它**不等于**工具执行次数：一次模型回复可以要多个工具。
_Avoid_: round, turn, iteration

**Transcript**:
按顺序排列的全部消息，是 agent 唯一的记忆；每个 Step 都把它整体重发给模型。
_Avoid_: history, context, conversation log

**Message**:
Transcript 里的一条记录，字段沿用 chat/completions 的线上形状。
_Avoid_: event, record, item

**Tool call**:
模型发起的一次工具请求：工具名加一段 JSON 参数文本。
_Avoid_: function call, action, command

**Tool**:
模型可以点名调用的一项能力，由 name、description、JSON Schema 三件套描述，外加宿主侧的 run。名字用 agent 生态的通用叫法（`read`、`write`、`edit`、`glob`、`grep`、`ls`、`shell`），见 [ADR-0005](./docs/adr/0005-name-tools-after-the-ecosystem.md)。
_Avoid_: function, handler, plugin

**TodoWrite**:
模型调用 `todo_write` 保存当前会话的任务清单及状态：`pending` / `in_progress` / `done`。不做实际执行、不判断目标是否达成，也不持久化（后续 Task System 负责持久化）。

**Tool registry**:
一次 Run 里提供给模型的全部 Tool，以及把每个 Tool call 执行成一条 Tool result 的那一步。
_Avoid_: toolbelt, toolbox, tool set

**Hook**:
挂在工具执行上的生命周期回调，三个事件：`PreToolUse`（执行前，可返回 `{ block: 原因 }` 阻止这次调用）、`PostToolUse`（成功之后，能拿到结果原文）、`PostToolUseFailure`（失败之后，能拿到原始错误）。它们挂在唯一的执行入口 `ToolRegistry.execute` 上，所有 Tool 自动经过；同一事件按登记顺序串行执行，Hook 自己出错只记 `failureCount`，不改变工具结果，也不进入 Transcript（见 [ADR-0020](./docs/adr/0020-tool-hooks-live-in-the-registry.md)）。
_Avoid_: middleware, plugin, interceptor（它们改写请求或接管执行；Hook 只能旁观与阻止）

**Full access**:
agent-Kernel 唯一的运行模式：工具与 **shell** 直接执行，没有审批、没有模式切换，也没有 **Workspace** 目录边界。它取消的是 agent-Kernel 自己施加的限制，不是提权——进程仍以启动它的操作系统账户运行。
_Avoid_: sandbox, permission mode, admin mode（它不是提权）

**TUI**:
CLI 的 Claude Code 风格聊天式界面。**主视图**在主屏就地追加：已定稿的行打印一次进 Shell 滚动历史，只有底部活动区（当前轮内容 + 输入框 + 状态行）重绘，不切 alternate screen、不捕获鼠标、不引 TUI 库；**transcript 视图**（`Ctrl+T`）临时进备用屏，用绝对光标定位 + 差分重绘回看和展开历史。有颜色/字形降级和 resize，只保留最后一屏。非 TTY 退化为逐行输出。它只是 **Session** 的外壳，不改变 **Transcript**、预算或工具执行。
_Avoid_: dashboard, full-screen app, UI framework

**Status bar**:
TUI 的状态显示；v0.3 拆成顶部 header（项目 / model / workspace）和输入框下方的状态行（固定的 `权限：完全访问` + **Session** 的 requests / tool calls / tokens）。
_Avoid_: header, banner

**Thinking**:
模型请求发出后、第一段正文/工具调用/错误到达前显示的状态提示（`thinking...`，Windows Terminal 下带 `✻`，conhost 下带 `*`）。它只表示等待，不代表请求成功；第一段输出会把它重绘掉。
_Avoid_: reasoning（那是模型返回的 `reasoning_content`，v0.3 不展示）

**Run log**:
TUI 里给人看的滚动记录：模型回复、**Tool call**、**Tool result** 与拒绝原因。它不是 **Transcript** —— 它不参与下一轮请求，也不改变模型看到什么。
_Avoid_: transcript, history, context

**Sandbox**:
操作系统级隔离：容器、虚拟机、独立用户、只读挂载之类。本仓库没有实现 Sandbox；**Full access** 与 **Workspace** 都不是 Sandbox。
_Avoid_: full access, workspace（这两个都不是隔离）

**Tool result**:
一次 Tool call 的文本答复，以 tool Message 回灌进 Transcript。
_Avoid_: output, observation, response

**ERROR text**:
失败的工具结果：以 `ERROR: ` 开头的文本，模型读到后可自行纠正。工具失败从不抛异常。
_Avoid_: exception, failure, error object

**Workspace**:
相对路径的默认基准目录，根目录由 `WORKDIR` 决定。它**不是访问边界**：绝对路径、`../`、其他磁盘都可用。正在跑的 shell 响应同一个取消信号，停止时要等整棵进程树被收掉。
_Avoid_: cwd, working directory, project root, sandbox

**Background job**:
`shell` 带 `background:true` 起的一次脱离进程，由宿主登记成一个编号（`job-1`）。它的输出写进系统临时目录的日志文件，**不写工作区**；`shell-output` 按字节游标只返回新长出来的部分，`shell-kill` 停整棵进程树。日志接文件而不是管道，是因为管道的 handle 会让宿主进程退不出去（见 [踩坑记录](./docs/notes/background-jobs.md)）。
_Avoid_: daemon, service, task queue, session（它不是会话，也不排队）

**Step limit**:
一次 Run 允许的最大 Step 数（模型请求数）；到达即失败，而不是返回半成品。它不限制工具执行次数，后者是 **Tool call budget**。
_Avoid_: deadline, budget, timeout

**Tool call budget**:
一次 Run 允许真正执行的最大 Tool call 数。和 **Step limit** 是两个预算：一次 Step 可以包含多个 Tool call，所以只限制 Step 并不限制副作用次数。
_Avoid_: rate limit, quota

**Token usage**:
端点返回的 `usage`：prompt tokens、completion tokens、total tokens。端点没给、或者请求中途失败，成本就是**未知**，不是 0；未知时累计值只是下限，不能声称「实际 token 已被精确限制」。
_Avoid_: cost（成本是 usage 乘以单价，本仓库不猜单价）

**Token budget**:
一次 Run 的累计 token **软上限**：达到后不再发新请求、不再执行没有后续请求验证的工具。把预算顶穿的那条回复仍然照记；如果它正好是最终答复，Run 可以成功返回，超限状态由 `stats.tokenBudget.exceeded` 暴露，由调用方决定算不算失败。
_Avoid_: hard cap, quota（它不保证总量不超过上限）

**Chat client**:
Core 向谁要下一条 Message 和这一轮的 Token usage：生产实现 POST 一个 OpenAI 兼容端点（可选 SSE 流式），测试实现按脚本回放。流式只影响「怎么显示」，不影响返回的 Message。
_Avoid_: LLM, model, provider

## Relationships

- 一个 **Session** 产生一条 **Transcript**，以一条 system **Message** 开头；一次 **Run** 往里追加一条 user **Message** 及其后续。
- **Transcript** 是 **Message** 的序列；每个 **Step** 追加一条 assistant **Message**，它可能携带多个 **Tool call**。
- 每个 **Tool call** 恰好由一条 **Tool result** **Message** 答复，两者靠 id 配对；没有执行的调用也留一条 `not run` 结果，配对不为预算或取消让路。
- **Tool registry** 持有 N 个 **Tool**，这些 **Tool** 只作用于一个 **Workspace**。
- 每个 **Tool call** 在参数校验通过后直接执行；普通失败折成 **ERROR text**，模型下一轮自己纠正。
- 每个 **Tool call** 执行前后会经过登记过的 **Hook**：`PreToolUse` 能阻止它（被拦下的调用不执行，结果是一条带原因的 **ERROR text**），`PostToolUse` / `PostToolUseFailure` 只观察。**Hook** 不改变 **Tool result**，也不改变 **Transcript**。
- **Full access** 不改变进程权限：**shell** 与文件工具都以启动者同权执行，可以离开 **Workspace**。
- **Step limit** 限制一次 **Run** 里的 **Step** 数；**Tool call budget** 限制同一 Run 里真正执行的 **Tool call** 数；**Token budget** 是软上限，达到后 Run 不再发新请求。
- 一个 **Agent** 实例对应一个 **Session**，可以按顺序跑多个 **Run**；同一时刻只有一个 Run 在跑。
- **TUI** 是 **Session** 的一个外壳：**Status bar** 显示项目 / model / workspace，输入框下方显示固定的完全访问标签和 **Session** 统计，**Run log** 显示模型回复、Tool call 与 Tool result；输入复用同一套 `/reset`、`/help`、`/exit`，固定在底部。
- 每次 **Step** 的模型请求发出后、第一段输出前显示 **Thinking**；第一段正文、Tool call 或错误会清掉它。它不是模型的 `reasoning_content`。
- **Run log** 不是 **Transcript**：前者只负责显示，后者才是发给模型的记忆；删掉 Run log 不会改变任何一轮请求。

## Flagged ambiguities

- "agent" 既指整个程序（CLI 加 Core），也指循环本身。本仓库里 **Core** 专指循环，**Run** 专指一次执行；"agent" 只作为项目名出现。
- "error" 有两种：**ERROR text** 是回灌给模型的文本；异常（throw）只出现在 Tool 之外的宿主代码里。
- "full access" 不是 "sandbox"：**Full access** 是「不再自己施加限制」；**Sandbox** 是操作系统级隔离，本仓库没有实现。
- "log" 有两种：**Run log** 是 TUI 给人看的滚动记录；**Transcript** 是模型记忆。两者不互为副本，也不要求同步。

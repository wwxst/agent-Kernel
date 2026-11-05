# agent-Kernel

一个最小 coding agent 的领域语言：模型只负责说，内核负责把「说」变成「做」，再把做的结果说回去。

## Language

**Kernel**:
这个仓库的全部内容：一个把模型回复变成工具调用、再把工具结果送回去的循环（生态里叫 **Agent loop**）。除了步数上限，它不自带任何策略。
_Avoid_: engine, runtime, framework

**Agent loop**:
这个循环在生态里的通用叫法，本仓库给它起的名字是 **Kernel**：问模型 → 执行它要的工具 → 把结果塞回去，直到模型不再要工具。
_Avoid_: ReAct（那是另一种带显式推理步的循环）

**Run**:
对一条任务的一次完整执行，终止于最终回复（正常）、预算耗尽或取消（失败）。同一个 Agent 可以按顺序跑多个 Run，Transcript 跨 Run 累积；预算按 Run 算，会话账单看 `sessionStats`。
_Avoid_: job, turn

**Session**:
一个 Agent 实例从创建到丢弃之间的一段对话，由按顺序执行的多个 Run 组成。CLI 的 `--repl` 就是它的外壳；`/reset` 等于换一个新 Session。
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

**Tool registry**:
一次 Run 里提供给模型的全部 Tool，以及把每个 Tool call 执行成一条 Tool result 的那一步。
_Avoid_: toolbelt, toolbox, tool set

**Permission**:
宿主对一次 **Tool call** 放不放行的策略，三档：`read-only`、`workspace-write`、`full-access`。它在 **Tool registry** 的参数校验之后、执行之前检查；拒绝折成 **ERROR text**。它只约束工具调用，不改变操作系统的权限。
_Avoid_: sandbox, isolation, ACL

**Permission mode**:
**Permission** 的当前档位。CLI 默认 `workspace-write`；`--permission` 决定起始值，REPL 的 `/permission` 切换，`/reset` 不改变它。
_Avoid_: permission level, security level

**Permission prompt**:
宿主写进唯一 system **Message** 的当前权限说明，由 `permissionPrompt(mode)` 生成。每次模型请求前刷新；`/permission` 切换后下一次请求生效，`/reset` 保留当前 mode。它只指导模型，不执行检查。
_Avoid_: policy prompt（Policy 是 **Permission** 本身）, system rules（太泛）

**Approval**:
`workspace-write` 下 **shell** 的逐次人工确认：允许一次或拒绝。无 TTY、取消、EOF、审批异常都按拒绝处理；批准不缓存，下一条命令重新问。
_Avoid_: confirmation prompt, policy, permission（Permission 是模式判断，Approval 是其中一次询问）

**Sandbox**:
操作系统级隔离：容器、虚拟机、独立用户、只读挂载之类。本仓库没有实现 Sandbox；**Permission** 与 **Workspace** 的路径守卫都不是 Sandbox。
_Avoid_: permission, workspace（这两个都不是隔离）

**Tool result**:
一次 Tool call 的文本答复，以 tool Message 回灌进 Transcript。
_Avoid_: output, observation, response

**ERROR text**:
失败的工具结果：以 `ERROR: ` 开头的文本，模型读到后可自行纠正。工具失败从不抛异常。
_Avoid_: exception, failure, error object

**Workspace**:
Tool 被允许触碰的目录树，根目录由 `WORKDIR` 决定。正在跑的 shell 响应同一个取消信号，停止时要等整棵进程树被收掉。
_Avoid_: cwd, working directory, project root, sandbox

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
Kernel 向谁要下一条 Message 和这一轮的 Token usage：生产实现 POST 一个 OpenAI 兼容端点（可选 SSE 流式），测试实现按脚本回放。流式只影响「怎么显示」，不影响返回的 Message。
_Avoid_: LLM, model, provider

## Relationships

- 一个 **Session** 产生一条 **Transcript**，以一条 system **Message** 开头；一次 **Run** 往里追加一条 user **Message** 及其后续。
- **Transcript** 是 **Message** 的序列；每个 **Step** 追加一条 assistant **Message**，它可能携带多个 **Tool call**。
- 每个 **Tool call** 恰好由一条 **Tool result** **Message** 答复，两者靠 id 配对；没有执行的调用也留一条 `not run` 结果，配对不为预算或取消让路。
- **Tool registry** 持有 N 个 **Tool**，这些 **Tool** 只作用于一个 **Workspace**。
- 每个 **Tool call** 在参数校验通过后先过 **Permission**；拒绝时工具不执行，结果是一条 **ERROR text**。
- **Permission** 只约束 Tool call，不改变进程权限；**shell** 放行后与启动者同权，可以离开 **Workspace**。
- 一个 **Session** 有一个 **Permission mode**；`/reset` 换 Agent，但不换 mode。
- 每次 **Step** 的模型请求前，**Permission prompt** 刷新唯一的 system Message；它只负责指导，放行/拒绝仍由 **Tool registry** 执行。
- **Step limit** 限制一次 **Run** 里的 **Step** 数；**Tool call budget** 限制同一 Run 里真正执行的 **Tool call** 数；**Token budget** 是软上限，达到后 Run 不再发新请求。
- 一个 **Agent** 实例对应一个 **Session**，可以按顺序跑多个 **Run**；同一时刻只有一个 Run 在跑。

## Flagged ambiguities

- "agent" 既指整个程序（CLI 加 Kernel），也指循环本身。本仓库里 **Kernel** 专指循环，**Run** 专指一次执行；"agent" 只作为项目名出现。
- "error" 有两种：**ERROR text** 是回灌给模型的文本；异常（throw）只出现在 Tool 之外的宿主代码里。
- "permission" 不是 "sandbox"：**Permission** 只决定一次 Tool call 放不放行；**Sandbox** 是操作系统级隔离，本仓库没有实现。

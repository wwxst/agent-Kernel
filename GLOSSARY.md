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
对一条任务的一次完整执行，终止于最终回复（正常）或步数耗尽（失败）。
_Avoid_: session, job, conversation

**Step**:
一次模型请求，加上它索要的那一轮工具调用。循环按步计数，步数上限数的就是它。
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

**Tool result**:
一次 Tool call 的文本答复，以 tool Message 回灌进 Transcript。
_Avoid_: output, observation, response

**ERROR text**:
失败的工具结果：以 `ERROR: ` 开头的文本，模型读到后可自行纠正。工具失败从不抛异常。
_Avoid_: exception, failure, error object

**Workspace**:
Tool 被允许触碰的目录树，根目录由 `WORKDIR` 决定。
_Avoid_: cwd, working directory, project root, sandbox

**Step limit**:
一次 Run 允许的最大 Step 数；到达即失败，而不是返回半成品。
_Avoid_: deadline, budget, timeout

**Chat client**:
Kernel 向谁要下一条 Message：生产实现 POST 一个 OpenAI 兼容端点，测试实现按脚本回放。
_Avoid_: LLM, model, provider

## Relationships

- 一次 **Run** 产生一条 **Transcript**，以一条 system **Message** 开头。
- **Transcript** 是 **Message** 的序列；每个 **Step** 追加一条 assistant **Message**，它可能携带多个 **Tool call**。
- 每个 **Tool call** 恰好由一条 **Tool result** **Message** 答复，两者靠 id 配对。
- **Tool registry** 持有 N 个 **Tool**，这些 **Tool** 只作用于一个 **Workspace**。
- **Step limit** 限制一次 **Run** 里的 **Step** 数。

## Flagged ambiguities

- "agent" 既指整个程序（CLI 加 Kernel），也指循环本身。本仓库里 **Kernel** 专指循环，**Run** 专指一次执行；"agent" 只作为项目名出现。
- "error" 有两种：**ERROR text** 是回灌给模型的文本；异常（throw）只出现在 Tool 之外的宿主代码里。

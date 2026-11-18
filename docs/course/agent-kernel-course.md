# Agent 内核设计课程：一个循环，贯穿十七课

> 整理范围：用户提供的课程图片，共 17 课（s01～s17）及最后的总览图。\
> 说明：本文依据图片中的标题、要点、代码截图和课程总结整理。代码片段是图片内容的转录/归纳，部分细节可能因图片分辨率或截图省略而不完整，不能直接视为可运行的完整实现。具体实现应以课程源码仓库为准。

## 课程总览

这套课程围绕一个核心思想展开：

**Agent 的核心循环尽量保持稳定，其他能力围绕这个循环逐步扩展。**

基本运行过程：

1.  用户发送消息。
2.  Agent 将消息交给模型。
3.  模型决定是否调用工具。
4.  如果需要调用工具，程序执行工具。
5.  程序把工具结果追加到消息列表，再交给模型。
6.  模型继续判断，直到不再调用工具并返回最终结果。

可以把它概括为：

> 把消息发给模型。模型决定要不要调用工具。代码负责执行，再把结果喂回去。循环不变，变的是周围的机制。

## 17 课目录

  课程   模块                 主要解决的问题
  ------ -------------------- ----------------------------------
  01     Agent Loop           Agent 如何运行
  02     Tool Use             Agent 如何使用工具
  03     Permission           如何控制执行权限
  04     Hooks                如何扩展执行机制
  05     TodoWrite            如何制定任务计划
  06     Subagent             如何委派子任务
  07     Skill Loading        如何动态加载技能
  08     Context Compact      如何压缩上下文
  09     Memory               如何跨会话保留重要记忆
  10     Task System          如何持久化管理任务及依赖
  11     Background Tasks     如何执行耗时后台任务
  12     Cron Scheduler       如何定时自动启动任务
  13     Agent Teams          如何组织多个 Agent 协作
  14     MCP Plugin           如何接入外部工具
  15     Integrated Harness   如何把各项机制集成到统一运行框架
  16     Workflow Runtime     如何执行固定流程并支持恢复
  17     Goal Loop            如何判断目标是否真正达成

------------------------------------------------------------------------

# 第一部分：核心执行机制（第 1～4 课）

## 第 1 课：Agent Loop（核心循环）

**标题：一个循环就够了**\
英文：*One loop & Bash is all you need*

### 关键概念

-   `messages[]`：消息列表，保存用户消息、模型回复和工具结果。
-   `while True`：Agent 的主循环。
-   `tool_use`：模型提出的工具调用。
-   `run_tool`：程序实际执行工具。

### 核心代码（按图片整理）

``` python
def agent_loop(messages: list):
    while True:
        response = client.messages.create(
            model=MODEL,
            system=SYSTEM,
            messages=messages,
            tools=TOOLS
        )

        messages.append(assistant_turn(response))

        if not tool_calls:
            return response.content[0].text

        output = run_bash(block.input["command"])
        messages.append(tool_result(output))
```

### 运行过程

1.  把用户消息发送给模型。
2.  模型分析任务，决定是否调用工具。
3.  如果没有工具调用，返回最终文本。
4.  如果有工具调用，程序执行 Bash。
5.  把工具执行结果追加到消息列表。
6.  再次调用模型，进入下一轮。

### 本课要点

Agent
最基本的能力，是模型与工具之间的循环。模型负责决定下一步，代码负责执行，执行结果再交给模型。

**设计原则：先建立一个尽可能简单、稳定的核心循环。**

图片标注：`s01_agent_loop/code.py`，151 行，独立可运行。

## 第 2 课：Tool Use（工具系统）

**标题：多加一个工具，只加一行**\
英文：*Adding a tool means adding one handler*

### 关键概念

-   `TOOL_HANDLERS`：工具分发器。
-   工具名称映射到对应的处理函数。
-   增加工具时尽量不修改主循环。

### 核心代码（按图片整理）

``` python
TOOL_HANDLERS = {
    "bash": run_bash,
    "read_file": run_read,
    "write_file": run_write,
    "edit_file": run_edit,
    "glob": run_glob,
}

# 原先可能直接写死：
# output = run_bash(...)

# 改为统一分发：
output = TOOL_HANDLERS[block.name](**block.input)
```

### 运行过程

模型返回工具名称和参数，程序根据工具名称在 `TOOL_HANDLERS`
中找到处理函数，再把参数传给它。

例如：

-   `bash`：执行命令。
-   `read_file`：读取文件。
-   `write_file`：写入文件。
-   `edit_file`：修改文件。
-   `glob`：查找文件。

### 本课要点

增加工具，不应该导致 Agent
核心循环不断变化。工具通过统一注册和分发机制接入。

**设计原则：扩展工具能力，不重写核心循环。**

图片标注：`s02_tool_use/code.py`，206 行，独立可运行。

## 第 3 课：Permission（权限系统）

**标题：执行前先做权限判断**\
英文：*Set boundaries first, then grant freedom*

### 关键概念

-   Deny List：命中后直接拒绝。
-   危险操作：需要用户确认。
-   规则检查：根据工具名称和参数判断是否需要确认。
-   通过检查后才允许执行。

### 核心代码（按图片整理）

``` python
def check_permission(block) -> bool:

    if reason := check_deny_list(cmd):
        return deny(reason)  # 例如 rm -rf 等

    if contains_destructive_command(cmd):
        return ask_user(block, "destructive")

    if reason := check_rules(name, args):
        return ask_user(block, reason)

    return True  # 放行
```

### 权限判断逻辑

  情况                     处理方式
  ------------------------ --------------
  命中禁止规则             直接拒绝
  涉及危险操作             请求用户确认
  命中其他需要确认的规则   请求用户确认
  没有触发限制             允许执行

### 本课要点

工具执行之前先检查权限。不能因为模型提出了工具调用，就默认程序可以执行。

**设计原则：先划定安全边界，再授予执行自由。**

图片标注：`s03_permission/code.py`，267 行，独立可运行。

## 第 4 课：Hooks（钩子机制）

**标题：挂在循环上，不写进循环里**\
英文：*Hook around the loop, never rewrite the loop*

### 关键概念

-   `PreToolUse`：工具执行前触发。
-   `PostToolUse`：工具执行后触发。
-   `register_hook`：注册回调。
-   权限检查、日志、输出处理等可以通过 Hook 接入。

### 核心代码（按图片整理）

``` python
HOOKS = {
    "PreToolUse": [],
    "PostToolUse": []
}

def register_hook(event, callback):
    HOOKS[event].append(callback)

register_hook("PreToolUse", permission_hook)
register_hook("PreToolUse", log_hook)
register_hook("PostToolUse", large_output_hook)

# 执行工具前统一触发
trigger_hooks("PreToolUse", block)
```

### 可以挂载的功能

**工具执行前：**

-   权限检查。
-   参数检查。
-   执行日志。
-   上下文注入。

**工具执行后：**

-   记录执行结果。
-   检查输出大小。
-   处理异常。
-   对结果做后续处理。

### 本课要点

扩展能力尽量通过钩子挂在工具执行前后，而不是把所有逻辑都塞进主循环。

**设计原则：扩展点放在循环外部，核心循环保持稳定。**

图片标注：`s04_hooks/code.py`，286 行，独立可运行。

------------------------------------------------------------------------

# 第二部分：任务规划、子任务与知识管理（第 5～9 课）

## 第 5 课：TodoWrite（任务计划）

**标题：没有计划的 Agent 会跑偏**\
英文：*An agent without a plan drifts*

### 关键概念

-   `TodoManager`：任务清单管理器。
-   `pending`：待执行。
-   `in_progress`：正在执行。
-   `done`：已完成。
-   先列步骤，再逐项执行和更新状态。

### 核心代码（按图片整理）

``` python
class TodoManager:

    def update(self, todos: list):
        self.todos = validate(todos)

        # 校验任务状态，例如 in_progress 数量
        return self.render()


def run_todo_write(todos) -> str:
    return TODO.update(todos)


TOOL_HANDLERS["todo_write"] = run_todo_write
```

### 运行过程

1.  分析用户交给的复杂任务。
2.  把大任务拆成可执行步骤。
3.  建立 Todo 清单。
4.  逐项执行。
5.  每完成一步就更新状态。
6.  根据剩余任务继续推进。

### 本课要点

复杂任务不能只靠模型在脑子里记着。需要显式的任务清单和状态。

**设计原则：先规划，再执行；执行过程中持续更新状态。**

图片标注：`s05_todo_write/code.py`，368 行，独立可运行。

## 第 6 课：Subagent（子 Agent）

**标题：给子任务一段独立上下文**\
英文：*Fresh messages\[\], final text returns as one result*

### 关键概念

-   子 Agent 使用独立的 `messages[]`。
-   子任务上下文与主 Agent 隔离。
-   子 Agent 完成后，把最终结果返回主 Agent。

### 核心代码（按图片整理）

``` python
def run_subagent(prompt: str) -> str:

    messages = [
        {
            "role": "user",
            "content": prompt
        }
    ]  # 全新上下文

    for _ in range(30):
        response = client.messages.create(
            messages=messages,
            tools=SUB_TOOLS
        )

        if not tool_calls:
            return extract_text(response.content)

        messages.append(run_tools(response))

# 主 Agent 收到子 Agent 的最终结果
```

### 运行过程

1.  主 Agent 拆出一个相对独立的子任务。
2.  创建子 Agent，并给它新的消息列表。
3.  子 Agent 使用自己的工具完成工作。
4.  子 Agent 得出最终结论。
5.  只把需要的最终文本返回给主 Agent。

### 为什么要隔离上下文？

如果所有任务都塞进同一个上下文，消息会越来越多，不同任务的信息容易混在一起，主
Agent 也需要处理大量无关内容。独立上下文可以减少这种干扰。

### 本课要点

**设计原则：子任务使用独立上下文执行，主 Agent 接收必要结果。**

图片标注：`s06_subagent/code.py`，383 行，独立可运行。

## 第 7 课：Skill Loading（技能动态加载）

**标题：知识用到时再加载**\
英文：*Load knowledge on demand, not upfront*

### 关键概念

-   `SkillLoader`：技能加载器。
-   系统提示先放技能目录。
-   需要某项技能时，再加载完整内容。
-   不把所有技能全文一开始就塞进上下文。

### 核心代码（按图片整理）

``` python
class SkillLoader:

    def catalog(self) -> str:
        return "\n".join(self.skills)  # 只有目录

    def load(self, name: str) -> str:
        return self.skills[name]  # 命中才加载


SYSTEM = build_system_prompt()  # 目录进入提示词

# 用到哪个技能，再调用 load_skill
```

### 运行过程

1.  系统提示中提供技能目录。
2.  模型根据当前任务判断需要哪个技能。
3.  调用技能加载工具。
4.  取出该技能的完整说明。
5.  将技能内容注入上下文。
6.  按技能说明完成任务。

### 本课要点

一开始加载所有技能全文，会占用大量上下文，也会引入无关信息。按需加载能降低上下文开销。

**设计原则：先提供目录，用到哪个技能再加载哪个技能。**

图片标注：`s07_skill_loading/code.py`，399 行，独立可运行。

## 第 8 课：Context Compact（上下文压缩）

**标题：上下文总会满，先腾地方**\
英文：*Context always fills up --- have a way to make room*

### 关键概念

-   `tool_result_budget`：控制工具结果占用。
-   `snip / micro`：两级裁剪或压缩。
-   `compact_history`：总结较早的历史。
-   最近的结果尽量保留，较早内容可以压缩。

### 核心代码（按图片整理）

``` python
class ContextCompactor:
    CONTEXT_CHAR_LIMIT = 50_000
    KEEP_RECENT_RESULTS = 3

    def compact(self, messages):
        messages = tool_result_budget(messages)
        messages = snip_compact(messages)
        messages = micro_compact(messages)
        return compact_history(messages)
```

### 为什么需要压缩？

Agent 每执行一次工具，就可能产生新的消息和结果：

-   读取文件会产生大量文本。
-   命令执行会产生日志。
-   搜索会返回多条结果。
-   多轮对话会不断累积历史。

如果始终保留所有原始内容，上下文会越来越长，最终超过模型可用窗口。

### 压缩策略

  机制                 作用
  -------------------- ----------------------
  Tool Result Budget   控制工具结果总量
  Snip Compact         裁剪过长内容
  Micro Compact        做更细粒度的压缩
  Compact History      将较早历史整理成摘要

### 本课要点

**设计原则：历史信息可以压缩，但重要信息不能随便丢失；最近且重要的结果应优先保留。**

图片标注：`s08_context_compact/code.py`，601 行，独立可运行。

## 第 9 课：Memory（记忆系统）

**标题：让重要信息跨会话保留**\
英文：*Remember what matters, forget what doesn't*

### 关键概念

-   `extraction`：自动抽取值得保留的信息。
-   `consolidation`：整理、合并、去重。
-   `selection`：根据当前任务挑选相关记忆。

### 核心代码（按图片整理）

``` python
def load_memories(messages) -> str:
    files = select_relevant_memories(messages)
    return read_memory_files(files)  # 最多 5 条


# 会话结束时自动沉淀
extract_memories(messages)
consolidate_memories()  # 合并、去重、修剪

SYSTEM = build_system(relevant_memories)
```

### 运行过程

**1. 抽取记忆（Extraction）**

从会话中提取值得长期保留的信息，例如长期要求、重要项目决策和后续任务需要的背景。

**2. 整理记忆（Consolidation）**

合并重复内容，删除过时内容，修剪无用信息，保留真正有价值的记忆。

**3. 选择记忆（Selection）**

新会话开始时，根据当前任务选择相关记忆，而不是把所有历史都加载进来。图片中的示例最多读取
5 条记忆文件。

### 本课要点

**设计原则：记忆不是保存所有聊天记录，而是抽取、整理，并在需要时选择相关信息。**

图片标注：`s09_memory/code.py`，784 行，独立可运行。

------------------------------------------------------------------------

# 第三部分：持久任务与自动执行（第 10～12 课）

## 第 10 课：Task System（任务系统）

**标题：大目标拆成落盘的任务图**\
英文：*Big goals break into small tasks, ordered, persisted*

### 关键概念

-   `TaskRecord`：持久化任务记录。
-   `blockedBy`：任务依赖关系。
-   `claim / complete`：领取和完成任务。
-   任务及状态保存在磁盘上，而不只存在对话里。

### 核心代码（按图片整理）

``` python
@dataclass
class Task:
    subject: str
    status: str = "pending"
    blockedBy: list[str] = []  # 依赖链


def can_start(task_id) -> bool:
    task = load_task(task_id)
    return not incomplete_dependencies(task)
```

> 注：图片展示的是概念性代码片段。真实 Python 实现中，可使用
> `field(default_factory=list)` 为每个任务创建独立列表默认值。

### 运行过程

以开发一个用户管理系统为例，可以拆分为：

1.  数据库设计。
2.  用户注册。
3.  用户登录。
4.  权限验证。
5.  编写测试。
6.  整体验收。

任务之间可能存在依赖关系。例如，数据库设计完成后才能开始依赖该结构的功能开发。

### 为什么要落盘？

任务持久化后，即使对话关闭、Agent
重启或上下文被压缩，也可以重新读取任务及其状态，继续推进工作。

### 本课要点

**设计原则：任务是需要持久化的数据，不应该只存在于模型的临时上下文中。**

图片标注：`s10_task_system/code.py`，600 行，独立可运行。

## 第 11 课：Background Tasks（后台任务）

**标题：慢操作丢后台**\
英文：*Slow ops go background, agent keeps thinking*

### 关键概念

-   后台线程执行耗时任务。
-   创建后台任务后尽快返回。
-   通过通知队列把完成情况送回主循环。
-   主 Agent 不必一直等待慢操作。

### 核心代码（按图片整理）

``` python
class BackgroundManager:

    def start(self, block) -> str:
        task_id = uuid.uuid4().hex[:8]

        thread = threading.Thread(
            target=self._run,
            args=(task_id, block)
        )

        thread.start()  # 立刻返回，不等

        return f"background: {task_id}"

# 任务完成后，通过 notifications 队列
# 将通知注入主循环
```

### 适用场景

-   安装依赖。
-   编译大型项目。
-   执行大量测试。
-   下载文件。
-   运行时间较长的命令。

### 运行过程

1.  Agent 创建后台任务。
2.  后台线程开始执行。
3.  主循环立即拿到任务标识并继续工作。
4.  后台任务完成后，将结果或状态写入通知队列。
5.  主循环收到通知，再处理结果。

### 本课要点

**设计原则：耗时操作不要阻塞 Agent 的主执行循环。**

图片标注：`s11_background_tasks/code.py`，542 行，独立可运行。

## 第 12 课：Cron Scheduler（定时任务调度）

**标题：按时间自己启动**\
英文：*Fire on schedule, no human kick needed*

### 关键概念

-   Cron 表达式：定义执行时间。
-   `prompt`：定义要执行的任务。
-   `recurring`：是否重复执行。
-   Durable Jobs：将任务持久化，重启后仍然保留。

### 核心代码（按图片整理）

``` python
@dataclass
class CronJob:
    cron: str       # 例如 "0 9 * * 1"
    prompt: str
    recurring: bool = True


def cron_matches(expr, moment) -> bool:
    return all(
        field_matches(f, v)
        for f, v in zip(expr, moment)
    )

# save_durable_jobs()  # 重启后仍然保留
```

### 适用场景

-   每天早上生成项目状态报告。
-   每小时检查服务健康状态。
-   每周一整理工作进展。
-   每月执行一次数据整理。

### 运行过程

1.  创建定时任务，设置 Cron 表达式和任务内容。
2.  将任务保存到持久化存储。
3.  调度器持续检查当前时间是否匹配。
4.  到达指定时间后，将任务注入 Agent 执行。
5.  如果是重复任务，保留下一次触发计划。

### 本课要点

**设计原则：Agent 不仅能响应用户，也可以具备主动、定时执行任务的能力。**

图片标注：`s12_cron_scheduler/code.py`，790 行，独立可运行。

------------------------------------------------------------------------

# 第四部分：多 Agent 协作与外部工具（第 13～14 课）

## 第 13 课：Agent Teams（Agent 团队）

**标题：一个干不完，就组团队**\
英文：*Too big for one agent --- let teammates divide the work*

### 关键概念

-   持久队友与 Mailbox（邮箱）协作。
-   任务原子领取，并使用锁避免重复领取。
-   每个任务绑定独立 Git Worktree。
-   任务之间通过依赖关系协调。

### 核心代码（按图片整理）

``` python
def claim_task(task_id, owner) -> str:

    with task_store_lock():
        task = load_task(task_id)

        if not can_start(task_id):
            return "blocked by dependencies"

        task.owner = owner
        task.status = "in_progress"

        save_task(task)

    # 活跃目录 = task 专属 git worktree
```

### 多 Agent 协作中的问题与解决思路

  问题                            解决思路
  ------------------------------- --------------------------------
  两个 Agent 同时领取同一个任务   使用锁，让领取操作具备原子性
  多个 Agent 修改同一个工作目录   为任务分配独立 Git Worktree
  Agent 之间无法交换进度和结果    使用 Mailbox 进行消息通信
  任务依赖尚未满足                检查依赖，未满足时暂不允许领取

### 角色示例

-   Agent A：后端开发。
-   Agent B：前端开发。
-   Agent C：测试。
-   Agent D：文档整理。
-   主 Agent：分配任务、协调和验收。

### 本课要点

**设计原则：多 Agent
协作不仅需要分工，还需要任务锁、通信机制和独立工作空间。**

图片标注：`s13_agent_teams/code.py`，1887 行，独立可运行。

## 第 14 课：MCP Plugin（MCP 插件）

**标题：能力不够，向外接**\
英文：*Not enough capability? Plug in more via MCP*

### 关键概念

-   `MCPClient`：连接 MCP Server 并发现工具。
-   `tools/list`：获取服务提供的工具列表。
-   `assemble_tool_pool`：组装工具池。
-   外部工具与内置工具进入同一个工具池。

### 核心代码（按图片整理）

``` python
class MCPClient:

    def list_tools(self):
        return self.session.protocol.request("tools/list")


def assemble_tool_pool():

    tools, handlers = [*BUILTIN_TOOLS], {}

    for server in MCP_SERVERS:
        t, h = connect_mcp(server)  # 外部工具
        tools += t
        handlers.update(h)

    return tools, handlers  # 同一个池
```

### 运行过程

1.  连接配置好的 MCP Server。
2.  发现服务提供的工具。
3.  获取工具定义及对应处理器。
4.  把外部工具加入工具池。
5.  和内置工具一起提供给模型。
6.  模型按统一方式选择和调用工具。

### 本课要点

**设计原则：Agent 的能力不应局限于自身，可以通过标准协议接入外部工具。**

图片标注：`s14_mcp_plugin/code.py`，549 行，独立可运行。

------------------------------------------------------------------------

# 第五部分：统一集成（第 15 课）

## 第 15 课：Integrated Harness（集成运行框架）

**标题：多种机制，一个循环**\
英文：*Many mechanisms, one loop*

### 核心思想

前面 14 课逐步建立了各项能力，第 15 课把它们接入同一个运行框架。

图片中的要点：

-   s01～s14 全部接起。
-   共享同一套运行时。
-   机制变多，核心循环不变。

### 核心代码（按图片整理）

``` python
# 一个循环，挂上全部机制：

agent_loop(
    messages,

    tools=builtin + mcp_pool,       # s02 + s14

    hooks=[permission, log],        # s03 + s04

    memory=load_memories(msgs),     # s09

    tasks=TaskStore('.tasks'),      # s10

    team=mailbox + worktrees,       # s13

    cron=durable_scheduler,         # s12
)
```

### 整合关系

  机制               对应课程   作用
  ------------------ ---------- ---------------
  Agent Loop         第 1 课    核心运行循环
  Tool System        第 2 课    工具调用
  Permission         第 3 课    权限控制
  Hooks              第 4 课    扩展机制
  TodoWrite          第 5 课    任务计划
  Subagent           第 6 课    子 Agent
  Skill Loading      第 7 课    技能加载
  Context Compact    第 8 课    上下文压缩
  Memory             第 9 课    长期记忆
  Task System        第 10 课   持久化任务
  Background Tasks   第 11 课   后台执行
  Cron Scheduler     第 12 课   定时调度
  Agent Teams        第 13 课   多 Agent 协作
  MCP Plugin         第 14 课   外部工具接入

### 本课要点

**设计原则：功能可以越来越多，但底层应该共享一套统一的运行框架，避免每个模块维护一套互不相同的
Agent 执行逻辑。**

图片标注：`s15_integrated_harness/code.py`，3326 行，集成实现。

------------------------------------------------------------------------

# 第六部分：工作流与目标验收（第 16～17 课）

## 第 16 课：Workflow Runtime（工作流运行时）

**标题：编排形状固定，就写进脚本**\
英文：*When the orchestration shape is fixed, put it in code*

### 关键概念

-   固定流程由代码编排。
-   模型负责提供参数或必要判断。
-   `WorkflowJournal`：记录每一步的执行结果。
-   支持中断后恢复执行。

### 核心代码（按图片整理）

``` python
class WorkflowJournal:

    def record(self, run_id, step, result):
        append_jsonl(self.path(run_id), result)


class WorkflowTool:

    async def run(self, meta, inputs):
        state = ExecutionState(meta, journal)
        return await state.resume_or_start(inputs)

# 记录每一步，重启后从对应步骤继续
```

### 什么时候适合 Workflow？

例如一个固定的订单处理流程：

1.  查询订单。
2.  验证订单状态。
3.  扣减库存。
4.  创建物流单。
5.  发送通知。

如果流程本身是固定的，就不必每一步都让模型重新决定下一步是什么。可以把流程写进程序，让模型负责参数和必要判断。

### Journal 的作用

每执行一步，就记录步骤和结果。中断后读取日志，判断哪些步骤已经完成、从哪里继续。

  步骤         执行状态
  ------------ --------------
  查询订单     已完成
  验证订单     已完成
  扣减库存     已完成
  创建物流单   中断或待恢复
  发送通知     尚未执行

### 本课要点

**设计原则：固定流程交给代码编排，执行过程持久化，支持中断恢复。**

图片标注：`s16_workflow_runtime/code.py`，888 行，独立可运行。

## 第 17 课：Goal Loop（目标控制循环）

**标题：目标决定循环何时能停**\
英文：*A goal decides when the loop may stop*

### 关键概念

-   `GoalController`：目标状态控制器。
-   `evaluator`：独立评估器。
-   模型提出停止，不代表任务一定完成。
-   评估未达标时，阻止停止并继续执行。

### 核心代码（按图片整理）

``` python
class GoalController:

    def on_stop_proposed(self) -> StopDecision:

        verdict = evaluator.evaluate(
            goal=self.active,
            transcript=history
        )

        if verdict.met:
            return StopDecision(allow=True)

        return StopDecision(
            allow=False,
            reason=verdict.reason
        )  # 继续干
```

### 为什么需要 Goal Loop？

Agent 可能做了一部分工作，就认为自己已经完成。但实际上：

-   代码可能没有写完。
-   测试可能没有通过。
-   文档可能没有更新。
-   用户要求可能没有全部实现。
-   验收条件可能没有满足。

因此，需要一个独立机制判断目标是否达成，而不是只依赖模型自己宣布完成。

### 运行逻辑

1.  Agent 提出停止。
2.  Goal Evaluator 根据目标和执行记录进行评估。
3.  如果目标达成，允许停止并返回结果。
4.  如果目标未达成，拒绝停止，并把未完成原因交回执行循环。

### 本课要点

**设计原则：Agent
是否完成任务，应该由目标验收机制决定，而不是只由模型自己宣布。**

图片标注：`s17_goal_loop/code.py`，903 行，独立可运行。

------------------------------------------------------------------------

# 总结：17 课背后的整体设计

## 一、六大组成部分

  部分                    课程范围   主要职责
  ----------------------- ---------- ------------------------------------
  核心执行层              01～04     循环、工具、权限、扩展点
  智能管理层              05～09     计划、子 Agent、技能、上下文、记忆
  持久任务层              10～12     任务持久化、后台执行、定时调度
  多 Agent 与外部能力层   13～14     团队协作、MCP 工具接入
  统一运行层              15         把所有机制集成到同一个 Harness
  工作流与目标控制层      16～17     确定性流程、中断恢复、目标验收

## 二、完整运行关系

可以把整套系统理解为以下过程：

``` text
用户提出目标
    |
    v
上下文与记忆管理
(Context Compact + Memory + Skill Loading)
    |
    v
任务规划与组织
(TodoWrite + Task System + Subagent + Agent Teams)
    |
    v
核心 Agent Loop
(模型思考、决定下一步、选择工具)
    |
    v
安全与执行机制
(Permission + Hooks + Tool Use + MCP)
    |
    v
执行管理
(Background Tasks + Cron + Workflow Runtime)
    |
    v
结果回传与目标验收
(Goal Loop)
    |
    +---- 未达成：继续循环
    |
    +---- 已达成：返回最终结果
```

这是对 17
课的概念归纳，不代表图片给出了完全相同的模块调用顺序。实际系统中，记忆、任务、后台执行和工作流可能在不同阶段被调用。

## 三、五条最重要的设计原则

### 1. 核心循环保持简单

模型负责判断，代码负责执行，工具结果返回模型。不要让主循环变成所有功能的堆积地。

### 2. 状态不能只依赖对话上下文

任务、记忆、后台作业、定时任务和工作流进度，需要根据场景持久化。对话结束或模型上下文压缩，不应该导致工作状态丢失。

### 3. 执行能力必须有安全边界

工具执行前要做权限检查。敏感操作需要确认，禁止操作直接拒绝。任务结束前还要做目标验收。

### 4. 不同类型的工作使用合适的机制

-   固定流程：Workflow。
-   耗时操作：Background Tasks。
-   定时工作：Cron Scheduler。
-   大型任务：Task System 和 Agent Teams。
-   可复用知识：Skill Loading。
-   跨会话信息：Memory。

不要让所有事情都依赖模型自由发挥。

### 5. 判断完成，要看目标是否达成

模型说"完成"不等于客观上真的完成。需要检查目标、结果和验收条件。

## 四、最后一张总览图的含义

总览图中央写着：

> 造好车，交给司机。

图片底部总结：

> 十七课走完。你会发现。你搭的，不是智能本身。是智能落地的世界。把车造好。剩下的，交给司机。

可以这样理解：

-   模型提供智能。
-   Agent 内核提供运行环境。
-   工具提供执行能力。
-   权限提供安全边界。
-   记忆提供持续性。
-   任务系统提供组织能力。
-   工作流提供确定性。
-   目标控制提供验收能力。

**这套课程的重点不是重新创造一个模型，而是为模型建立一个能够安全、持续、可控地完成工作的运行系统。**

## 课程图片来源与代码索引

总览图中标注的课程来源：

`github.com/shareAI-lab/learn-claude-code`

各课图片中的代码文件及行数：

  课程   图片标注的代码路径                   行数
  ------ ---------------------------------- ------
  s01    `s01_agent_loop/code.py`              151
  s02    `s02_tool_use/code.py`                206
  s03    `s03_permission/code.py`              267
  s04    `s04_hooks/code.py`                   286
  s05    `s05_todo_write/code.py`              368
  s06    `s06_subagent/code.py`                383
  s07    `s07_skill_loading/code.py`           399
  s08    `s08_context_compact/code.py`         601
  s09    `s09_memory/code.py`                  784
  s10    `s10_task_system/code.py`             600
  s11    `s11_background_tasks/code.py`        542
  s12    `s12_cron_scheduler/code.py`          790
  s13    `s13_agent_teams/code.py`            1887
  s14    `s14_mcp_plugin/code.py`              549
  s15    `s15_integrated_harness/code.py`     3326
  s16    `s16_workflow_runtime/code.py`        888
  s17    `s17_goal_loop/code.py`               903

> 注意：以上路径和行数来自课程图片中的标注，尚未在源码仓库中逐一核验。本文是课程图片整理稿，不是源码审计报告。
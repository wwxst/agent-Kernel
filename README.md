# agent-Kernel

最小 Coding Agent：**一个类、一个循环、七个工具、三档权限**，运行时零依赖。

> 当前状态：v0.5，个人练习项目。

## 快速开始

需要 Node.js **>= 22.18**（从 22.18 起可以直接 `node xxx.ts`，靠内置的 type stripping，不需要构建）。

```powershell
Copy-Item .env.example .env    # 填入 API_KEY；用什么模型由你决定
npm run agent -- "给这个仓库加一个 /health 接口并写测试"
npm run agent -- --repl        # 多轮会话：/exit 退出、/reset 清空上下文、/permission 查看或切换权限、/help 看命令
npm run agent -- --tui         # Claude Code 风格聊天 TUI：顶部信息、对话、固定输入、审批
npm run agent -- --tui "先看看这个仓库的结构"   # TUI 先跑这个任务，之后继续等输入
npm run agent -- --permission read-only "先看看这个仓库的结构"   # 只读模式
npm run agent -- --permission full-access "跑测试并修掉失败"     # 全部工具、不审批
```

### TUI 屏幕模式与窗口缩放

`--tui` 默认使用 `AGENT_TUI_SCREEN=auto`：仅在有明确能力线索的 Windows Terminal、VS Code 终端或受支持的 POSIX TERM 中启用**独立屏幕**，其他终端保守降级为行式聊天；检测不能百分之百确认终端能力，遇到兼容问题可设 `never`。独立屏幕里历史、输入栏、工具与动态状态从内存日志重绘，退出时恢复原来的 Shell 画面。拖动窗口时把连续 resize 合并，75ms 内不反复清屏；窗口太小只显示提示，放大后恢复原会话内容。

在传统 Windows CMD/ConHost 或无法确认终端支持备用屏幕的环境，会自动降级为**行式聊天**，避免把同一个全屏画面不断写进终端滚动历史。可以在 `.env` 明确指定：

- `AGENT_TUI_SCREEN=auto`（默认）：能安全独占屏幕时使用完整 TUI，否则兼容行式聊天。
- `AGENT_TUI_SCREEN=always`：强制在真实交互终端进入独立屏幕；仅在终端确实支持时使用。
- `AGENT_TUI_SCREEN=never`：始终使用兼容行式聊天，适合排查旧终端兼容问题。

独立屏幕不是 Shell 滚动历史：对话可用 TUI 的 PageUp/PageDown 浏览，退出会恢复启动前的终端内容。TUI 为每条已提交的展示日志分配**仅在本次会话有效的内部 ID**，缩放和工具活动展开时按 ID 与文本偏移恢复历史视口；这些 ID 不显示、不写入 Transcript，也不进入模型请求。被日志上限裁剪的锚点会退到剩余记录并在状态栏提示“历史已截断”。`auto` 无法确认终端能力时，启动时只提示一次已使用行式兼容模式。同步更新协议用于降低闪烁，若终端忽略该协议，仍通过清屏、逐行定位和单次写入保证最终画面的确定性；真实终端仍需人工验收。所有模式均保留真实的 Agent Transcript，不修改工具权限或模型请求。

`npm install` 只在跑类型检查和测试时需要；`npm run agent` 本身不需要任何依赖。

CLI 默认流式输出：模型生成正文时逐段打印，长回复不再是黑屏等一段。评测走非流式，保证跨轮对比的是同样的完整响应（见 [ADR-0012](./docs/adr/0012-streaming-is-display-only.md)）。

### 执行阶段与角色台词

CLI 将真实的执行事件展示为 **Preparing → Thinking → Tool → Answering → Completed / Failed / Cancelled**。每次模型请求有独立思考阶段，工具调用开始、返回结果会依次出现；结束时展示真实耗时和已处理的工具调用数（含权限拒绝、参数校验失败；未执行的预算跳过不计），原有 `[usage]` 账单仍保留。工具出错时标记 ✗，不会因为台词活泼就宣称任务成功。台词只是展示层文案，不进入模型提示词或 Transcript。

- 默认 **compact**：每条工具一行摘要，按模型 Step 连续排列，方便快速扫过。
- `npm run agent -- --details "任务"`：**detailed** 模式，每条工具结果单独展开多行；超过 4000 字符会标明省略字符数。也可在 `.env` 设 `AGENT_VIEW=detailed`。
- CLI 与 TUI 都会将 Shell 非零退出、超时、取消标为工具失败；模型若随后修复并给出有效答复，整轮 Run 仍可成功。Agent 的展示回调为尽力通知，异常不影响执行或 Transcript 配对；累计次数可通过 `observerFailureCount` 诊断。
- `AGENT_VOICE=balanced`（默认）轮换元气、调皮、傲娇、好奇、温柔、可靠六类短句；也可以设 `energetic` / `playful` / `tsundere` / `curious` / `gentle` / `confident` 固定语气。台词随阶段变化，不是定时随机冒泡。

终端本身没有可点击折叠组件，因此这里用 **compact/detailed 两种视图** 替代网页里的逐条点击展开；详细模式的日志同样有长度上限。

## 代码结构

十个模块，依赖只有一个方向。`types.ts` 是叶子；`errors.ts` 只依赖 `types.ts` 的类型，`permission.ts` 复用 `errors.ts` 的 `describeError`，`approval.ts` 只依赖 `permission.ts` 的类型：

| 文件 | 一句话 |
| --- | --- |
| `src/types.ts` | 协议词汇：`Message`、`Tool`、`ToolDefinition`、`ChatClient`。不依赖任何人 |
| `src/errors.ts` | 错误文案兜底：`describeError()` 把任何抛出物变成一行非空文本；`describeValue()` 渲染非法配置值 |
| `src/agent.ts` | 内核：循环、消息顺序、请求/工具预算、生命周期；system 提示支持函数式动态刷新 |
| `src/tool-registry.ts` | 工具注册表：Schema 校验、按名字找工具、解析参数、显式权限注入、把失败折成 `ERROR` 文本 |
| `src/permission.ts` | 权限策略：三档模式、`permissionPrompt` 模型指导、shell 的一次性审批、拒绝原因。只判断工具调用放不放行，不做隔离 |
| `src/approval.ts` | 审批提示的格式化与读取：完整命令、cwd、控制字符转义，并把 `AbortSignal`、readline 关闭、正常回答一起收口 |
| `src/workspace.ts` | 工作区：文件工具作用的那棵目录树 —— 读、写、改、找文件、搜内容、列目录、跑命令，外加路径守卫、有界读取、扫描预算与取消 |
| `src/llm.ts` | `ChatClient` 的 HTTP 实现，POST 一个 OpenAI 兼容端点并保留 `usage` |
| `src/tui.ts` | TUI：聊天布局、任务前/中/结束状态、真实 AI 阶段说明与工具活动分组、工具失败同行展示、Ctrl+O 活动详情、审批与终端降级；不触碰 Agent Loop |
| `src/tui-mood.ts` | 状态驱动的中英文角色短句库：元气、调皮、好奇、温柔为主，少量傲娇/天然；临时展示、不写 Transcript |
| `src/cli.ts` | 组装层：命令行参数 / 环境变量 → 对象图 → 跑一次任务、进 REPL 或进 TUI |
| `src/cli-presenter.ts` | CLI 展示：执行阶段、动态台词、工具日志精简/详细视图；不写入 Transcript |
| `src/tool-result-status.ts` | CLI/TUI 共享的工具失败判断：Shell 的非零退出、超时、取消；不修改回灌模型的文本 |

`src/grep-worker.ts` 不算第十一个模块，它是 `Workspace.grep` 的匹配线程：正则跑在里面，主线程超时就 `terminate`（见 [ADR-0010](./docs/adr/0010-grep-regex-in-worker.md)）。

`agent.ts` 不认识 `workspace.ts`：循环只管「问模型、执行调用、塞回结果」，工具怎么实现的它不关心。
它也不认识 `tui.ts`：TUI 只是把 Agent 的回调接到显示层，循环本身不知道有没有界面。这就是为什么换模型、换工具集、换交互壳，循环一行都不用改。展示观察者精简为四个：`onRequestStart(step)`（每个 Run 从 1 计）、`onToolCall(call)`、`onToolResult(call, result)`、`onDelta(text)`；原先重复的 `onStepStart` / `onToolStart` 已移除，外部调用方需要迁移。

命令、代码地图、测试放哪见 [AGENTS.md](./AGENTS.md)；怎么写代码（注释风格、模块形状、命名、错误处理）见 [CODING_STANDARDS.md](./CODING_STANDARDS.md)。

## 核心循环

`src/agent.ts` 里的 `Agent.run()`，对应设计稿里的伪代码。它就是 **agent loop** —— 教科书里那个 `while (true)` 的原型，外加三道闸门：模型请求次数、工具执行次数、取消信号。

```ts
this.messages.push({ role: "user", content: task });

for (let step = 1; step <= this.maxSteps; step++) {
  const response = await this.llm.chat(this.messages, this.tools.definitions);
  this.messages.push(response.message);

  const calls = response.message.tool_calls ?? [];
  if (calls.length === 0) return response.message;

  // 最后一步 / 工具预算 / token 预算：不执行无法被后续请求验证的工具。
  stopIfNoBudgetLeft(step, calls);

  for (const call of calls) {
    const result = await this.tools.execute(call);
    this.messages.push(createToolResult(call, result));
  }
}
```

逐段理解：

1. **消息就是全部状态。** 模型无状态，它「记得」什么，完全取决于我们每轮重发多少。
2. **先入栈，再判断。** 带 `tool_calls` 的 assistant 消息必须先写进历史，工具结果才能跟在它后面。
3. **`tool_call_id` 是配对钥匙。** 每条 tool 消息靠它说明自己在回应哪一次调用，写错直接被 API 拒绝。
4. **没有工具调用 = 交卷。** 这就是循环唯一的正常出口。
5. **工具错误也要「入栈」。** 失败被折成 `ERROR: ...` 文本，模型下一轮能看见并自己纠正。
6. **两个执行预算分开算。** `maxSteps` 数「问了模型几次」，`maxToolCalls` 数「真正跑了几个工具」。一次回复可以要 3 个工具，只用一个数字会假装管住了另一个。
7. **最后的请求预算留给收尾。** 走到第 `maxSteps` 次请求时，模型只能给最终答复；它还要工具，那些工具不执行 —— 没有下一次请求去验证结果，执行了就是一批「跑过但没人看过」的副作用。
8. **一个实例是一段会话，可以连续跑多个 Run。** 每次 `run()` 是一次 Run：Transcript 跨 Run 累积，但 Step / 工具 / token 三个预算按 Run 重新算；同一时刻只允许一个 Run 在跑。失败的一轮不会销毁会话，历史留在 Transcript 里（`/reset` 是干净的退出方式）。取舍见 [ADR-0011](./docs/adr/0011-agent-can-run-many-times.md)。

## 与设计稿的对应

| 设计稿 | 本实现 |
| --- | --- |
| `llm.chat(messages, tools)` | `Llm.chat()`，POST `{BASE_URL}/chat/completions`（OpenAI 兼容） |
| `executeTool(call)` | `ToolRegistry.execute(call)`：工具表在对象里，不再是到处传的全局变量 |
| `createToolResult(call, result)` | `{ role: "tool", tool_call_id: call.id, content: result }` |
| `while (true)` | `for` + `maxSteps` |

字段名保留协议原样（`tool_calls`、`tool_call_id`），请求体可以原样序列化，不需要来回翻译。这个选择记在 [ADR-0001](./docs/adr/0001-keep-wire-field-names.md)。

## 七个工具

工具名是模型看到的接口，所以用的是 agent 生态里的通用叫法（`read` / `write` / `edit` / `glob` / `grep` / `ls` / `shell`），不是本仓库方法名的直译：

| 工具 | 说明 | 对应工作区方法 |
| --- | --- | --- |
| `read` | 读 UTF-8 文本，超过 8k 字符截断 | `Workspace.read` |
| `write` | 创建/覆盖整个文件，自动建父目录 | `Workspace.write` |
| `edit` | 把唯一命中的一段换成另一段 | `Workspace.edit` |
| `glob` | 按模式找文件，如 `src/**/*.ts` | `Workspace.glob` |
| `grep` | 按正则搜文件内容，回 `路径:行号: 内容`；匹配跑在 worker 里，超时中断 | `Workspace.grep` |
| `ls` | 列目录：类型、字节数、名称 | `Workspace.list` |
| `shell` | 在工作区根目录跑 shell；超时/取消杀整棵进程树，输出有上限 | `Workspace.run` |

前三个是「改文件」，中间两个是「找东西」，`ls` 看一层目录，`shell` 是兜底。模型先找后改，顺序和它自己的直觉一致。

`write` 和 `edit` 的分工就是名字说的那件事：改几行用 `edit`（省 token，也不会因为「只改三行却重写整个文件」把长文件改坏），新建文件或整体重写才用 `write`。

`edit` 要求 `old_string` 恰好命中一次：0 次或多次都回 `ERROR`，模型读一遍文件再收窄片段。行号定位会随后面的改动漂移，原文片段不会。这个取舍记在 [ADR-0006](./docs/adr/0006-edit-by-unique-snippet.md)。

`glob` 是自己遍历工作区再拿模式去套，而不是把模式交给 `fs.glob` 展开：后者支持花括号展开，`{../outside,src}/**/*.ts` 会变成两条模式，光靠字符串检查拦不住，能直接跑到工作区外。自己走目录从结构上就走不出去，代价是只支持 `*`、`**`、`?` 三种通配。

叫 `shell` 而不是 `bash`：实现是 `spawn(command, { shell: true })`，真正由哪个 shell 解释取决于平台，叫 `bash` 就是承诺了没做到的事。这个取舍记在 [ADR-0005](./docs/adr/0005-name-tools-after-the-ecosystem.md)。

路径统一过工作区的路径守卫：`../`、绝对路径、跨盘符都会被拒绝；解析之后还会再比一次**真实路径**，所以符号链接、junction 指向工作区外时同样会被拒绝。错误变成 `ERROR: path escapes workspace` 回灌给模型。文件读写使用校验后的真实路径，编辑通过同一个句柄读写；写入/编辑在提交修改前复查取消信号，POSIX 文件打开也避免跟随末端符号链接。**已知边界：这不能完全消除恶意并发替换父目录的 TOCTOU 竞态，Windows 不支持同样的末端链接打开标志；仍应按 Trusted Local Agent 使用。**

已知边界：`glob` 只认 `*`、`**`、`?` 三种通配，`{}`、`[]` 按字面匹配（这是刻意的，见下）；`glob` / `grep` 默认跳过 `.git` 和 `node_modules`、最多回 200 条命中，单次最多访问 20 000 个目录项，符号链接不跟随；`read` 最多读 32 KB，`grep` 按字节读到 1 MB 为止、超出的文件跳过，`edit` 不接受超过 2 MB 的文件（读不全就拒绝，绝不拿半截内容覆盖），`ls` 最多展示 500 条、扫到 20 000 项就停。`grep` 的正则匹配另有 2 秒预算（只算匹配时间，不算读文件），超时会杀掉匹配线程并标注结果不完整。目录用 `opendir` 边读边收，预算限制的是真正读了多少项，而不是 `readdir` 之后切了多少项；所有截断、跳过、没搜完的统计都保留在结果末尾，不会被结果自己的长度上限吃掉。扫描提前停手时会明说 `results may be incomplete`，不会声称拿到了全局排序结果。

`grep(path)` 使用经过真实路径校验的物理起点，不再沿可变的路径别名展开目录；深层目录在枚举与打开之间仍存在已知 TOCTOU，完全隔离需要 OS 级目录句柄约束。

`glob` / `grep` 达到 200 条命中上限时，返回的是**遍历顺序里先遇到的那 200 条**；排序只保证这 200 条内部有序，不保证是全局字典序的前 200 条。要拿稳定 Top N 就得扫完整棵树，那会牺牲扫描预算，所以第一阶段先保留现状并明确标注不完整。已记录为后续优化项。

`grep` 支持**正则**（JavaScript 语法，逐行匹配），但匹配不跑在主线程：每条正则在 `grep-worker.ts` 的线程里执行，主线程只守 2 秒的匹配预算，超时就 `terminate`，把整个线程连同指数级回溯一起扔掉。这样「输入不能让 agent 卡死」仍然成立，而模型拿回了 `a.*b` 这类能力——第一阶段的字面搜索是当时没有 worker 的权宜之计。代价是每次 grep 多一个线程的启动开销，以及结果可能因预算而部分缺失（尾注会明确写 `regex stopped after 2000ms`）。要搜 `a.b`、`([` 这种字面文本，传 `fixed: true` 就能关掉正则解释。取舍记在 [ADR-0010](./docs/adr/0010-grep-regex-in-worker.md)。

写入与编辑现在先写同目录临时文件，完整写入并同步后再以 rename 提交；取消或写入失败会保留原文件并清理临时文件。既有文件尽量保留 POSIX mode，提交前复查目标身份与真实路径。已知边界：替换改变 inode / hardlink 关系，Windows 的 ACL、文件占用及 rename 语义不保证与原地覆盖完全一致；父目录并发替换仍存在 TOCTOU，原子提交不等于隔离沙箱。

Windows `taskkill /T` 最多等待 2 秒：只有它以 0 退出才确认成功。启动失败、非零退出或卡住时，尝试 `child.kill()` 停掉直接子进程，**并以错误报告「进程树清理未确认，可能仍有后代运行」**，而不是冒充清理完成。停止后的子进程管道最多等待 4 秒；如果 stdout/stderr 被残留后代持续占用，也要终止等待、明确报错。注意：Node 自带的 `child.kill()` 不能保证 Windows 孙进程退出；自动故障注入与真实 Windows 进程树超时/取消测试也不能证明所有异常环境均可回收。

还有一条更根本的：**`shell` 不受路径守卫约束**——命令里写 `cd ..`、`cat ../x` 照样能出去，进程权限跟启动它的人一样。这套路径守卫是「防模型手滑」的边界，不是安全边界；真隔离得靠容器、独立用户或只读挂载。见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)。

## 权限（Permission v0.1）

三档模式，默认 `workspace-write`：

| 模式 | 文件工具 | `shell` |
| --- | --- | --- |
| `read-only` | 只放行 `read` / `ls` / `glob` / `grep` | 拒绝 |
| `workspace-write`（默认） | `read` / `ls` / `glob` / `grep` / `write` / `edit` | 每次执行前问一次 |
| `full-access` | 全部工具 | 直接执行 |

检查发生在 `ToolRegistry.execute()` 里：参数校验通过之后、`tool.run()` 之前。被拒绝的调用不会执行，结果是一条 `ERROR: permission denied: ...` 回灌给模型，模型可以在下一轮自己换个做法。

`ToolRegistry` 构造时必须显式传 `permission: Permission | null`：传 `Permission` 启用策略，传 `null` 表示宿主主动关闭检查；漏传、`undefined`、字符串等非法值在装配阶段直接报错。CLI 默认 `workspace-write`（`--permission` 可覆盖），评测显式传 `full-access`，测试按需显式传 `null` 或 `Permission`。

CLI 用 `--permission <mode>`（也支持 `--permission=<mode>`）选起始模式；REPL 用 `/permission` 查看、`/permission read-only` 切换。`/reset` 只换 Agent 和 Transcript，不改变当前权限。

Agent 每次模型请求前都会把当前 `permissionPrompt(mode)` 写进唯一的 system 消息；`/permission` 切换后下一次请求立即生效，不会追加第二条 system 消息。这个 Prompt 只指导模型，真正的放行/拒绝仍由 `ToolRegistry` 执行。

`workspace-write` 下的 `shell` 每次都要人工确认：输入 `y` / `yes` 允许这一次，其他输入（包括空行）都拒绝。**如果等待审批期间切换过权限（即使随后切回），本次批准会作废，必须重新请求授权。**审批界面完整展示待执行命令与实际 cwd：多行命令逐行加 `|` 前缀，控制字符与 bidi 控制字符转义，不折叠换行、不截断尾部。没有 TTY、取消、审批通道异常都按拒绝处理；无 TTY 时不会去读 stdin，避免把管道里的下一行任务当成审批答案。审批等待同时绑定 `AbortSignal` 与 readline 的 `close`：Ctrl-C 会立即结束等待并走取消链（退出码 130），EOF 会明确结束等待并按拒绝处理，不会卡在 `question()` 上。REPL 和审批共用同一个 readline，并按顺序一次只等一行；如果任务运行期间已经排着下一行输入，这次 shell 会被拒绝，那一行留给下一轮任务，不会被当成审批答案。

**Permission 不是 Sandbox。** 它只决定一次 Tool call 放不放行，不改变进程的操作系统权限：没有容器、没有用户切换、没有只读挂载。`workspace-write` 的 `shell` 一旦被批准，子进程就和启动它的人同权，可以 `cd ..` 走出工作区；`read` / `write` 的路径守卫拦的是模型手滑，不是恶意代码（见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)）。真隔离得靠容器、虚拟机、独立用户或只读挂载，不能靠 Permission 的字符串判断。取舍见 [ADR-0013](./docs/adr/0013-permission-is-a-policy-not-a-sandbox.md)。

## 轻量 TUI v0.3

`npm run agent -- --tui` 在同一个 Agent / Permission 会话外面套一个聊天式终端界面；`--repl` 保持原样，两者不能同时用。`--tui` 后面可以跟一个初始任务：先跑完，再等下一行输入。布局与验收规则见 [TUI v0.3 规范](./docs/design/tui-v0.3-layout-spec.md)。

布局：

- **顶部**：项目名（左）和 model（右），下一行是 workspace 路径，再一条分隔线。
- **对话区**：内容从视口顶部向下排列；用户 `❯`、模型真实发言 `✻`。每轮任务在用户输入下方显示固定位置的生命周期标题（准备执行 → 正在执行 + 已用时 → 已完成/执行失败/已取消 + 实际耗时）。模型真实输出的阶段性说明按原文保留，随后发生的工具调用合并为该阶段下方的独立 `↳` 摘要；未输出阶段说明时不伪造模型发言。短会话输入框跟随内容，长会话靠底部。
- **Markdown 代码块**：固定布局隐藏代码块围栏行（三个反引号那一行），块内正文缩进并用竖线标出；行式兼容模式保持原文。只改展示，不改模型回复、Transcript 或工具结果。
- **输入框**：短会话紧跟当前消息，长会话自动停靠底部；用两条灰色横线划分输入区域，与正文共享左边缘。空会话显示占位符 `Ask anything, or type /help...`，开始对话后只保留提示符和光标。长输入横向滚动，提交原文不变。readline 保留编辑缓存，TUI 统一绘制，输入期间的新输出也能刷新。
- **状态行**：始终紧跟输入框**下方**，左边当前权限（`read-only` / `workspace-write` / `full-access`），有空间时显示 `(shift-tab to cycle)`，右边 requests / tool calls / tokens。
- **中英文自动适配**：交互式 TUI 启动时按系统语言初始化（中文系统用中文，其余用英文；非 TTY 输出保持英文）；每次用户提交自然语言任务时，根据任务主要语言切换界面自带的工具标签、审批菜单、统计、状态和命令帮助。路径、代码片段、文件名不作为语言识别依据；混合输入按中文字符数与英文单词数判断；无语言内容时沿用上一轮语言。不翻译模型回复、Shell 命令、工具实际返回内容或权限模式 ID（`read-only` 等）。**`Thinking...` 永远保持英文、动画和计时逻辑不变。** 不增加运行时依赖。

- `auto` 检测到支持时使用 alternate screen，不引 TUI 库；普通帧差分绘制、清屏与内容在一个同步帧内写出。无法确认能力的终端以及非 TTY（管道、CI、e2e）采用逐行输出；`never` 可强制兼容模式。

工具与审批：

- **工具活动**：读取/搜索/修改/执行命令等真实工具事件按出现顺序归入当前阶段；每段的简短摘要最多显示 **3 种不同操作**，有第 4 种时在末尾加「等」（英文 `etc.`），不显示成功/失败次数总账。运行中展开当前组以便看到具体文件、命令、耗时和结果；结束后自动折叠工具细节，但保留每一段真实 AI 发言及摘要。`Ctrl+O` 从最近一段开始向前循环，分别切换各组明细；再次选中该段可单独收起，历史轮次中尚保留的组也可查看。
- **失败/拒绝/未执行**：正常任务中的首条错误摘要与具体命令**同行**（例如 `✗ npm run check 失败 · exit 1 · TypeScript 类型检查未通过`）；即使活动组已经折叠，仍保留失败行。展开后可预览实际返回的原始错误文本；错误原因不由界面猜测。权限拒绝绝不标成已执行；不把读取文件的原始正文整份刷进摘要。
- `workspace-write` 下的 `shell` 审批在固定 TUI 里使用 Claude Code 风格的**两项键盘菜单**：完整 workspace、原始多行命令、`1. Yes, allow once` / `2. No (default)`；上下键选择、Enter 确认、Esc 拒绝，默认选中 No。审批时不显示额外的文本输入框或聊天状态栏，误输入/粘贴 `y`、`1` 也不会隐形授权；菜单结果只作用于本次调用，**没有永久授权选项**。非固定布局继续原来的 `y/N` 逐行审批（只有明确输入 `y` / `yes` 才放行），无 TTY 时默认拒绝。

外观与交互：

- 自动检测颜色能力：16 色 / 256 色、`NO_COLOR`、`TERM=dumb`；无颜色终端仍靠框线和符号可读。
- Windows Terminal / VS Code 终端 / Linux 使用 `❯`、`✻`、`●`、`✓`、`✗`、`⊘`、`┌┐└┘─│`；传统 Windows conhost 退化成 `>`、`*`、`o`、`+`、`x`、`!`、`-`、`|`，不会显示方框。
- **流式内容与失败**：TUI 固定布局在模型响应写入 Transcript 前显示暂态正文；若最新请求流式失败，则撤销未确认草稿并提示中断。若响应已经确认，但之后触发 Step、Token 或工具调用预算失败，则**保留真实模型正文，同时把整个 Run 标成失败**；已通过工具开始事件提交的阶段正文也不重复展示。逐行终端不能收回已经输出的字节，会明确标记其未确认。普通 CLI 同样对模型正文、工具结果、工具名里的控制字符与 bidi 字符做可见转义。
- **实时状态与角色语气**：`Thinking...` 保留英文、200ms 文本符号动画和真实计时；读取/搜索/编辑/写入/运行命令等状态只由真实 Agent 回调与工具名驱动。状态右侧 `│` 后显示一条轻快、略带傲娇的中英文短句，按状态和人格元素加权抽取，避开最近重复；持续约 15 秒才可能更换。短句不是模型思考内容，不增加 API 请求，也**不写入执行历史或最终回复**。窄屏时隐藏短句；审批和失败只展示明确、可信的操作信息，不能用俏皮话掩盖授权或错误。
- **历史滚动**：PageUp / PageDown 查看之前对话，状态行显示 `↑ N lines` / `^ N lines`；滚动期间新输出不把视口拉回底部，发送新任务时回到最新。
- **窗口 resize**：监听 stdout 的 resize 事件，重新计算标题、对话视口、审批面板、输入框和状态行。小于 12 行或 30 列时使用逐行输出，放大后恢复固定布局并保留草稿与 Run log；`TERM=dumb` 始终逐行显示。
- **Slash 命令补全**：TUI 中输入 `/` 会在输入框**下方**展开当前程序实际支持的 `/help`、`/permission`、`/reset`、`/exit`、`/quit`；继续输入前缀实时筛选。方向键只移动高亮，不改变 readline 的输入历史；`Tab` 把高亮命令补全到编辑框但不执行，`Enter` 执行高亮命令，`Esc` 收起菜单且保留原输入；查询变更后可重新弹出。说明文案跟随中英文 UI 语言，不展示尚未实现的 Claude Code 命令。菜单不写入 Transcript，已有 `/permission read-only` 等参数命令照常处理。小终端最多显示可容纳的条目，支持 resize；审批菜单优先，不混用按键。
- **权限快捷键**：在等待输入下一条任务时按 `Shift+Tab`，依次从 `read-only` → `workspace-write` → `full-access` → `read-only` 循环。进入 `full-access` 须再按一次 `Shift+Tab` 确认，Esc 或其他键取消待确认；运行中和 Shell 审批中不可用。快捷键直接更新同一个 Permission 对象，下次模型请求读取更新后的权限说明，不改变 Transcript；普通 Tab 不切模式。部分终端不能区分 Shift+Tab 时仍可使用 `/permission [mode]`。
- 命令与 REPL 相同：`/exit`、`/reset`、`/permission [mode]`、`/help`。`/reset` 换 Agent，不换 Permission；`/permission` 切换后状态行和下一次请求同时生效。

流式正文只是临时展示。已确认的 `assistant.content` 才是最终权威消息：固定布局可以替换有偏差的草稿；行式 CLI / TUI 无法撤回已写入终端的字节，会追加明确的 `[stream corrected: confirmed message follows]` 更正提示。同一条 assistant 的多次工具调用只确认一次阶段说明，避免重复模型发言。

统计按 Session 累计；只要有一条请求没有 usage，就写 `at least`，不把已知下限说成精确值。取舍见 [ADR-0016](./docs/adr/0016-tui-v0.3-top-down-layout.md)。逐张参考图对照后的实际效果见 [Windows Terminal 验收截图](./docs/design/verification/tui-v0.3-windows-terminal/README.md)。

已知边界：完整固定布局要求终端至少 12 行、30 列（备用屏幕尺寸不足时只显示提示）；宽度按近似显示宽度换行（CJK / emoji 按 2 列，组合字符按 0 列），不做完整 Unicode East Asian Width / grapheme 表，ZWJ / 旗帜等组合 emoji 的实际终端列宽可能偏差；正文硬换行；差分重绘在慢终端上仍可能闪烁；Run log 保留最近 2000 条逻辑行，待审批的完整命令独立保留至回答；没有鼠标和多行输入。自动测试覆盖组合字符、一次性 IME 上屏、长会话裁剪与关闭清理，但不等于覆盖所有真实输入法/终端。`Ctrl+O` 以键盘浏览活动组；命令补全支持已有的真实 Slash 命令。真实终端截图、验证范围与显示局限见 [验收记录](./docs/design/verification/tui-v0.3/README.md)。

## 配置

| 变量 / 参数 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `API_KEY` | — | 必填，或改用 `OPENAI_API_KEY`；示例占位值 `sk-your-key-here` 会在请求前拒绝 |
| `MODEL` | `gpt-4o-mini` | 模型名；不填写沿用默认值，不代表已验证服务连通 | 
| `AGENT_DEMO` | 未启用 | 设为 `1` 时，仅在 TUI/CLI 标记“外部 Mock 演示”；不会启动模拟服务或跳过 API Key 校验 |
| `WORKDIR` | 当前目录 | 文件工具的根目录（不是安全边界） |
| `MAX_STEPS` | `30` | 单次 Run 最多请求模型多少次 |
| `MAX_TOOL_CALLS` | `60` | 单次 Run 最多处理多少次工具调用（拒绝 / 校验失败也计数；预算跳过不计） |
| `MAX_TOTAL_TOKENS` | `500000` | 单次 Run 的累计 token 预算（软上限：到线后不再发请求，已发生的费用照记）；`0` 表示不限制 |
| `MAX_OUTPUT_TOKENS` | `8192` | 单次模型响应最多生成多少 token |
| `TOOL_TIMEOUT_MS` | `120000` | 单条命令超时 |
| `--permission` | `workspace-write` | CLI 参数（不是环境变量）：`read-only` / `workspace-write` / `full-access` |

### 模型连接与错误提示

- **模型状态**：真实交互式 TUI 在缺少 API Key 或只有示例占位值时仍可打开，右上角明确显示「未配置模型」；提交任务仅提示配置，不产生假的 Thinking、Agent Run 或请求。非交互模式继续在发送请求前明确报错。模型名和 API Key 的存在不代表服务连通。
- **四类 UI 状态**：「未配置模型」「正在重新连接 N/5」「模型认证失败」「模型服务不可用」。401/403 归认证，404/不完整 SSE/永久连接失败归服务不可用；真实 HTTP 错误依旧显示状态码，原始错误继续保留在异常/命令行诊断。
- **TUI 重连**：仅对真实网络错误和 HTTP 408/429/5xx 启用最多 5 次额外请求，所有这些错误共用一个重连状态；401/403/404、SSE 不完整、无效响应绝不盲目重放。退避可由取消信号中断，所有真实请求与未知费用逐次记账。重试状态会取代 Thinking，恢复/失败时清除，不向会话历史堆叠重复提示。流式草稿失败后仍无效，不能充当最终回复。
- **外部演示**：需要自行启动符合 OpenAI 兼容协议的 Mock HTTP 服务，设置 `BASE_URL`、`API_KEY`、`MODEL`；若要在标题中明确标识，可加 `AGENT_DEMO=1`。标记仅影响展示，**没有内置 Mock 端点，也不验证 Mock 是否已经运行**。模型名 `mock-demo` 本身并不代表已连接成功。

## 验证

```bash
npm install
npm run check       # typecheck + 全部测试
```

252 个用例，分十二层，都不需要 API Key、不联网（其中 7 条在 Windows 上跳过：2 条平台用例 + 5 条 Linux PTY 用例）：

| 文件 | 打在哪个缝上 |
| --- | --- |
| `test/agent.test.mjs` | `Agent.run`：消息顺序、id 配对、两个预算、最后一步、会话生命周期、取消、token 统计、系统提示词动态刷新 |
| `test/tool-registry.test.mjs` | `ToolRegistry`：Schema 注册校验、未知工具、坏 JSON、工具抛错 |
| `test/permission.test.mjs` | Permission：三档策略、`permissionPrompt`、shell 审批的每次询问与默认拒绝、ToolRegistry 的检查位置、显式 permission / null 的构造校验 |
| `test/approval.test.mjs` | 审批读取：`askWithSignal` 的正常 / 取消 / EOF 竞态，以及多行 / 超长 / 控制字符命令和 cwd 的展示 |
| `test/workspace.test.mjs` | 路径越界、完整读取、截断、扫描预算、符号链接、`edit` 唯一命中、`glob` 模式、`grep` 正则与 `fixed` 模式、灾难性回溯超时、取消进程树和 Windows taskkill 错误/非零退出/卡住故障注入 |
| `test/llm.test.mjs` | `Llm.chat`：合法响应归一化、非法形状必须报错、`finish_reason` 与 `tool_calls` 一致性、usage 保留、`max_tokens`、取消、SSE 流式拼装与坏 chunk |
| `test/cli.test.mjs` | 端到端：环境变量、退出码、stdout、请求体形状、API Key 回退、SIGINT、失败路径的 usage、REPL 多轮与 `/reset`、`/permission` 动态提示、`--permission`、流式 mock、TUI 聊天布局 / 命令 / 统计 |
| `test/cli-pty.test.mjs` | Linux PTY：审批允许 / 拒绝 / Ctrl-C / EOF，以及 REPL 审批 EOF 不冒充用户拒绝 |
| `test/tui.test.mjs` | TUI：审批安全、聊天布局、思考动画、终端降级、生命周期与工具活动；组合 Unicode / IME 一次上屏、长会话滚动及关闭后资源清理 |
| `test/selfcheck.test.mjs` | 评测自检：断言失败 / 任务无效 / 基础设施错误三类必须分开 |
| `test/eval.test.mjs` | 评测轮次：检查器里未 await 的 promise 必须让整轮判失败 |
| `test/eval-diagnostics.test.mjs` | 评测诊断：逐请求 usage、工具结果大小、文件变化、参数脱敏、跨天 runner 入口 |

## 评测

单元测试证明「代码没坏」，评测证明「agent 还能干活」。`eval/` 下放了 20 个真实小任务——修 bug、改名、加路由、抽重复、补文档、删死代码、加校验、回调改 Promise、修正则——用真实模型跑一遍，记录成功率、请求数、工具调用数、token 用量和耗时：

```bash
npm run eval            # 需要 .env，会真的调用模型、真的花钱
npm run eval -- rename  # 只跑名字里带 rename 的
npm run eval:check      # 自检：不调用模型，验证每个任务的初始状态确实会断言失败
npm run eval -- --trace --keep 13-callback-to-promise  # 可选诊断：保留单个任务并记录请求/工具轨迹
npm run eval:cross-day   # 在不同自然日各运行 3 轮，固定使用 eac798d（prompt v2）基线
```

基线（2026-11-05，`hy3`，prompt v2，连续 6 轮，4 并发）：

| 通过 | 模型请求（中位数） | 工具调用（中位数） | tokens（中位数，prompt + completion） | 墙钟（中位数） |
| --- | --- | --- | --- | --- |
| **120/120（6/6 轮 20/20）** | 89.5 | 85.5 | 118,817（111,458.5 + 7,277.5） | 70.8s |

6 轮全部满分。相比上一版提示词（119/120、101.5 请求、139,040 tokens）：请求 -11.8%、tokens -14.5%、墙钟 -10.4%，轮间 token 从 118k–168k（1.42×）收窄到 103k–126k（1.22×）。收益来自系统提示词里新增的一行——要求模型一次只跑一条简单 shell 命令，减少 `|`、`rm` 之类的语法失败重试（见 [提示词 v2 报告](./docs/reports/2026-11-05-prompt-v2.md)）。逐任务波动见 [eval/baseline.md](./eval/baseline.md)：`13-callback-to-promise` 3.76×、`20-fix-email-regex` 2.51×、`08-extract-duplication` 1.40×，剩余波动仍来自模型自己的路径选择，成本要按中位数加余量估。第一阶段验收基线是 DeepSeek-V4.1-Flash：20/20、178 请求、200 工具调用、389,074 tokens、66.5s。

跨天验证与诊断模式的约束、归档路径和使用方法见 [docs/eval-diagnostics.md](./docs/eval-diagnostics.md)。跨天基线现在钉在 `eac798d`（prompt v2），v2 序列从 2026-11-06 起跑，跑满三个自然日再写结论；v1（`4edd0e4`）的 11-05 数据只作历史，归档在 `eval/baselines/cross-day-v1-4edd0e4/`。

关于耗时与成本：`hy3` 单任务中位数约 12.4 秒、4.5 次模型请求，其中**请求与请求之间的等待几乎全是模型往返**，工具执行加内核开销占比很小。省时间主要靠任务之间并发（默认 `--jobs 4`，20 个任务墙钟约 71 秒）；省钱主要靠选模型（输入 token 占 93.8%，成本来自反复重发完整对话历史）、少让模型走冤枉路，以及收紧 `MAX_TOTAL_TOKENS` / `MAX_OUTPUT_TOKENS`。上下文压缩这一阶段刻意不做，先用多轮评测判断它是不是真的瓶颈。

`eval:check` 现在把三类结果分开：`ok`（预期断言失败）、`BROKEN`（初始状态就通过，任务什么都没测）、`INFRA`（检查器加载失败或抛非断言错误）。**只有 `ok` 才算自检通过** —— 评测最容易错的地方是评测本身。真实评测也多了一道轮级检查：检查器里没 await 的 promise 如果在结算窗口内变成未处理 rejection，整轮判为基础设施失败，即使任务表全绿。

```bash
npm run eval:summary    # 汇总最近几轮：通过率、请求数、token、墙钟的中位数
```

结果同时写进 `eval/results/`（不进 git）。真实评测**不自动进 CI**：它要真实 Key、会花钱、而且本身非确定性——CI 只跑确定性的 `npm run check` 和不需要 Key 的 `npm run eval:check`。任务怎么写、失败怎么分类，见 [eval/README.md](./eval/README.md)。

## 刻意没做的事

保持「内核」的边界，下面这些留给上层或后续迭代：

- 会话持久化到磁盘：进程内的多轮 REPL / TUI 已经有了（`--repl`、`--tui`），跨进程恢复 transcript 没有做
- 按轮取消：Ctrl-C 停的是整个会话；只停当前这一轮需要每轮换一个 signal，留给后续
- 鼠标、多行输入和 Hooks 尚未做；TUI 已支持对可识别终端的 alternate screen 与窗口缩放重绘，仍保留顶部对话、输入区、滚动审批面板、Ctrl+O 活动明细及 `/` Slash 自动补全（早期布局决策见 [ADR-0016](./docs/adr/0016-tui-v0.3-top-down-layout.md)）。
- 工具并发（串行是有意的，见 [ADR-0003](./docs/adr/0003-run-tool-calls-serially.md)）
- 操作系统级隔离：Permission v0.1 只做工具调用策略（见 [ADR-0013](./docs/adr/0013-permission-is-a-policy-not-a-sandbox.md)），不是 Sandbox；`shell` 放行后仍是启动者的权限（见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)）
- 上下文压缩、非 TUI 模式的自动重试、tokenizer 级精确成本估算（只统计端点返回的 usage）

## 文档与技能

- [CODING_STANDARDS.md](./CODING_STANDARDS.md)：规范本体（语言分层、教学式注释、模块形状、命名、错误处理、防御性编程、测试）。
- [AGENTS.md](./AGENTS.md)：agent 的入口 —— 命令、代码地图、测试放哪。
- [GLOSSARY.md](./GLOSSARY.md)：领域词汇（Kernel、Step、Transcript、ERROR text……）。
- [docs/adr/](./docs/adr/)：已经定下、别再重新讨论的决定。
- [docs/reports/](./docs/reports/)：阶段修复报告（问题、方案、测试、CI 与评测基线）。
- `.agents/skills/`：装好的 agent 技能（来自 [mattpocock/skills](https://github.com/mattpocock/skills)，MIT）。

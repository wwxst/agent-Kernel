# agent-Kernel

最小 Coding Agent：**一个类、一个循环、十个工具、完全访问**，运行时零依赖。

> 当前状态：v0.5，个人练习项目。

## 快速开始

需要 Node.js **>= 22.18**（从 22.18 起可以直接 `node xxx.ts`，靠内置的 type stripping，不需要构建）。

```powershell
Copy-Item .env.example .env    # 填入 API_KEY；用什么模型由你决定
npm run agent -- "给这个仓库加一个 /health 接口并写测试"
npm run agent --                 # 不带任务：直接进全屏 TUI（唯一的交互界面）
npm run agent -- --tui         # 同上，显式指定；顶部信息、对话、固定输入
npm run agent -- --tui "先看看这个仓库的结构"   # TUI 先跑这个任务，之后继续等输入
npm run agent -- --cwd "C:\path\to\other-project" "先看看这个项目的结构"   # 默认目录指向别的项目，项目不用搬过去
```

### 在任意目录里跑（像 Claude Code 那样打开一个目录）

`npm run` 只认当前目录的 `package.json`，所以想「进到某个项目里直接开」就先装一次全局命令：

```powershell
npm link                                  # 在本仓库执行一次，注册 agent / agent-kernel 命令
cd D:\some\project                        # 之后去任何目录
agent --tui                               # 默认目录 = 当前目录，.env 仍从本仓库读
agent "看看这个项目怎么跑"
```

两个命令名指向同一个入口（`bin/agent.mjs`）：`agent` 是短名，`agent-kernel` 保留以免和别的工具重名。它们会先用包内绝对路径加载 `.env`，再进 `src/cli.ts`；`--cwd` 依然可用，优先级高于当前目录。

### TUI 主视图与 transcript 视图

`--tui`（不带任务时默认）**在主屏就地渲染**：已定稿的对话用普通输出打印一次，留在 Shell 滚动历史里，所以打开 TUI 之前敲过的命令仍然看得见；只有底部活动区（当前轮内容 + 输入框 + 状态行）会重画。这和 Claude Code 的 `<Static>`、Codex 的 inline viewport 是同一个模型。

按 **`Ctrl+T` 进入 transcript 视图**：临时占用整屏（备用屏幕）回看和展开历史，`Ctrl+T` 或 `Esc` 退出，主屏原样还回来。主视图里的历史不可原地修改，这是终端 scrollback 的物理约束，不是实现缺陷；详见 [ADR-0017](./docs/adr/0017-tui-renders-on-main-screen.md)。

不捕获鼠标：滚轮、滚动条、选中复制、终端搜索全部保持原生行为；展开历史走 `Ctrl+T` + 键盘。若终端明确声明 `TERM=dumb`，交互式 TUI 会报错，请改用支持 ANSI 控制序列的终端。

`AGENT_TUI_COLOR=mono`（默认）只保留用户任务条颜色；`full` 恢复状态与提示的层次配色。配色方案另由 `AGENT_TUI_THEME=dark|light|ansi` 决定：`dark`（默认）按深色背景配色，`light` 换成浅底深字（浅色终端上 `info` 的近白灰等于没写字），`ansi` 强制只用终端自己的 16 色。两者正交——先选用哪套色，再选上不上色。**非 TTY（管道、CI、e2e）仍输出普通文本**，供脚本处理，不是另一种可选择的交互 UI。输入区支持多行：`Shift+Enter` 或 `Ctrl+J` 换行、`Enter` 提交（粘贴多行同样折叠成一条消息）。本次 TUI 会话最多保留 32 MiB 或 256 段多行粘贴原文；达到任一上限时，新粘贴会被拒绝并提示，关闭并重新打开 TUI 后重置。尚未结束的单段粘贴也限制为 32 MiB，超限整体拒绝，收到结束标记后仍可输入。运行中按 `PgUp` 暂停活动区刷新（可以自由往上翻历史），`PgDn` 或 `Esc` 恢复。工作区根目录的 `AGENTS.md` 会在每次模型请求前重读并注入系统提示；正文超过 32000 字符或实际读取超过 8 MiB 时明确截断，没有该文件就不注入。字形默认自动探测（Windows Terminal / VS Code / WezTerm 用 `❯ ↳ ✓ └ ▸`，老 conhost 退回 ASCII 的 `> + - >`）；探测不准时用 `AGENT_TUI_GLYPHS=unicode|ascii` 强制指定。所有输出都只属于展示层，不修改 Agent Transcript、工具执行或模型请求。

### 快捷键

| 键 | 作用 |
| --- | --- |
| `Enter` | 发送当前输入 |
| `Shift+Enter` | 换行（现代终端 `ESC[13;2u`；老终端 `ESC\r`） |
| `Ctrl+J` | 换行（所有终端可用，兜底） |
| `@` | 补全工作区文件路径（回车插入，不提交） |
| `Ctrl+X` `Ctrl+E` | 用 `$VISUAL` / `$EDITOR` 编辑当前输入（未设置时 Windows 用 notepad，其他用 vi） |
| `↑` / `↓` | 翻历史（跨进程保存，存在 `~/.agent-kernel/history.jsonl`） |
| `Ctrl+C` | 取消本轮 |
| `Ctrl+E` | 打开历史视图（transcript） |
| `PgUp` | 暂停活动区刷新，可自由往上翻历史 |
| `PgDn` / `Esc` | 恢复刷新 |

`/help` 里同样能看到这张表。

`npm install` 只在跑类型检查和测试时需要；`npm run agent` 本身不需要任何依赖。

CLI 默认流式输出：模型生成正文时逐段打印，长回复不再是黑屏等一段。评测走非流式，保证跨轮对比的是同样的完整响应（见 [ADR-0012](./docs/adr/0012-streaming-is-display-only.md)）。

### 执行阶段与角色台词

CLI 将真实的执行事件展示为 **Preparing → Thinking → Tool → Answering → Completed / Failed / Cancelled**。每次模型请求有独立思考阶段，工具调用开始、返回结果会依次出现；结束时展示真实耗时和已处理的工具调用数（含参数校验失败；未执行的预算跳过不计），原有 `[usage]` 账单仍保留。工具出错时标记 ✗，不会因为台词活泼就宣称任务成功。台词只是展示层文案，不进入模型提示词或 Transcript。

- 默认 **compact**：每条工具一行摘要，按模型 Step 连续排列，方便快速扫过。
- `npm run agent -- --details "任务"`：**detailed** 模式，每条工具结果单独展开多行；超过 4000 字符会标明省略字符数。也可在 `.env` 设 `AGENT_VIEW=detailed`。
- CLI 与 TUI 都会将 Shell 非零退出、超时、取消标为工具失败；模型若随后修复并给出有效答复，整轮 Run 仍可成功。Agent 的展示回调为尽力通知，异常不影响执行或 Transcript 配对；累计次数可通过 `observerFailureCount` 诊断。
- `AGENT_VOICE=balanced`（默认）轮换元气、调皮、傲娇、好奇、温柔、可靠六类短句；也可以设 `energetic` / `playful` / `tsundere` / `curious` / `gentle` / `confident` 固定语气。台词随阶段变化，不是定时随机冒泡。

终端本身没有可点击折叠组件，因此这里用 **compact/detailed 两种视图** 替代网页里的逐条点击展开；详细模式的日志同样有长度上限。

## 代码结构

`src/` 按职责分五层，看目录名就知道那堆文件管什么：`protocol/` 是类型与错误（最底层）、`core/` 是循环与调度、`tools/` 是给模型的工具、`model/` 是跟模型打交道（请求与系统提示）、`ui/` 是终端展示。`cli.ts` 留在根目录，是唯一的组装入口。依赖只有一个方向。

| 文件 | 一句话 |
| --- | --- |
| `src/protocol/types.ts` | 协议词汇：`Message`、`Tool`、`ToolDefinition`、`ChatClient`。不依赖任何人 |
| `src/protocol/errors.ts` | 错误文案兜底：`describeError()` 把任何抛出物变成一行非空文本 |
| `src/core/agent.ts` | 内核：循环、消息顺序、请求/工具预算、生命周期；system 提示支持函数式动态刷新 |
| `src/core/tool-registry.ts` | 工具注册表：Schema 校验、按名字找工具、解析参数、执行工具、把失败折成 `ERROR` 文本；围着执行触发三个 Hook 事件 |
| `src/core/tool-hooks.ts` | 工具执行的三个扩展事件：`PreToolUse`（可阻止）/ `PostToolUse` / `PostToolUseFailure`；按登记顺序串行执行，Hook 自己出错只计数、不影响工具结果 |
| `src/core/tool-log.ts` | 第一个真实 Hook 用户：每次工具调用追加一行 JSON 到 `AGENT_TOOL_LOG` 指定的文件；写不进去只提醒一次 |
| `src/core/tool-result-status.ts` | CLI/TUI 共享的工具失败判断：Shell 的非零退出、超时、取消；不修改回灌模型的文本 |
| `src/tools/todo.ts` | TodoWrite：任务清单的校验、原子更新和进度渲染；每个 Agent 会话一份、不会跨进程保存 |
| `src/tools/workspace.ts` | 文件与 Shell：读、写、改、找文件、搜内容、列目录、跑命令；相对路径以默认目录为基准，绝对路径和 `../` 直接可用，另有有界读取、扫描预算与取消 |
| `src/model/llm.ts` | `ChatClient` 的 HTTP 实现，POST 一个 OpenAI 兼容端点并保留 `usage` |
| `src/model/project-instructions.ts` | 读 `AGENTS.md` 注入系统提示：只做读取与有界截断，不发明格式 |
| `src/ui/tui.ts` | TUI：聊天布局、任务前/中/结束状态、真实 AI 阶段说明与工具活动分组、工具失败同行展示、Ctrl+O 活动详情；主视图在主屏就地追加、`Ctrl+T` 进 transcript 整屏视图，不触碰 Agent Loop |
| `src/ui/tui-mood.ts` | 状态驱动的中英文角色短句库：元气、调皮、好奇、温柔为主，少量傲娇/天然；临时展示、不写 Transcript |
| `src/ui/cli-presenter.ts` | CLI 展示：执行阶段、动态台词、工具日志精简/详细视图；不写入 Transcript |
| `src/ui/prompt-history.ts` | 跨进程输入历史：一行一条 JSONL，坏行跳过，读不出来就当没有历史 |
| `src/ui/file-index.ts` | 工作区文件清单，给 `@` 补全用：只列路径 + 前缀过滤，不替用户搜内容 |
| `src/ui/text.ts` | 终端展示转义：控制字符与 bidi 字符变成可见转义；不依赖任何模块 |
| `src/cli.ts` | 组装层：命令行参数 / 环境变量 → 对象图 → 跑一次任务或进 TUI |

`src/tools/grep-worker.ts` 不算在模块表里，它是 `Workspace.grep` 的匹配线程：正则跑在里面，主线程超时就 `terminate`（见 [ADR-0010](./docs/adr/0010-grep-regex-in-worker.md)）。

`core/agent.ts` 不认识 `tools/workspace.ts`：循环只管「问模型、执行调用、塞回结果」，工具怎么实现的它不关心。
它也不认识 `ui/tui.ts`：TUI 只是把 Agent 的回调接到显示层，循环本身不知道有没有界面。这就是为什么换模型、换工具集、换交互壳，循环一行都不用改。展示观察者精简为四个：`onRequestStart(step)`（每个 Run 从 1 计）、`onToolCall(call)`、`onToolResult(call, result)`、`onDelta(text)`；原先重复的 `onStepStart` / `onToolStart` 已移除，外部调用方需要迁移。

命令、代码地图、测试放哪见 [AGENTS.md](./AGENTS.md)；怎么写代码（注释风格、模块形状、命名、错误处理）见 [CODING_STANDARDS.md](./CODING_STANDARDS.md)。

### 工具执行 Hook（v1）

三个事件围着一次工具执行：`PreToolUse`（执行前）、`PostToolUse`（成功之后）、`PostToolUseFailure`（失败之后）。它们挂在**唯一的执行入口** `ToolRegistry.execute` 上，所以所有注册工具自动全部经过，不用逐个接线；`Agent` 主循环一行没改。

```ts
import { ToolHooks } from "./src/core/tool-hooks.ts";

const hooks = new ToolHooks({
  // 同步、异步都收；返回 { block: "原因" } 就阻止这次调用，原因会进 ERROR 文本被模型读到。
  preToolUse: [(context) => {
    const command = typeof context.args.command === "string" ? context.args.command : "";
    return command.includes("rm -rf") ? { block: "destructive command" } : undefined;
  }],
  // 成功之后能拿到结果原文；失败之后能拿到原始错误对象。
  postToolUse: [(context) => console.log(context.call.function.name, context.result.length)],
  postToolUseFailure: [(context) => console.error(context.call.function.name, context.error)],
});

const tools = new ToolRegistry(createWorkspaceTools(workspace), hooks);
```

规矩只有三条：同一事件按登记顺序串行执行；`PreToolUse` 第一个要拦的就结束整条链；Hook 自己抛错只记 `hooks.failureCount`，既不打断工具，也不改工具结果。第一版不读配置文件、不加载外部脚本，Hook 就是进程内的函数（见 [ADR-0020](./docs/adr/0020-tool-hooks-live-in-the-registry.md)）。

仓库里自带一个真实的 Hook 用户：**工具调用日志**。设 `AGENT_TOOL_LOG=<文件路径>` 才会启用，不设就完全没变化（空执行器，行为与之前一致）。每执行完一次工具调用追加一行 JSON，启动横幅会多一行 `tool log:` 显示路径：

```json
{"ts":1794532936268,"tool":"read","id":"chatcmpl-tool-9267…","ok":false,"args":"{\"path\":\"missing.txt\"}","detail":"ENOENT: no such file or directory…"}
```

成功和失败都记，字段一样（`ts` / `tool` / `id` / `ok` / `args` / `detail`）。`ok` 的口径和 CLI / TUI 标 ✗ 一致：`shell` 非零退出、超时、被取消都算失败，不是只看有没有抛异常。`args` 与 `detail` 各自最多 2000 字符，超出会写明截掉多少。写不进去时只在 stderr 提醒一次，工具照常执行。

> **日志里会有敏感内容，请自己保管好。** `args` 和 `detail` 存的是原文：`write` 写进去的文件正文、`shell` 的命令行（可能带 token 或密码）、`read` 读到的文件内容都会记下来，**不做脱敏**。别把它放在会被提交进仓库、同步到网盘或分享出去的位置，用完按需删除。它的信任级别和 Transcript 一样。

**已知缺口**：被前置 Hook 拦下的调用不会留记录 —— 它没有执行，也就没有结果；要审计「谁想跑但被拦了」，得让前置 Hook 自己写。

## 核心循环

`src/core/agent.ts` 里的 `Agent.run()`，对应设计稿里的伪代码。它就是 **agent loop** —— 教科书里那个 `while (true)` 的原型，外加三道闸门：模型请求次数、工具执行次数、取消信号。

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

## 十个工具

复杂任务可调用 `todo_write`，一次提交完整清单并更新 `pending` / `in_progress` / `done` 状态；最多 20 项，同一时刻最多一个 `in_progress`。计划只在当前 Agent 会话内有效，`/reset` 或重启后清空。它是进度记录，不会自行执行任务或判断目标达成；简单单步任务不要求使用。

工具名是模型看到的接口，所以用的是 agent 生态里的通用叫法（`read` / `write` / `edit` / `glob` / `grep` / `ls` / `shell`），不是本仓库方法名的直译：

| 工具 | 说明 | 对应工作区方法 |
| --- | --- | --- |
| `read` | 读 UTF-8 文本，超过 8k 字符截断 | `Workspace.read` |
| `write` | 创建/覆盖整个文件，自动建父目录 | `Workspace.write` |
| `edit` | 把唯一命中的一段换成另一段 | `Workspace.edit` |
| `glob` | 按模式找文件，如 `src/**/*.ts` | `Workspace.glob` |
| `grep` | 按正则搜文件内容，回 `路径:行号: 内容`；匹配跑在 worker 里，超时中断 | `Workspace.grep` |
| `ls` | 列目录：类型、字节数、名称 | `Workspace.list` |
| `shell` | 默认在默认目录跑 shell，命令内可 `cd` 到任意位置；超时/取消杀整棵进程树，输出有上限 | `Workspace.run` |
| `shell-output` | 读后台任务自上次调用之后的新输出；第一行是它的状态 | `Workspace.readJobOutput` |
| `shell-kill` | 停掉后台任务连同它的后代进程 | `Workspace.killJob` |
| `todo_write` | 更新完整的任务计划，状态为 pending / in_progress / done | `TodoManager.update` |

前三个是「改文件」，中间两个是「找东西」，`ls` 看一层目录，`shell` 是兜底。模型先找后改，顺序和它自己的直觉一致。

`shell-output` 与 `shell-kill` 不是新能力，是 `shell` 那半个功能的收尾。`shell` 带 `background:true` 时立刻返回一个任务编号（`job-1`），进程继续跑：

```text
shell { command: "npm run dev", background: true }
→ started job-1 (pid 12345) in the background; read new output with shell-output, stop it with shell-kill

shell-output { job_id: "job-1", wait: 3000 }
→ job-1 (running, pid 12345) ran: npm run dev
  VITE v5.4.0  ready in 312 ms
  ➜  Local:   http://localhost:5173/

shell-kill { job_id: "job-1" }
→ stopped job-1
```

三条边界值得知道：**只返回新增的部分**（第二次调 `shell-output` 不会把同一段日志再读一遍，否则既烧 token 又让模型以为「这条错误又出现了」）；**单次最多 8k 字符**，超出的留在日志里并明说「还有，再调一次」；**日志落在系统临时目录**（`%TEMP%\agent-kernel-jobs` 或 `$TMPDIR`），不落工作区，所以模型不能拿 `read` 直接看，必须走 `shell-output`。等待输出时响应取消，日志不可读会明确报错。

`shell-kill` 停不干净时**报错而不是假装成功**：`taskkill /T` 只杀外层、POSIX 上回退只杀直接子进程，这两种情况后代可能还活着。冒充成功会让模型以为端口已经释放，然后在一个还占着端口的世界里继续排查。

`write` 和 `edit` 的分工就是名字说的那件事：改几行用 `edit`（省 token，也不会因为「只改三行却重写整个文件」把长文件改坏），新建文件或整体重写才用 `write`。

`edit` 要求 `old_string` 恰好命中一次：0 次或多次都回 `ERROR`，模型读一遍文件再收窄片段。行号定位会随后面的改动漂移，原文片段不会。这个取舍记在 [ADR-0006](./docs/adr/0006-edit-by-unique-snippet.md)。

`glob` 是自己遍历目录再拿模式去套，而不是把模式交给 `fs.glob` 展开：自己走目录才能让扫描预算、跳过规则和结果上限都真实生效。搜索根默认是默认目录，也可以用 `path` 指向任意目录（含默认目录之外），模式本身也可以写绝对路径。代价是只支持 `*`、`**`、`?` 三种通配，`{}`、`[]` 按字面匹配。

叫 `shell` 而不是 `bash`：实现是 `spawn(command, { shell: true })`，真正由哪个 shell 解释取决于平台，叫 `bash` 就是承诺了没做到的事。这个取舍记在 [ADR-0005](./docs/adr/0005-name-tools-after-the-ecosystem.md)。

路径解析统一成一条规则：相对路径以默认目录为基准，绝对路径直接使用，`../` 可以走出默认目录；符号链接、junction 解析到实际目标，读写落在目标位置。这里**没有目录边界**——能访问什么由启动 Agent 的操作系统账户决定（见 [ADR-0019](./docs/adr/0019-full-access-is-the-only-mode.md)）。文件读写使用解析后的真实路径，编辑通过同一个句柄读写；写入/编辑在提交修改前复查取消信号，POSIX 文件打开也避免跟随末端符号链接。**已知边界：这不能完全消除恶意并发替换父目录的 TOCTOU 竞态，Windows 不支持同样的末端链接打开标志；仍应按 Trusted Local Agent 使用。**

已知边界：`glob` 只认 `*`、`**`、`?` 三种通配，`{}`、`[]` 按字面匹配（这是刻意的，见下）；`glob` / `grep` 默认跳过 `.git` 和 `node_modules`、最多回 200 条命中，单次最多访问 20 000 个目录项，符号链接不跟随；`read` 最多读 32 KB，`grep` 按字节读到 1 MB 为止、超出的文件跳过，`edit` 不接受超过 2 MB 的文件（读不全就拒绝，绝不拿半截内容覆盖），`ls` 最多展示 500 条、扫到 20 000 项就停。`grep` 的正则匹配另有 2 秒预算（只算匹配时间，不算读文件），超时会杀掉匹配线程并标注结果不完整。目录用 `opendir` 边读边收，预算限制的是真正读了多少项，而不是 `readdir` 之后切了多少项；所有截断、跳过、没搜完的统计都保留在结果末尾，不会被结果自己的长度上限吃掉。扫描提前停手时会明说 `results may be incomplete`，不会声称拿到了全局排序结果。

`grep(path)` 使用经过真实路径校验的物理起点，不再沿可变的路径别名展开目录；深层目录在枚举与打开之间仍存在已知 TOCTOU，完全隔离需要 OS 级目录句柄约束。

`glob` / `grep` 达到 200 条命中上限时，返回的是**遍历顺序里先遇到的那 200 条**；排序只保证这 200 条内部有序，不保证是全局字典序的前 200 条。要拿稳定 Top N 就得扫完整棵树，那会牺牲扫描预算，所以第一阶段先保留现状并明确标注不完整。已记录为后续优化项。

`grep` 支持**正则**（JavaScript 语法，逐行匹配），但匹配不跑在主线程：每条正则在 `grep-worker.ts` 的线程里执行，主线程只守 2 秒的匹配预算，超时就 `terminate`，把整个线程连同指数级回溯一起扔掉。这样「输入不能让 agent 卡死」仍然成立，而模型拿回了 `a.*b` 这类能力——第一阶段的字面搜索是当时没有 worker 的权宜之计。代价是每次 grep 多一个线程的启动开销，以及结果可能因预算而部分缺失（尾注会明确写 `regex stopped after 2000ms`）。要搜 `a.b`、`([` 这种字面文本，传 `fixed: true` 就能关掉正则解释。取舍记在 [ADR-0010](./docs/adr/0010-grep-regex-in-worker.md)。

写入与编辑现在先写同目录临时文件，完整写入并同步后再以 rename 提交；取消或写入失败会保留原文件并清理临时文件。既有文件尽量保留 POSIX mode，提交前复查目标身份与真实路径。已知边界：替换改变 inode / hardlink 关系，Windows 的 ACL、文件占用及 rename 语义不保证与原地覆盖完全一致；父目录并发替换仍存在 TOCTOU，原子提交不等于隔离沙箱。

Windows `taskkill /T` 最多等待 2 秒：只有它以 0 退出才确认成功。启动失败、非零退出或卡住时，尝试 `child.kill()` 停掉直接子进程，**并以错误报告「进程树清理未确认，可能仍有后代运行」**，而不是冒充清理完成。停止后的子进程管道最多等待 4 秒；如果 stdout/stderr 被残留后代持续占用，也要终止等待、明确报错。注意：Node 自带的 `child.kill()` 不能保证 Windows 孙进程退出；自动故障注入与真实 Windows 进程树超时/取消测试也不能证明所有异常环境均可回收。

**文件工具与 `shell` 的能力是一致的**：两者都以启动 Agent 的操作系统账户执行，都能读写任意有权访问的位置、都能出网。真正的限制来自操作系统账户与系统安全策略，不来自 agent-Kernel；需要更强隔离时用容器、独立用户或只读挂载，而不是指望工具层的字符串判断（见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)）。

## 完全访问（Full Access）

agent-Kernel 只有一种运行模式：**完全访问**。没有模式切换，没有审批提示，也没有工作区目录边界。

| 能力 | 现状 |
| --- | --- |
| 文件工具（`read` / `write` / `edit` / `glob` / `grep` / `ls`） | 可以访问当前操作系统账户有权访问的任意文件与目录：绝对路径、`../`、其他磁盘都可用 |
| `shell` | 直接执行，不需要审批；默认 cwd 是默认目录，命令内可以 `cd` 到任意位置 |
| 网络 | 没有 agent-Kernel 自己施加的域名白名单或网络开关；能不能出网由操作系统、代理与防火墙决定 |
| 启动参数 | `--permission` 与 `AGENT_PERMISSION` 已移除；显式传入会直接报错，避免留下「以为还在限制」的配置 |

这里说的「完全访问」是**取消 agent-Kernel 自己施加的限制**，不是提权：进程仍然以启动它的那个操作系统账户运行，没有 `sudo`、没有管理员权限提升、也没有绕过系统安全机制。真正的边界是操作系统账户与系统安全策略。

### 为什么删掉了三档权限

旧版本有三档模式（`read-only` / `workspace-write` / `full-access`）、Shell 逐次审批、项目级规则文件和审批菜单。实际使用里它们带来的是持续的打断，而**能挡住的东西本来就有限**：`shell` 一旦放行就和启动者同权，路径守卫只防模型手滑、不防恶意代码。保留一套「看起来在隔离、实际不是沙箱」的机制，比没有更危险——用户会以为它管着事。

所以这一版把选择收敛成一个：默认就按开发者的真实权限工作，把隔离需求交给容器、虚拟机、独立用户或只读挂载这些真正的边界。取舍记在 [ADR-0019](./docs/adr/0019-full-access-is-the-only-mode.md)。

### 工具执行流程

`ToolRegistry.execute()` 现在只有三步：**校验参数 → 执行工具 → 返回结果**。普通失败折成 `ERROR: ...` 文本回灌给模型，模型下一轮自己纠正；进程树清理未确认时仍抛 `ProcessCleanupError` 阻断后续工具，因为那意味着后台可能还在产生副作用。

`Permission 不是 Sandbox` 这条结论仍然成立，只是现在连「策略层」也不存在了：工具与 Shell 直接以当前账户执行。见 [ADR-0013](./docs/adr/0013-permission-is-a-policy-not-a-sandbox.md)（已标注为历史决策）。

## 轻量 TUI v0.3

`npm run agent -- --tui`（不带任务时默认就是这个）在同一个 Agent 会话外面套一个聊天式终端界面，它是唯一的交互模式：原来的逐行 REPL 和 `--repl` 开关已经移除。`--tui` 后面可以跟一个初始任务：先跑完，再等下一行输入。布局与验收规则见 [TUI v0.3 规范](./docs/design/tui-v0.3-layout-spec.md)（历史设计文档；其中权限模式与审批部分已删除）。

布局：

- **顶部**：项目名（左）和 model（右），下一行是 workspace 路径，再一条分隔线。
- **对话区**：内容从视口顶部向下排列；用户 `❯`、模型真实发言 `✻`。每轮任务的生命周期标题（准备执行 → 正在执行 + 已用时 → 已完成/执行失败/已取消 + 实际耗时）后面带折叠箭头。**执行中展开**真实模型阶段说明与按时间先后出现的工具活动，**结束后自动收为任务标题一行**；重新展开即可查看原来时间线。模型最终正式回复独立展示、不随任务折叠；没有单独重复的「已读取文件、修改代码、运行检查等」综合摘要。未输出阶段说明时不伪造模型发言。短会话输入框跟随内容，长会话靠底部。
- **用户消息样式**：整行做成 Claude Code 风格任务条——深灰底色（xterm 237）、灰色 `❯`/`>` 前缀、白色粗体正文；只支持 16 色的终端退化为亮黑底 + 亮白粗体。只改展示，不写 Transcript。
- **Markdown 代码块**：固定布局隐藏代码块围栏行（三个反引号那一行），块内正文缩进并用竖线标出；非 TTY 文本输出保留原文。只改展示，不改模型回复、Transcript 或工具结果。
- **输入框**：短会话紧跟当前消息，长会话自动停靠底部；用两条灰色横线划分输入区域，与正文共享左边缘。空会话显示占位符 `Ask anything, or type /help...`，开始对话后只保留提示符和光标。长输入横向滚动，提交原文不变。readline 保留编辑缓存，TUI 统一绘制，输入期间的新输出也能刷新。
- **状态行**：始终紧跟输入框**下方**，左边固定显示 `权限：完全访问`（英文界面 `access: full-access`），右边 requests / tool calls / tokens。只有一种权限，不提供切换。
- **中英文自动适配**：交互式 TUI 启动时按系统语言初始化（中文系统用中文，其余用英文；非 TTY 输出保持英文）；每次用户提交自然语言任务时，根据任务主要语言切换界面自带的工具标签、统计、状态和命令帮助。路径、代码片段、文件名不作为语言识别依据；混合输入按中文字符数与英文单词数判断；无语言内容时沿用上一轮语言。不翻译模型回复、Shell 命令或工具实际返回内容。**`Thinking...` 永远保持英文、动画和计时逻辑不变。** 不增加运行时依赖。

- 交互式 TUI 在主屏就地追加：已定稿的行打印一次进 Shell 滚动历史，只有底部活动区重绘；`Ctrl+T` 打开的 transcript 视图才用备用屏整屏重绘。不引 TUI 库。非 TTY（管道、CI、e2e）保留逐行文本输出，不作为可选 UI 模式。

工具与活动：

- **过程概述**：仅在 TUI 模式下用简短提示鼓励模型按重要阶段说明「当前做什么、已观察到什么、接下来准备什么」，优先展示实际生成的可见阶段说明，不展示隐藏推理，也不增加模型调用次数。模型没有说明时，在活动摘要之前显示**只由真实工具调用和返回驱动的事实性概述**（例如「正在查看文件 src/tui.ts。」→「已读取文件 src/tui.ts。」），同一活动只更新原概述、不反复刷历史；连续模型请求即使没有输出阶段文字也会按真实请求边界区分阶段。Shell 请求尚未返回结果时只说「正在处理命令请求」，任务取消且工具未回报时标明「执行状态未知」，绝不臆测发现、后续计划或成功结果。完成后与执行过程一起自动折叠。生成的兜底说明属于 UI 展示层，不写入 Transcript。非 TUI 模式的默认提示词不变。
- **工具活动**：读取/搜索/修改/执行命令等真实事件穿插在模型阶段说明之间，每段摘要最多显示 **3 种不同操作**，第 4 种起加「等」（英文 `etc.`）。任务完成后默认收起整轮过程，而不是把各段摘要单独留在屏幕上。工具事件本身可进一步展开实际工具输入的参数摘录（最多 12 行）和原始返回摘录（最多 20 行），超量会标明截断；成功的 `edit`、`write` 在 Workspace 原子提交后从实际文件前后快照计算带行号的 Unified Diff；`write` 的多处修改生成分离的 hunk，超出有界逐行比较预算则明确标记简化预览；`edit` 没有提交快照时仅展示实际请求的替换片段，`write` 文件超过 2,000,000 字节或旧内容无法读取时明确显示「Diff 预览已降级」，不会伪造补丁。终端 Unified Diff 按真实行号和末尾换行标记生成，最多预览 800 行、每行 240 字符；源文件超过预览预算时直接提示限制，不因超长行或超多行卡住 TUI。成功读取的 `read` 保留 8 KiB 输出/32 KiB 文件读取的截断警告；若实际读取 PNG，先校验各 Chunk CRC、IHDR/IDAT/IEND 的顺序与完整性，损坏或无效结构不生成预览；合法且受支持的 PNG 展示真实像素文字缩略图（含 RGBA、灰度/RGB tRNS 透明像素合成）；16 位等暂不支持的 PNG 以及 JPEG/GIF/WebP 会显示实际格式及兼容性说明，不冒充完成像素解码；未知格式不伪造预览。尾部箭头（`▸/▾`，旧终端用 `>/v`）表示收起/展开，箭头后面直接标出对应快捷键（`（Ctrl+E 展开）` / `（Ctrl+O 展开）` / `（Ctrl+G 展开）`，展开状态下提示「收起」），因为主视图不再捕获鼠标，不能只留一个孤零零的三角；在固定布局中输入 `/help` 可查看快捷键；主视图不捕获鼠标：滚轮、滚动条、选中复制都保持原生；展开历史请用 `Ctrl+T` 的 transcript 视图。不占用 Agent 的真实执行状态。
- **失败/未执行**：活动组展开时，失败摘要与具体命令**同行**（例如 `✗ npm run check 失败 · exit 1 · TypeScript 类型检查未通过`）；即使单个活动组已经折叠，失败行仍可查看，整轮任务折叠时需先展开任务。工具事件详情可以展开真实错误返回；错误原因不由界面猜测。失败绝不标成已执行；不把读取文件的原始正文整份刷进摘要。

外观与交互：

- 自动检测颜色能力：16 色 / 256 色、`NO_COLOR`、`TERM=dumb`；无颜色终端仍靠框线和符号可读。
- Windows Terminal / VS Code 终端 / Linux 使用 `❯`、`✻`、`●`、`✓`、`✗`、`⊘`、`┌┐└┘─│`；传统 Windows conhost 退化成 `>`、`*`、`o`、`+`、`x`、`!`、`-`、`|`，不会显示方框。
- **流式内容与失败**：TUI 固定布局在模型响应写入 Transcript 前显示暂态正文；若最新请求流式失败，则撤销未确认草稿并提示中断。若响应已经确认，但之后触发 Step、Token 或工具调用预算失败，则**保留真实模型正文，同时把整个 Run 标成失败**；已通过工具开始事件提交的阶段正文也不重复展示。逐行终端不能收回已经输出的字节，会明确标记其未确认。普通 CLI 同样对模型正文、工具结果、工具名里的控制字符与 bidi 字符做可见转义。
- **实时状态与角色语气**：`Thinking...` 保留英文、200ms 文本符号动画和真实计时；读取/搜索/编辑/写入/运行命令等状态只由真实 Agent 回调与工具名驱动。状态右侧 `│` 后显示一条轻快、略带傲娇的中英文短句，按状态和人格元素加权抽取，避开最近重复；持续约 15 秒才可能更换。短句不是模型思考内容，不增加 API 请求，也**不写入执行历史或最终回复**。窄屏时隐藏短句；失败只展示明确、可信的操作信息，不能用俏皮话掩盖错误。
- **历史滚动**：主视图的历史就是 Shell 的 scrollback，用终端自己的滚轮/滚动条翻；`Ctrl+T` 打开的 transcript 视图里用 PageUp / PageDown 翻本次会话的完整记录。
- **窗口 resize**：监听 stdout 的 resize 事件，重新计算标题、对话视口、输入框和状态行。小于 12 行或 30 列时使用逐行输出，放大后恢复固定布局并保留草稿与 Run log；`TERM=dumb` 始终逐行显示。
- **Slash 命令补全**：TUI 中输入 `/` 会在输入框**下方**展开当前程序实际支持的 `/help`、`/reset`、`/exit`、`/quit`；继续输入前缀实时筛选。方向键只移动高亮，不改变 readline 的输入历史；`Tab` 把高亮命令补全到编辑框但不执行，`Enter` 执行高亮命令，`Esc` 收起菜单且保留原输入；查询变更后可重新弹出。说明文案跟随中英文 UI 语言，不展示尚未实现的 Claude Code 命令。菜单不写入 Transcript，带参数的命令照常提交。小终端最多显示可容纳的条目，支持 resize。
- 会话命令：`/exit`、`/reset`、`/help`。`/reset` 换一个全新的 Agent，复用同一份配置与取消信号；没有权限命令，因为只有一种权限。

流式正文只是临时展示。已确认的 `assistant.content` 才是最终权威消息：固定布局可以替换有偏差的草稿；CLI / 非 TTY 文本输出无法撤回已写入终端的字节，会追加明确的 `[stream corrected: confirmed message follows]` 更正提示。同一条 assistant 的多次工具调用只确认一次阶段说明，避免重复模型发言。

资源边界：单次模型响应（JSON / SSE，按解压后的响应体计）最多读取 **8 MiB**，超限明确报错并关闭连接；HTTP 错误只读取前 500 字符详情，SSE 收到 `[DONE]` 就结束读取。输入历史只读取文件末尾最多 **8 MiB**，从中选取最近 500 条有效记录，切口处的残行跳过，磁盘上的旧记录保留。取舍见 [ADR-0022](./docs/adr/0022-bound-external-response-and-history-reads.md)。

统计按 Session 累计；只要有一条请求没有 usage，就写 `at least`，不把已知下限说成精确值。取舍见 [ADR-0016](./docs/adr/0016-tui-v0.3-top-down-layout.md)。逐张参考图对照后的实际效果见 [Windows Terminal 验收截图](./docs/design/verification/tui-v0.3-windows-terminal/README.md)。

已知边界：完整布局要求终端至少 12 行、30 列；宽度按近似显示宽度换行（CJK / emoji 按 2 列，组合字符按 0 列），不做完整 Unicode East Asian Width / grapheme 表，ZWJ / 旗帜等组合 emoji 的实际终端列宽可能偏差；正文硬换行；主视图不捕获鼠标，历史靠终端原生滚动；Run log 保留最近 2000 条逻辑行；暂不支持多行输入。自动测试覆盖组合字符、一次性 IME 上屏、长会话裁剪与关闭清理，但不等于覆盖所有真实输入法/终端。`Ctrl+E/O/G` 以键盘逐层浏览任务、活动和工具详情；命令补全支持已有的真实 Slash 命令。真实终端截图、验证范围与显示局限见 [验收记录](./docs/design/verification/tui-v0.3/README.md)。

## 配置

| 变量 / 参数 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `API_KEY` | — | 必填，或改用 `OPENAI_API_KEY`；示例占位值 `sk-your-key-here` 会在请求前拒绝 |
| `MODEL` | `gpt-4o-mini` | 模型名；不填写沿用默认值，不代表已验证服务连通 | 
| `AGENT_DEMO` | 未启用 | 设为 `1` 时，仅在 TUI/CLI 标记“外部 Mock 演示”；不会启动模拟服务或跳过 API Key 校验 |
| `WORKDIR` | 当前目录 | 相对路径的默认基准目录（不是访问边界；绝对路径与 `../` 不受它限制） |
| `MAX_STEPS` | `30` | 单次 Run 最多请求模型多少次 |
| `MAX_TOOL_CALLS` | `60` | 单次 Run 最多处理多少次工具调用（参数校验失败也计数；预算跳过不计） |
| `MAX_TOTAL_TOKENS` | `500000` | 单次 Run 的累计 token 预算（软上限：到线后不再发请求，已发生的费用照记）；`0` 表示不限制 |
| `MAX_OUTPUT_TOKENS` | `8192` | 单次模型响应最多生成多少 token |
| `TOOL_TIMEOUT_MS` | `120000` | 单条命令超时 |
| `AGENT_TOOL_LOG` | 未启用 | 设为文件路径时，每次工具调用追加一行 JSON 日志（成功与失败都记）；不设则完全不写。写不进去只在 stderr 提醒一次，不影响工具执行。**日志含参数与结果原文，可能包含敏感内容**，见上文提醒 |
| `--cwd` | 当前目录，其次 `WORKDIR` | CLI 参数（不是环境变量）：把默认目录指向另一个目录，等于先 `cd` 过去再启动；优先于 `WORKDIR`，目录不存在时启动前就报错 |

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

381 个用例，都不需要 API Key、不联网（其中 6 条在 Windows 上跳过：2 条 Linux PTY、SIGINT 投递、2 条 POSIX 文件权限、1 条 POSIX 进程组）：

| 文件 | 打在哪个缝上 |
| --- | --- |
| `test/agent.test.mjs` | `Agent.run`：消息顺序、id 配对、两个预算、最后一步、会话生命周期、取消、token 统计、系统提示词动态刷新 |
| `test/tool-registry.test.mjs` | `ToolRegistry`：Schema 注册校验、未知工具、坏 JSON、工具抛错 |
| `test/tool-hooks.test.mjs` | 工具执行 Hook：三个事件的时机与顺序、前置 Hook 阻止执行、拿到的是副本、Hook 抛错不影响工具结果、九个工作区工具全部经过、一次完整 Run 的 Transcript 不变 |
| `test/tool-log.test.mjs` | 工具调用日志：成功与失败各一行（`shell` 非零退出算失败）、字段与顺序、超长截断、父目录自动创建、写失败只提醒一次、被拦下的调用不留记录 |
| `test/workspace.test.mjs` | 工作区外读写（绝对路径、`../`、符号链接）、完整读取、截断、扫描预算、`edit` 唯一命中、`glob` 模式、`grep` 正则与 `fixed` 模式、灾难性回溯超时、工作区外 shell、取消进程树和 Windows taskkill 错误/非零退出/卡住故障注入 |
| `test/llm.test.mjs` | `Llm.chat`：合法响应归一化、非法形状必须报错、`finish_reason` 与 `tool_calls` 一致性、usage 保留、`max_tokens`、取消、SSE 流式拼装与坏 chunk |
| `test/model-errors.test.mjs` | 错误分类：配置 / 鉴权 / 404 / 网络 / 流式中断各归哪一类，哪些能重试、哪些一律禁止重放 |
| `test/cli.test.mjs` | 端到端：环境变量、退出码、stdout、请求体形状、API Key 回退、SIGINT、失败路径的 usage、TUI 多轮与 `/reset`、已移除的 `--permission` / `AGENT_PERMISSION` 明确报错、流式 mock、TUI 聊天布局 / 命令 / 统计 |
| `test/cli-presenter.test.mjs` | 命令行展示：流式草稿与确认正文不一致时追加更正，同一工具批次不重复提示 |
| `test/cli-pty.test.mjs` | Linux PTY：真实终端里的 TUI 启动、未配置模型提示、不抢鼠标 / 不进备用屏 |
| `test/tui.test.mjs` | TUI：聊天布局、思考动画、终端降级、生命周期与工具活动、状态栏固定完全访问、`Shift+Tab` 不再是快捷键；组合 Unicode / IME 一次上屏、长会话滚动及关闭后资源清理 |
| `test/tui-image.test.mjs` | 图片预览：PNG 解码、透明色与 tRNS、坏 CRC / 缺 IEND 等无效输入必须拒绝并降级 |
| `test/file-index.test.mjs` | 文件清单：跳过 `node_modules` / `.git`、数量上限、`@` 补全的排序口径 |
| `test/prompt-history.test.mjs` | 输入历史：坏行跳过、文件不存在不算错、单条与总条数上限 |
| `test/project-instructions.test.mjs` | 项目指令：读不到返回 `undefined`、空白文件等同没有、超长截断、同名目录不报错 |
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

- 会话持久化到磁盘：进程内的多轮 TUI 已经有了，跨进程恢复 transcript 没有做
- 按轮取消：Ctrl-C 停的是整个会话；只停当前这一轮需要每轮换一个 signal，留给后续
- 鼠标、多行输入和 Hooks 尚未做；TUI 主视图只追加、`Ctrl+T` 回看并展开历史，仍保留底部输入区、`Ctrl+E/O/G` 逐层浏览及 `/` Slash 自动补全（早期布局决策见 [ADR-0016](./docs/adr/0016-tui-v0.3-top-down-layout.md)，主屏渲染见 [ADR-0017](./docs/adr/0017-tui-renders-on-main-screen.md)）。
- 工具并发（串行是有意的，见 [ADR-0003](./docs/adr/0003-run-tool-calls-serially.md)）
- 操作系统级隔离：agent-Kernel 只有完全访问，工具与 Shell 都以启动者的权限执行（见 [ADR-0019](./docs/adr/0019-full-access-is-the-only-mode.md) 与 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)）
- 上下文压缩、非 TUI 模式的自动重试、tokenizer 级精确成本估算（只统计端点返回的 usage）

## 文档与技能

- [CODING_STANDARDS.md](./CODING_STANDARDS.md)：规范本体（语言分层、注释、模块形状、命名、错误处理、防御性编程、测试）。
- [AGENTS.md](./AGENTS.md)：agent 的入口 —— 命令、项目导航（代码地图）、测试放哪。
- [GLOSSARY.md](./GLOSSARY.md)：领域词汇（Core、Step、Transcript、ERROR text……）。
- [docs/permission-design.md](./docs/permission-design.md)：当前权限与访问设计的实现说明（只有完全访问）。
- [docs/adr/](./docs/adr/)：已经定下、别再重新讨论的决定。
- [docs/reports/](./docs/reports/)：阶段修复报告（问题、方案、测试、CI 与评测基线）。
- `.agents/skills/`：装好的 agent 技能（来自 [mattpocock/skills](https://github.com/mattpocock/skills)，MIT）。

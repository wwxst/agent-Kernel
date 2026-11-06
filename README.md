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

`npm install` 只在跑类型检查和测试时需要；`npm run agent` 本身不需要任何依赖。

CLI 默认流式输出：模型生成正文时逐段打印，长回复不再是黑屏等一段。评测走非流式，保证跨轮对比的是同样的完整响应（见 [ADR-0012](./docs/adr/0012-streaming-is-display-only.md)）。

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
| `src/tui.ts` | Claude Code 风格 TUI：顶部项目/模型/路径、对话从顶部排列、短会话输入框跟随内容/长会话停靠底部、工具状态/审批面板、颜色与字形降级、PageUp/PageDown、resize。不碰 Agent 循环 |
| `src/cli.ts` | 组装层：命令行参数 / 环境变量 → 对象图 → 跑一次任务、进 REPL 或进 TUI |

`src/grep-worker.ts` 不算第十一个模块，它是 `Workspace.grep` 的匹配线程：正则跑在里面，主线程超时就 `terminate`（见 [ADR-0010](./docs/adr/0010-grep-regex-in-worker.md)）。

`agent.ts` 不认识 `workspace.ts`：循环只管「问模型、执行调用、塞回结果」，工具怎么实现的它不关心。
它也不认识 `tui.ts`：TUI 只是把 Agent 的回调接到显示层，循环本身不知道有没有界面。这就是为什么换模型、换工具集、换交互壳，循环一行都不用改。

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

路径统一过工作区的路径守卫：`../`、绝对路径、跨盘符都会被拒绝；解析之后还会再比一次**真实路径**，所以符号链接、junction 指向工作区外时同样会被拒绝。错误变成 `ERROR: path escapes workspace` 回灌给模型。

已知边界：`glob` 只认 `*`、`**`、`?` 三种通配，`{}`、`[]` 按字面匹配（这是刻意的，见下）；`glob` / `grep` 默认跳过 `.git` 和 `node_modules`、最多回 200 条命中，单次最多访问 20 000 个目录项，符号链接不跟随；`read` 最多读 32 KB，`grep` 按字节读到 1 MB 为止、超出的文件跳过，`edit` 不接受超过 2 MB 的文件（读不全就拒绝，绝不拿半截内容覆盖），`ls` 最多展示 500 条、扫到 20 000 项就停。`grep` 的正则匹配另有 2 秒预算（只算匹配时间，不算读文件），超时会杀掉匹配线程并标注结果不完整。目录用 `opendir` 边读边收，预算限制的是真正读了多少项，而不是 `readdir` 之后切了多少项；所有截断、跳过、没搜完的统计都保留在结果末尾，不会被结果自己的长度上限吃掉。扫描提前停手时会明说 `results may be incomplete`，不会声称拿到了全局排序结果。

`glob` / `grep` 达到 200 条命中上限时，返回的是**遍历顺序里先遇到的那 200 条**；排序只保证这 200 条内部有序，不保证是全局字典序的前 200 条。要拿稳定 Top N 就得扫完整棵树，那会牺牲扫描预算，所以第一阶段先保留现状并明确标注不完整。已记录为后续优化项。

`grep` 支持**正则**（JavaScript 语法，逐行匹配），但匹配不跑在主线程：每条正则在 `grep-worker.ts` 的线程里执行，主线程只守 2 秒的匹配预算，超时就 `terminate`，把整个线程连同指数级回溯一起扔掉。这样「输入不能让 agent 卡死」仍然成立，而模型拿回了 `a.*b` 这类能力——第一阶段的字面搜索是当时没有 worker 的权宜之计。代价是每次 grep 多一个线程的启动开销，以及结果可能因预算而部分缺失（尾注会明确写 `regex stopped after 2000ms`）。要搜 `a.b`、`([` 这种字面文本，传 `fixed: true` 就能关掉正则解释。取舍记在 [ADR-0010](./docs/adr/0010-grep-regex-in-worker.md)。

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

`workspace-write` 下的 `shell` 每次都要人工确认：输入 `y` / `yes` 允许这一次，其他输入（包括空行）都拒绝。审批界面完整展示待执行命令与实际 cwd：多行命令逐行加 `|` 前缀，控制字符与 bidi 控制字符转义，不折叠换行、不截断尾部。没有 TTY、取消、审批通道异常都按拒绝处理；无 TTY 时不会去读 stdin，避免把管道里的下一行任务当成审批答案。审批等待同时绑定 `AbortSignal` 与 readline 的 `close`：Ctrl-C 会立即结束等待并走取消链（退出码 130），EOF 会明确结束等待并按拒绝处理，不会卡在 `question()` 上。REPL 和审批共用同一个 readline，并按顺序一次只等一行；如果任务运行期间已经排着下一行输入，这次 shell 会被拒绝，那一行留给下一轮任务，不会被当成审批答案。

**Permission 不是 Sandbox。** 它只决定一次 Tool call 放不放行，不改变进程的操作系统权限：没有容器、没有用户切换、没有只读挂载。`workspace-write` 的 `shell` 一旦被批准，子进程就和启动它的人同权，可以 `cd ..` 走出工作区；`read` / `write` 的路径守卫拦的是模型手滑，不是恶意代码（见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)）。真隔离得靠容器、虚拟机、独立用户或只读挂载，不能靠 Permission 的字符串判断。取舍见 [ADR-0013](./docs/adr/0013-permission-is-a-policy-not-a-sandbox.md)。

## 轻量 TUI v0.3

`npm run agent -- --tui` 在同一个 Agent / Permission 会话外面套一个聊天式终端界面；`--repl` 保持原样，两者不能同时用。`--tui` 后面可以跟一个初始任务：先跑完，再等下一行输入。布局与验收规则见 [TUI v0.3 规范](./docs/design/tui-v0.3-layout-spec.md)。

布局：

- **顶部**：项目名（左）和 model（右），下一行是 workspace 路径，再一条分隔线。
- **对话区**：内容**从视口顶部往下**排列；用户 `❯`、模型 `✻`，工具调用先显示 `●`，结果到达后原地替换成 `✓` / `✗` / `⊘`（权限拒绝）/ `–`（未执行）。工具执行期间附弱化的 `Running...` 子行，待审批时由完整审批面板表示等待。短会话输入区紧跟消息，大块空白留在输入区下方。
- **输入框**：短会话紧跟当前消息，长会话自动停靠底部；用两条灰色横线划分输入区域，与正文共享左边缘。空会话显示占位符 `Ask anything, or type /help...`，开始对话后只保留提示符和光标。长输入横向滚动，提交原文不变。readline 保留编辑缓存，TUI 统一绘制，输入期间的新输出也能刷新。
- **状态行**：始终紧跟输入框**下方**，左边当前权限（`read-only` / `workspace-write` / `full-access`），右边 requests / tool calls / tokens。
- 不切 alternate screen、不引 TUI 库；差分重绘只写变化的行，退出后 TUI 历史不会留在 scrollback 里。非 TTY（管道、CI、e2e）退化为纯逐行输出。

工具与审批：

- 工具事件使用 `Read README.md`、`Shell: npm run check` 这类可读形式，不重复打印同一条调用；工具名称中性粗体，状态符号单独着色，缩进子行显示结果摘要与读取行数，读取截断仍有明确尾注。
- 失败/拒绝/未执行的第一行原因放在工具事件下方，正文不截断关键原因；`read` 不把整份文件内容刷进聊天区。
- `workspace-write` 下的 `shell` 审批显示为完整边框面板：实际 workspace、完整命令、`[Y] Allow once` / `[N] Deny`；回答在下方输入框里输入。只有 `y` / `yes` 放行，没有 TTY 时直接按权限拒绝。

外观与交互：

- 自动检测颜色能力：16 色 / 256 色、`NO_COLOR`、`TERM=dumb`；无颜色终端仍靠框线和符号可读。
- Windows Terminal / VS Code 终端 / Linux 使用 `❯`、`✻`、`●`、`✓`、`✗`、`⊘`、`┌┐└┘─│`；传统 Windows conhost 退化成 `>`、`*`、`o`、`+`、`x`、`!`、`-`、`|`，不会显示方框。
- **Thinking**：动画符号后的点按 `Thinking` → `Thinking.` → `Thinking..` → `Thinking...` 每 400ms 循环，耗时列固定；下一行弱化显示 `Ctrl-C to cancel`。工具返回后的等待可显示本次实际收到的工具结果数。第一段正文、工具调用或错误到达时清除并停止计时。结束时显示本次实际经过时间与工具调用数，不推断模型内部思考或尚未返回的 token。
- **历史滚动**：PageUp / PageDown 查看之前对话，状态行显示 `↑ N lines` / `^ N lines`；滚动期间新输出不把视口拉回底部，发送新任务时回到最新。
- **窗口 resize**：监听 stdout 的 resize 事件，重新计算标题、对话视口、审批面板、输入框和状态行。小于 12 行或 30 列时使用逐行输出，放大后恢复固定布局并保留草稿与 Run log；`TERM=dumb` 始终逐行显示。
- 命令与 REPL 相同：`/exit`、`/reset`、`/permission [mode]`、`/help`。`/reset` 换 Agent，不换 Permission；`/permission` 切换后状态行和下一次请求同时生效。

统计按 Session 累计；只要有一条请求没有 usage，就写 `at least`，不把已知下限说成精确值。取舍见 [ADR-0016](./docs/adr/0016-tui-v0.3-top-down-layout.md)。逐张参考图对照后的实际效果见 [Windows Terminal 验收截图](./docs/design/verification/tui-v0.3-windows-terminal/README.md)。

已知边界：固定布局要求终端至少 12 行、30 列；宽度按近似显示宽度换行（CJK / emoji 按 2 列，组合字符按 0 列），不做完整 Unicode East Asian Width 表；正文硬换行；差分重绘在慢终端上仍可能闪烁；Run log 保留最近 2000 条逻辑行，待审批的完整命令独立保留至回答；没有鼠标、多行输入、工具详情展开或 `/` 命令菜单。真实终端截图、验证范围与显示局限见 [验收记录](./docs/design/verification/tui-v0.3/README.md)。

## 配置

| 变量 / 参数 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `API_KEY` | — | 必填，或改用 `OPENAI_API_KEY` |
| `MODEL` | `gpt-4o-mini` | 模型名 |
| `WORKDIR` | 当前目录 | 文件工具的根目录（不是安全边界） |
| `MAX_STEPS` | `30` | 单次 Run 最多请求模型多少次 |
| `MAX_TOOL_CALLS` | `60` | 单次 Run 最多真正执行多少次工具调用 |
| `MAX_TOTAL_TOKENS` | `500000` | 单次 Run 的累计 token 预算（软上限：到线后不再发请求，已发生的费用照记）；`0` 表示不限制 |
| `MAX_OUTPUT_TOKENS` | `8192` | 单次模型响应最多生成多少 token |
| `TOOL_TIMEOUT_MS` | `120000` | 单条命令超时 |
| `--permission` | `workspace-write` | CLI 参数（不是环境变量）：`read-only` / `workspace-write` / `full-access` |

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
| `test/workspace.test.mjs` | 路径越界、完整读取、截断、扫描预算、符号链接、`edit` 唯一命中、`glob` 模式、`grep` 正则与 `fixed` 模式、灾难性回溯超时、取消进程树 |
| `test/llm.test.mjs` | `Llm.chat`：合法响应归一化、非法形状必须报错、`finish_reason` 与 `tool_calls` 一致性、usage 保留、`max_tokens`、取消、SSE 流式拼装与坏 chunk |
| `test/cli.test.mjs` | 端到端：环境变量、退出码、stdout、请求体形状、API Key 回退、SIGINT、失败路径的 usage、REPL 多轮与 `/reset`、`/permission` 动态提示、`--permission`、流式 mock、TUI 聊天布局 / 命令 / 统计 |
| `test/cli-pty.test.mjs` | Linux PTY：审批允许 / 拒绝 / Ctrl-C / EOF，以及 REPL 审批 EOF 不冒充用户拒绝 |
| `test/tui.test.mjs` | TUI：对话贴顶、输入框/状态行、工具运行/成功/失败/拒绝/未执行、审批面板完整命令与 cwd、y/N、thinking、颜色开关、PageUp/PageDown、resize、中文宽度 |
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

跨天验证与诊断模式的约束、归档路径和使用方法见 [docs/eval-diagnostics.md](./docs/eval-diagnostics.md)。

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
- 全屏 TUI / alternate screen、鼠标、多行输入、工具详情展开、`/` 命令菜单和 Hooks：TUI v0.3 只做顶部对话、带框输入、状态行、工具状态和可滚动审批面板（见 [ADR-0016](./docs/adr/0016-tui-v0.3-top-down-layout.md)）
- 工具并发（串行是有意的，见 [ADR-0003](./docs/adr/0003-run-tool-calls-serially.md)）
- 操作系统级隔离：Permission v0.1 只做工具调用策略（见 [ADR-0013](./docs/adr/0013-permission-is-a-policy-not-a-sandbox.md)），不是 Sandbox；`shell` 放行后仍是启动者的权限（见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)）
- 上下文压缩、自动重试、tokenizer 级精确成本估算（只统计端点返回的 usage）

## 文档与技能

- [CODING_STANDARDS.md](./CODING_STANDARDS.md)：规范本体（语言分层、教学式注释、模块形状、命名、错误处理、防御性编程、测试）。
- [AGENTS.md](./AGENTS.md)：agent 的入口 —— 命令、代码地图、测试放哪。
- [GLOSSARY.md](./GLOSSARY.md)：领域词汇（Kernel、Step、Transcript、ERROR text……）。
- [docs/adr/](./docs/adr/)：已经定下、别再重新讨论的决定。
- [docs/reports/](./docs/reports/)：阶段修复报告（问题、方案、测试、CI 与评测基线）。
- `.agents/skills/`：装好的 agent 技能（来自 [mattpocock/skills](https://github.com/mattpocock/skills)，MIT）。

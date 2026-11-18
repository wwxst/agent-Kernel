# AGENTS.md

agent-Kernel 的文档分工很简单：`README.md` 讲项目是什么和怎么开始；`docs/` 讲当前实现和设计；`AGENTS.md` 讲 AI / 开发者怎么改；`CODING_STANDARDS.md` 讲代码规范；`docs/adr/` 记录为什么这样设计；`eval/` 记录 Agent 实际能力。

agent-Kernel 是一个最小 coding agent：模型说话，内核把工具调用跑掉，把结果发回去。
给人看的介绍在 [README.md](./README.md)，领域词汇在 [GLOSSARY.md](./GLOSSARY.md)。
**规范本体在 [CODING_STANDARDS.md](./CODING_STANDARDS.md)：写或改 `src/`、`test/` 之前先读它**（注释、模块形状、命名、错误处理、防御性编程、测试、提交）。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm test` | 全部测试，不需要 API Key、不联网 |
| `npm run typecheck` | `tsc --noEmit`（strict） |
| `npm run check` | 上面两个一起跑：提交前跑这个 |
| `npm run agent -- "<task>"` | 真跑一次，需要 `.env` |
| `npm run agent -- --cwd <dir> "<task>"` | 工作区指向别的目录（等于先 `cd` 再启动），项目本身不用复制过去；优先于 `WORKDIR` |
| `npm link` → `agent --tui` | 装一次全局命令（同时注册 `agent` 与 `agent-kernel`），之后在任意目录直接开；工作区 = 当前目录，`.env` 从本仓库读（入口 `bin/agent.mjs`） |
| `npm run agent --` | 不带任务：直接进全屏 TUI（唯一交互界面）；`--repl` 已移除，传入会报错 |
| `npm run agent -- --tui ["<task>"]` | TUI：主视图在主屏就地追加（历史留在 Shell scrollback），`Ctrl+T` 进 transcript 整屏视图回看历史；不捕获鼠标；非 TTY 普通文本输出，`AGENT_TUI_COLOR=mono/full` 控制层次配色，`AGENT_TUI_THEME=dark/light/ansi` 选配色方案；需 `.env` |
| `npm run eval` | 评测集：20 个真实小任务，记录成功率/请求数/工具调用/token/耗时；需要 `.env`，会花钱 |
| `npm run eval:check` | 评测自检：不调用模型，验证每个任务初始状态确实会断言失败 |
| `npm run eval:summary` | 汇总最近 3 轮完整评测的通过率、请求数、耗时中位数；`-- 5` 指定轮数。只读 `eval/results/`，不花钱 |
| `npm run eval:cross-day -- --date <YYYY-MM-DD>` | 跨天评测：在固定 commit `eac798d`（tag `stability-2026-11-05-prompt-v2`）上跑 3 轮，按日期归档；需要 `.env` |

**任务参数是多行文本时，别走 `npm run`。** Windows 上 npm 经 `cmd.exe` 转发参数，内容会断在第一个换行处，而且不报错 —— 模型只收到第一行，看起来像它没听懂你的要求。多行任务直接跑入口：

```bash
node --env-file-if-exists=.env src/cli.ts "<多行任务>"
```

`cli.ts` 的 `parseArgs` 是按 argv 数组拼接的，本身支持多行；截断只发生在 npm 这一层，绕过它即可。

## 代码地图

`src/` 按职责分五层：`protocol/`（类型与错误，处在依赖图最底层）、`core/`（循环与调度）、`tools/`（给模型的工具：文件与 shell）、`model/`（跟模型打交道：请求与系统提示）、`ui/`（终端展示）。`cli.ts` 留在根目录，是唯一的组装入口 —— 看目录名就知道那堆文件管什么，不用点进去。

**这张表只说「这个文件大概负责什么」，用来找地方。** 某个文件里到底有哪些类、函数、接口、常量、逻辑区域，打开该文件看它开头的文件头 —— 那里是唯一权威。两边不写同一份内容：这里写细了，改一次函数就要改两个地方，忘一个就互相矛盾。

| 文件 | 大概负责什么 |
| --- | --- |
| `src/protocol/types.ts` | 协议词汇：消息、工具、工具调用、token 用量的类型 |
| `src/protocol/errors.ts` | 所有错误的类型，以及「把意外说成一句话」的文案兜底 |
| `src/core/agent.ts` | **Core**：agent loop、消息顺序、请求与工具预算、无进展检测、会话生命周期、上下文压缩的调度与提交门槛 |
| `src/core/context-compact.ts` | 上下文压缩的纯计算：请求体积与 token 估算、Snip、可移除历史段切分、摘要提示词与合格性检查 |
| `src/core/context-archive.ts` | 有损压缩前保存原文，返回可供 `read` 使用的绝对路径 |
| `src/core/tool-registry.ts` | 工具注册表：查工具、校验参数、执行、把失败折成 `ERROR` 文本；围着执行触发三个 Hook 事件 |
| `src/core/tool-hooks.ts` | 工具执行的三个扩展事件（`PreToolUse` / `PostToolUse` / `PostToolUseFailure`）：登记顺序、阻止、故障隔离 |
| `src/core/tool-log.ts` | 第一个真实 Hook 用户：每次调用追加一行 JSON 到 `AGENT_TOOL_LOG` 指定的文件 |
| `src/core/tool-result-status.ts` | 判断一次工具结果算不算失败，给 CLI / TUI 上色用 |
| `src/tools/todo.ts` | TodoWrite：校验和更新会话内任务计划，对模型提供 `todo_write` 工具 |
| `src/tools/subagent.ts` | 委派：两种子 Agent 角色（只读调查 / 可写执行）的工具与系统提示、`run_subagent` 工具、参数校验与结果排版；只依赖 `protocol/`，不 import `Agent` |
| `src/tools/workspace.ts` | 给模型的文件与 shell 工具：读写改、搜索、跑命令（含后台任务） |
| `src/tools/grep-worker.ts` | `grep` 的正则匹配放独立线程跑，好让主线程能超时打断 |
| `src/model/llm.ts` | 跟模型服务说话：发请求、收流式响应、解析用量 |
| `src/model/project-instructions.ts` | 读项目里的 `AGENTS.md`，塞进系统提示 |
| `src/model/skills.ts` | 技能目录：扫两级 `.agents/skills`、解析 `SKILL.md` 元数据、拼出系统提示里那段目录；只给位置，正文由模型自己 `read` |
| `src/ui/tui.ts` | 全屏终端界面：主视图、transcript 视图、工具活动的分层展示 |
| `src/ui/tui-image.ts` | 把读到的图片变成终端里看得懂的文字缩略图 |
| `src/ui/tui-mood.ts` | 状态栏那几句中英文角色台词 |
| `src/ui/cli-presenter.ts` | 非 TUI 的纯文本输出：阶段、台词、日志展开 |
| `src/ui/prompt-history.ts` | 输入历史：一行一条落盘，跨进程还在 |
| `src/ui/file-index.ts` | `@` 补全用的工作区文件清单 |
| `src/ui/text.ts` | 把控制字符变成看得见的转义，防止终端被搞乱 |
| `src/cli.ts` | 组装入口：命令行参数 / 环境变量 → CLI 或 TUI |
| `bin/agent.mjs` | `npm link` 后的全局命令入口：加载 `.env`，交给 `cli.ts` |

依赖方向：`cli` → `core` / `tools` / `model` / `ui` / `protocol`；`core`、`tools`、`model` → `protocol`；`ui` → `core`（统计类型与工具失败判断）、`protocol`。`protocol` 是叶子；`core` 不认识 `tools`，也不认识 `ui`，更不认识任何权限策略（只有完全访问，工具直接执行）。

## 测试放哪

每个外部接口一处缝，重构不该让任何用例变红：

- `Agent.run`（用 `test/support/harness.mjs` 里的脚本化 `ChatClient`）：消息顺序、id 配对、三个预算、无进展循环检测（连续相同批次停止且配对完整、结果变化时继续、按 Run 重算）、最后一步、会话生命周期（多 Run、预算按 Run 重算）、取消、token 统计、system 提示动态刷新、`onRequestStart` / `onToolCall` / `onToolResult` 的顺序，以及压缩发生在工具结果被消费之后而不是之前。
- `test/context-compact.test.mjs`：上下文压缩这一层 —— 短对话不压、工具定义计入体积、字符路径与 token 路径分开、最新批次完整、旧结果先裁、两刀之后引用仍指向完整原文、超大结果先存档再预览、存档失败不做有损替换、旧轮次与单轮多步都能折叠、压缩后 system 里留下可读的存档清单、多次压缩是替换而非追加、摘要为空/不合格/失败/取消都不提交、失败配额按 Run 重算（不会永久关闭压缩）、摘要花掉预算后不再发业务请求、取消时用量只记一次、摘要请求不带工具且单独计数、摘要请求按**序列化后的真实体积**裁剪（转义密集的历史缩短后仍能发出、原文仍可读回）、输出预留为 0 时摘要长度下限仍容得下合法八节结构、连最小合法摘要都装不下时不发请求并明确失败、`reasoning_content` 不被删、溢出只恢复一次且不重跑工具、压缩后仍装不下的请求不再发送、两个 Agent 互不影响、长任务回放后配对完整且目标仍在。摘要请求的假答复由 `test/support/harness.mjs` 的 `CANNED_SUMMARY` 提供，不消耗脚本项。
- `ToolRegistry`：Schema 注册校验、未知工具、坏 JSON、参数类型错误，以及每个失败分支都折成文本；声明了 `strictArguments` 的工具会拒绝未声明的参数（默认仍忽略，`shell` 靠这一点让 Worker 包装层吞掉 `background`）；进程树清理未确认仍抛 `ProcessCleanupError`。
- `ToolHooks`（`test/tool-hooks.test.mjs`）：三个事件的时机与顺序、前置 Hook 阻止执行且异常时 fail-closed、后置 Hook 抛错不影响工具结果、Hook 拿到副本、九个工作区工具全部经过同一个入口。新增工具不需要在这里加用例 —— 它们走的是同一个 `execute`。
- `test/tool-log.test.mjs`：内置的工具调用日志 Hook —— 成功/失败各一行（`shell` 非零退出算失败）、超长截断、写失败只提醒一次、被拦下的调用不留记录。
- `test/subagent.test.mjs`：委派这一层 —— 参数校验（空任务、超长、非法 mode、默认 explore）、结果格式（完成 / 失败 / 取消 / 预算提示 / 超长截断）、两种角色的工具清单、Worker 的 shell 是否真的只能前台、上下文隔离与「只回一条结果」、子 Agent 的两道预算、失败/取消的委派必须标记 `isError`（Hook 走 `PostToolUseFailure`、工具日志记 `ok:false`）、进程树未确认时必须抛 `ProcessCleanupError`。`cli.test.mjs` 的委派用例守着真实装配：子 Agent 的提示与工具表、`MAX_STEPS` 取较小值、execute 真的改到文件。
- `test/skills.test.mjs`：技能目录这一层 —— 两级发现与同名覆盖、换项目只发现目标项目的技能、坏技能逐个跳过并写明原因、长描述裁剪、控制字符不能伪造出目录项、超预算与超扫描上限都要写明（只说「没读完」，不编剩余数量）、两级共享扫描预算、普通文件与隐藏目录不算技能、条目枚举有上限（1023/1024/1025 三档边界，恰好 1024 条算读完）、两种上限同时触发时两种原因都写出来、目录不存在与「读不了」分开（`ENOENT`/`ENOTDIR` 归 absent，其余 errno 归 unreadable；分类表直接压，端到端用真实 ELOOP 链接验证 errno 保留、不连累另一级、提示里那句原因不带路径）、FIFO 不阻塞、符号链接按设计处理、名称规则、frontmatter 支持的子集（引号、行内注释、块标量、非法 YAML 拒绝、中文与 Emoji）。`cli.test.mjs` 的技能用例守着真实装配：目录进系统提示且不带正文、目录里写的路径真能被 `read` 打开、`--cwd` 换项目、长文件读出来报告截断、增删改后下一轮就更新、三种角色都发现技能且子 Agent 不继承父 Agent 读过的正文。
- `Workspace` 的九个方法：工作区外读写（绝对路径、`../`、符号链接）、有界读取、`read` 的 `offset` / `limit` 行窗口（跨块不切行、CRLF 原样、越界明确报错、可取消）、扫描预算、exit code、`edit` 唯一命中、`glob` 模式、`grep` 正则与 `fixed` 模式（含灾难性回溯必须被超时打断）、`grep` 的 `path` 可以是单个文件、工作区外 shell、取消进程树；Windows taskkill 注入错误、非零退出、卡住时有界结束并显式报告未确认。写/改采用临时文件+rename 原子替换，测试取消前提交、权限保留和 grep 链接换向；不保证父目录 TOCTOU 全部消除。后台任务单独覆盖：立即返回编号、增量输出不重复、exit code 状态、单次 8k 上限与「还有」提示、被切断的多字节字符不变成替换字符、`shell-kill` 后进程真的消失、未知编号报错并列出已知项。
- `Llm.chat`（对着假 HTTP 端点）：合法响应归一化、非法形状必须报错，不能变成「空成功」；usage 与 `max_tokens`；SSE 流式的正文 / tool_calls 拼装与坏 chunk。
- `test/tui.test.mjs` + `test/tui-image.test.mjs`：主视图只追加（历史留在 scrollback）、`Ctrl+T` transcript 视图、折叠层次、真实提交的 Diff、读图缩略图、状态栏固定完全访问、`Shift+Tab` 不再是快捷键、thinking、颜色、resize、中文宽度、复杂输入与关闭清理；假终端覆盖跨平台，`test/cli-pty.test.mjs` 额外在 Linux PTY 验证真实终端输入、不捕获鼠标与不进备用屏。
- `test/cli.test.mjs`：端到端验证组装 —— 环境变量、退出码、stdout、请求体形状、取消、TUI 布局/命令/统计，且占位 Key 不发请求、SSE 未完成友好提示/去重、HTTP 鉴权分类；循环细节留在单元层。
- `eval/selfcheck.mjs`：初始断言失败、任务无效、基础设施错误必须分开。

这里只记「哪处缝由谁守着」。某个测试文件具体覆盖哪些情况，看那个文件自己的文件头。

写法规范见 [CODING_STANDARDS.md](./CODING_STANDARDS.md) 第 7 节。

## 长期文档

先从 [docs/README.md](./docs/README.md) 找入口。

- [docs/architecture.md](./docs/architecture.md)：当前真实架构，回答“现在到底怎么跑”。
- [docs/configuration.md](./docs/configuration.md)：配置、命令行参数和运行边界。
- [docs/tui.md](./docs/tui.md)：TUI 的当前行为和展示层边界。
- [docs/design/](./docs/design/)：跨模块、可长期复用的设计原则。
- [docs/contracts/](./docs/contracts/)：行为契约和验证口径。
- [docs/adr/](./docs/adr/)：最终架构决定、理由、代价和不变量；被取代的 ADR 必须标明历史状态。
- [ADR-0029](./docs/adr/0029-context-compaction-is-bounded-and-recoverable.md)：上下文压缩的预算、原文存档、摘要提交与溢出恢复边界。
- [docs/course/](./docs/course/)：17 课课程资料，定位是研究路线和设计参考，不代表当前实现。

长期文档不保存调试流水账、阶段计划、单次 PR 验收截图；普通修复由代码、测试和 Git 历史承载。

## 文档规则

### 1. 不要把同一件事写三遍

- README：项目入口，只写用户真正需要知道的内容。
- 当前架构文档：详细解释现在的实现。
- ADR：只记录为什么做这个选择，以及放弃了什么。
- AGENTS：告诉 AI 改代码时应该遵守什么规则。
- eval：记录 Agent 实际跑出来的结果。

### 2. 课程不是实现

`docs/course/` 里的课程内容只能作为研究和设计参考。

课程里讲到一个能力，不代表 agent-Kernel 已经实现这个能力。真正进入当前项目必须经过：

`设计 → ADR（必要时）→ 实现 → 测试 → eval 验证`

当前代码和当前架构文档高于课程资料。

### 3. 代码变了，按影响范围更新文档

- 用户运行方式变了 → README / `docs/configuration.md`
- 架构行为变了 → `docs/architecture.md`
- TUI 行为变了 → `docs/tui.md`
- 设计取舍变了 → 新增或更新 ADR
- 评测口径变了 → `eval/README.md` / `eval/baseline.md`
- 术语发生变化 → `GLOSSARY.md`

不要为了“完整”把源码实现细节重新塞回 README。

## Agent skills

技能装在 `.agents/skills/`（来自 [mattpocock/skills](https://github.com/mattpocock/skills)，MIT）。每次模型请求前扫描这个目录（项目级优先，其次是 `~/.agents/skills`；只看 `--cwd` 指定的工作区根目录，不向上递归），把名字、用途和文件路径放进系统提示；正文由模型自己用 `read` 取，不预先塞进上下文。新增或删除技能下一次请求就生效，不需要重启。取舍见 [ADR-0028](./docs/adr/0028-skills-are-files-read-on-demand.md)。

### Issue tracker

本地 markdown：`.scratch/<feature>/`。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个标准角色，在本地 tracker 里写成工单顶部的 `Status:` 行。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根目录一个 `GLOSSARY.md` 加 `docs/adr/`。见 `docs/agents/domain.md`。

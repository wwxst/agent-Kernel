# AGENTS.md

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
| `npm run agent -- "<task>"` | 默认就是完全访问：没有审批，也没有工作区目录边界；`--permission` / `AGENT_PERMISSION` 已移除，传入会报错 |
| `npm run agent -- --cwd <dir> "<task>"` | 工作区指向别的目录（等于先 `cd` 再启动），项目本身不用复制过去；优先于 `WORKDIR` |
| `npm link` → `agent --tui` | 装一次全局命令（同时注册 `agent` 与 `agent-kernel`），之后在任意目录直接开；工作区 = 当前目录，`.env` 从本仓库读（入口 `bin/agent.mjs`） |
| `npm run agent --` | 不带任务：直接进全屏 TUI（唯一交互界面）；`--repl` 已移除，传入会报错 |
| `npm run agent -- --tui ["<task>"]` | TUI：主视图在主屏就地追加（历史留在 Shell scrollback），`Ctrl+T` 进 transcript 整屏视图回看历史；不捕获鼠标；非 TTY 普通文本输出，`AGENT_TUI_COLOR=mono/full` 控制层次配色，`AGENT_TUI_THEME=dark/light/ansi` 选配色方案；需 `.env` |
| `npm run eval` | 评测集：20 个真实小任务，记录成功率/请求数/工具调用/token/耗时；需要 `.env`，会花钱 |
| `npm run eval:check` | 评测自检：不调用模型，验证每个任务初始状态确实会断言失败 |
| `npm run eval:cross-day -- --date <YYYY-MM-DD>` | 跨天评测：在固定 commit `eac798d`（tag `stability-2026-11-05-prompt-v2`）上跑 3 轮，按日期归档；需要 `.env` |

## 代码地图

`src/` 按职责分五层：`protocol/`（类型与错误，处在依赖图最底层）、`core/`（循环与调度）、`tools/`（给模型的工具：文件与 shell）、`model/`（跟模型打交道：请求与系统提示）、`ui/`（终端展示）。`cli.ts` 留在根目录，是唯一的组装入口 —— 看目录名就知道那堆文件管什么，不用点进去。

**这张表只说「这个文件大概负责什么」，用来找地方。** 某个文件里到底有哪些类、函数、接口、常量、逻辑区域，打开该文件看它开头的文件头 —— 那里是唯一权威。两边不写同一份内容：这里写细了，改一次函数就要改两个地方，忘一个就互相矛盾。

| 文件 | 大概负责什么 |
| --- | --- |
| `src/protocol/types.ts` | 协议词汇：消息、工具、工具调用、token 用量的类型 |
| `src/protocol/errors.ts` | 所有错误的类型，以及「把意外说成一句话」的文案兜底 |
| `src/core/agent.ts` | **Core**：agent loop、消息顺序、请求与工具预算、会话生命周期 |
| `src/core/tool-registry.ts` | 工具注册表：查工具、校验参数、执行、把失败折成 `ERROR` 文本 |
| `src/core/tool-result-status.ts` | 判断一次工具结果算不算失败，给 CLI / TUI 上色用 |
| `src/tools/workspace.ts` | 给模型的文件与 shell 工具：读写改、搜索、跑命令（含后台任务） |
| `src/tools/grep-worker.ts` | `grep` 的正则匹配放独立线程跑，好让主线程能超时打断 |
| `src/model/llm.ts` | 跟模型服务说话：发请求、收流式响应、解析用量 |
| `src/model/project-instructions.ts` | 读项目里的 `AGENTS.md`，塞进系统提示 |
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

九处缝，重构不该让任何用例变红：

- `Agent.run`（用 `test/support/harness.mjs` 里的脚本化 `ChatClient`）：消息顺序、id 配对、两个预算、最后一步、会话生命周期（多 Run、预算按 Run 重算）、取消、token 统计、system 提示动态刷新、`onRequestStart` / `onToolCall` / `onToolResult` 的顺序。
- `ToolRegistry`：Schema 注册校验、未知工具、坏 JSON、参数类型错误，以及每个失败分支都折成文本；进程树清理未确认仍抛 `ProcessCleanupError`。
- `Workspace` 的九个方法：工作区外读写（绝对路径、`../`、符号链接）、有界读取、扫描预算、exit code、`edit` 唯一命中、`glob` 模式、`grep` 正则与 `fixed` 模式（含灾难性回溯必须被超时打断）、工作区外 shell、取消进程树；Windows taskkill 注入错误、非零退出、卡住时有界结束并显式报告未确认。写/改采用临时文件+rename 原子替换，测试取消前提交、权限保留和 grep 链接换向；不保证父目录 TOCTOU 全部消除。后台任务单独覆盖：立即返回编号、增量输出不重复、exit code 状态、单次 8k 上限与「还有」提示、被切断的多字节字符不变成替换字符、`shell-kill` 后进程真的消失、未知编号报错并列出已知项。
- `Llm.chat`（对着假 HTTP 端点）：合法响应归一化、非法形状必须报错，不能变成「空成功」；usage 与 `max_tokens`；SSE 流式的正文 / tool_calls 拼装与坏 chunk。
- `test/tui.test.mjs` + `test/tui-image.test.mjs`：主视图只追加（历史留在 scrollback）、`Ctrl+T` transcript 视图、折叠层次、真实提交的 Diff、读图缩略图、状态栏固定完全访问、`Shift+Tab` 不再是快捷键、thinking、颜色、resize、中文宽度、复杂输入与关闭清理；假终端覆盖跨平台，`test/cli-pty.test.mjs` 额外在 Linux PTY 验证真实终端输入、不捕获鼠标与不进备用屏。
- `test/cli.test.mjs`：端到端验证组装 —— 环境变量、退出码、stdout、请求体形状、取消、TUI 布局/命令/统计，且占位 Key 不发请求、SSE 未完成友好提示/去重、HTTP 鉴权分类；循环细节留在单元层。
- `eval/selfcheck.mjs`：初始断言失败、任务无效、基础设施错误必须分开。

这里只记「哪处缝由谁守着」。某个测试文件具体覆盖哪些情况，看那个文件自己的文件头。

写法规范见 [CODING_STANDARDS.md](./CODING_STANDARDS.md) 第 7 节。

## 领域文档

- [GLOSSARY.md](./GLOSSARY.md)：概念、关系、要避开的同义词。
- [docs/permission-design.md](./docs/permission-design.md)：当前权限与访问设计（只有完全访问；路径解析、Shell、网络、稳定性保护）。
- [docs/adr/](./docs/adr/)：已经定下、别在评审里重新讨论的决定。
- [docs/design/display-layers.md](./docs/design/display-layers.md)：概览层与详情层怎么分，终端与未来前端共用。
- [docs/notes/tui-pitfalls.md](./docs/notes/tui-pitfalls.md)：TUI 踩过的十五个坑 + 四条底层规则，动渲染层前必读。
- [docs/notes/cli-and-tooling.md](./docs/notes/cli-and-tooling.md)：命令行参数、全局安装、测试迁移的九个坑。
- [docs/notes/background-jobs.md](./docs/notes/background-jobs.md)：后台任务六个坑（管道卡住宿主、Windows `shell+detached` 丢输出、增量读的字节边界），动 `shell` 前后台路径前必读。
- [docs/compare/agent-cli-matrix.md](./docs/compare/agent-cli-matrix.md)：与 Claude Code / Codex 的逐项能力对照，缺口清单。
- [docs/agents/domain.md](./docs/agents/domain.md)：探索代码前该读什么。

## Agent skills

技能装在 `.agents/skills/`（来自 [mattpocock/skills](https://github.com/mattpocock/skills)，MIT）。DSH 在会话开始时扫描这个目录，改动后新开一个会话才生效。

### Issue tracker

本地 markdown：`.scratch/<feature>/`。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个标准角色，在本地 tracker 里写成工单顶部的 `Status:` 行。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根目录一个 `GLOSSARY.md` 加 `docs/adr/`。见 `docs/agents/domain.md`。

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
| `npm run agent -- --permission <mode> "<task>"` | 指定权限：`read-only` / `workspace-write`（默认）/ `full-access` |
| `npm run agent -- --cwd <dir> "<task>"` | 工作区指向别的目录（等于先 `cd` 再启动），项目本身不用复制过去；优先于 `WORKDIR` |
| `npm link` → `agent --tui` | 装一次全局命令（同时注册 `agent` 与 `agent-kernel`），之后在任意目录直接开；工作区 = 当前目录，`.env` 从本仓库读（入口 `bin/agent.mjs`） |
| `npm run agent --` | 不带任务：直接进全屏 TUI（唯一交互界面）；`--repl` 已移除，传入会报错 |
| `npm run agent -- --tui [--permission <mode>] ["<task>"]` | TUI：主视图在主屏就地追加（历史留在 Shell scrollback），`Ctrl+T` 进 transcript 整屏视图回看历史；不捕获鼠标；非 TTY 普通文本输出，`AGENT_TUI_COLOR=mono/full` 控制层次配色；需 `.env` |
| `npm run eval` | 评测集：20 个真实小任务，记录成功率/请求数/工具调用/token/耗时；需要 `.env`，会花钱 |
| `npm run eval:check` | 评测自检：不调用模型，验证每个任务初始状态确实会断言失败 |
| `npm run eval:cross-day -- --date <YYYY-MM-DD>` | 跨天评测：在固定 commit `eac798d`（tag `stability-2026-11-05-prompt-v2`）上跑 3 轮，按日期归档；需要 `.env` |

## 代码地图

| 文件 | 职责 | 对外接口 |
| --- | --- | --- |
| `src/types.ts` | 协议词汇，不依赖任何人 | `Message`、`Tool`、`ToolDefinition`、`TokenUsage`、`ChatClient` |
| `src/errors.ts` | 错误文案兜底、模型配置/HTTP/网络/SSE 错误类型与纯展示分类、进程树清理未确认致命错误 | `describeError(error)`、`modelFailure(error, language)`、`ChatResponseError` |
| `src/agent.ts` | **Kernel**：循环、消息顺序、请求/工具预算、会话生命周期；四种展示回调（单次开始事件）异常隔离并累计诊断 | `Agent.run(task)`、`sessionStats`、`transcript`、`stats`、`observerFailureCount` |
| `src/tool-registry.ts` | 工具查找、Schema 注册校验、参数解析、显式权限注入（`Permission` 或 `null`）、失败折成 `ERROR` | `ToolRegistry.execute(call)`、`definitions` |
| `src/tool-result-status.ts` | 纯展示事实判断：非 Shell 的 `ERROR:` 与 Shell 的 exit / timeout / cancelled；CLI/TUI 复用，不改工具结果文本 | `isToolResultFailure` |
| `src/permission.ts` | 三档权限策略、`permissionPrompt` 模型指导、shell 的一次性审批、审批期间撤权后的版本复验；不是沙箱 | `Permission`、`PermissionMode`、`parsePermissionMode`、`isApproved`、`approvalGate`、`permissionPrompt` |
| `src/approval.ts` | 审批提示格式化与读取：完整命令、实际 cwd、控制字符转义；`AbortSignal` / readline close / 正常回答的竞态收口 | `formatApproval`、`askWithSignal` |
| `src/workspace.ts` | 工作区文件与 Shell：真实路径守卫、临时文件原子替换与取消检查、grep 物理扫描起点、有界读取/扫描、进程树清理期限及失败告警；父目录 TOCTOU 仍有已知边界 | `Workspace.read/write/edit/glob/grep/list/run`、`createWorkspaceTools()` |
| `src/grep-worker.ts` | `grep` 的正则匹配线程：逐行匹配，主线程超时/取消时 terminate；不依赖任何模块 | — |
| `src/llm.ts` | `ChatClient` 的 HTTP 适配器，含 usage、`max_tokens` 与 SSE 流式 | `Llm.chat(messages, tools, options)` |
| `src/tui.ts` | Claude Code / Codex 风格 TUI：主视图只追加（不进备用屏）、`Ctrl+T` transcript 整屏视图、可见过程说明、工具活动分层折叠、原始参数/结果、成功读图与文件提交后的展示；仍不碰 Agent 循环 | `Tui`（`start`、`assistantDelta`、`recordEditDiff`、`recordImagePreview`、`readLine`、`approve`、`finishTurn`、`close`） |
| `src/tui-image.ts` | 从获准读取的 PNG 真实字节生成有界文字缩略图；其他图像格式验证签名后按实际兼容能力降级；无第三方运行时依赖 | `previewImage` |
| `src/cli.ts` | 组装：命令行参数 / 环境变量 → CLI/REPL/TUI；占位 API Key 拒绝、显式外部演示标记及错误展示；权限与取消入口 | — |
| `src/cli-presenter.ts` | 仅 CLI 展示：阶段、动态台词与日志展开；流式正文与确认回复不一致时显式更正，不改 Transcript | `RunPresenter` |
| `bin/agent.mjs` | 全局命令入口（`npm link` 后的 `agent-kernel`）：按包内绝对路径加载 `.env`，再进 `cli.ts`；不改工作目录 | — |

依赖方向：`cli` → `agent` / `tool-registry` / `workspace` / `permission` / `approval` / `llm` / `errors` / `tui` → `types`。`types` 是叶子；`errors` 只依赖 `types` 的类型（`TokenUsage`），`permission` 复用 `errors` 的 `describeError`，`approval` 只依赖 `permission` 的类型；`tui` 只依赖 `approval` / `permission` / `types`，并只 import `agent` 的统计类型；`agent` 不认识 `workspace`，也不认识 `permission`（权限在 `ToolRegistry` 这一层检查），更不认识 `tui`。

## 测试放哪

九处缝，重构不该让任何用例变红：

- `Agent.run`（用 `test/support/harness.mjs` 里的脚本化 `ChatClient`）：消息顺序、id 配对、两个预算、最后一步、会话生命周期（多 Run、预算按 Run 重算）、取消、token 统计、system 提示动态刷新、`onRequestStart` / `onToolCall` / `onToolResult` 的顺序。
- `ToolRegistry`：Schema 注册校验、权限拒绝折成 `ERROR`，漏传 / `undefined` / 非法 permission 在构造阶段报错，以及每个失败分支都折成文本。
- `Permission`：三档策略、`permissionPrompt` 三档说明、shell 每次询问、无 TTY / 取消信号 / 审批异常默认拒绝。
- `Approval`：`formatApproval` 的多行 / 超长 / 控制字符展示，`askWithSignal` 的正常 / 取消 / EOF 竞态，以及 Linux PTY 下的真实终端行为。
- `Workspace` 的七个方法：路径越界、有界读取、扫描预算、exit code、`edit` 唯一命中、`glob` 模式、`grep` 正则与 `fixed` 模式（含灾难性回溯必须被超时打断）、取消进程树；Windows taskkill 注入错误、非零退出、卡住时有界结束并显式报告未确认。写/改采用临时文件+rename 原子替换，测试取消前提交、权限保留和 grep 链接换向；不保证父目录 TOCTOU 全部消除。
- `Llm.chat`（对着假 HTTP 端点）：合法响应归一化、非法形状必须报错，不能变成「空成功」；usage 与 `max_tokens`；SSE 流式的正文 / tool_calls 拼装与坏 chunk。
- `test/tui.test.mjs` + `test/tui-image.test.mjs`：主视图只追加（历史留在 scrollback）、`Ctrl+T` transcript 视图、折叠层次、真实提交的 Diff、读图缩略图、审批、thinking、颜色、resize、中文宽度、复杂输入与关闭清理；假终端覆盖跨平台，`test/cli-pty.test.mjs` 额外在 Linux PTY 验证真实终端输入、不捕获鼠标与不进备用屏。
- `test/cli.test.mjs`：端到端验证组装 —— 环境变量、退出码、stdout、请求体形状、取消、TUI 布局/命令/统计，且占位 Key 不发请求、SSE 未完成友好提示/去重、HTTP 鉴权分类；循环细节留在单元层。
- `eval/selfcheck.mjs`：初始断言失败、任务无效、基础设施错误必须分开。

写法规范见 [CODING_STANDARDS.md](./CODING_STANDARDS.md) 第 7 节。

## 领域文档

- [GLOSSARY.md](./GLOSSARY.md)：概念、关系、要避开的同义词。
- [docs/adr/](./docs/adr/)：已经定下、别在评审里重新讨论的决定。
- [docs/design/display-layers.md](./docs/design/display-layers.md)：概览层与详情层怎么分，终端与未来前端共用。
- [docs/notes/tui-pitfalls.md](./docs/notes/tui-pitfalls.md)：TUI 踩过的十四个坑 + 四条底层规则，动渲染层前必读。
- [docs/notes/cli-and-tooling.md](./docs/notes/cli-and-tooling.md)：命令行参数、全局安装、测试迁移的九个坑。
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

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
| `npm run agent -- --repl` | 多轮会话：`/exit`、`/reset`、`/permission`、`/help`；需要 `.env` |
| `npm run agent -- --tui [--permission <mode>] ["<task>"]` | Claude Code 风格聊天式 TUI：对话贴顶、带框输入、状态行在下、颜色与字形降级、历史滚动、resize、审批面板；可带一个初始任务；需要 `.env` |
| `npm run eval` | 评测集：20 个真实小任务，记录成功率/请求数/工具调用/token/耗时；需要 `.env`，会花钱 |
| `npm run eval:check` | 评测自检：不调用模型，验证每个任务初始状态确实会断言失败 |
| `npm run eval:cross-day -- --date <YYYY-MM-DD>` | 跨天评测：在固定 commit `eac798d`（tag `stability-2026-11-05-prompt-v2`）上跑 3 轮，按日期归档；需要 `.env` |

## 代码地图

| 文件 | 职责 | 对外接口 |
| --- | --- | --- |
| `src/types.ts` | 协议词汇，不依赖任何人 | `Message`、`Tool`、`ToolDefinition`、`TokenUsage`、`ChatClient` |
| `src/errors.ts` | 错误文案兜底，以及带 usage 的响应协议错误 | `describeError(error)`、`describeValue(value)`、`ChatResponseError` |
| `src/agent.ts` | **Kernel**：循环、消息顺序、请求/工具预算、会话生命周期；system 提示支持函数式动态刷新；展示回调异常隔离并累计诊断 | `Agent.run(task)`、`sessionStats`、`transcript`、`stats`、`observerFailureCount` |
| `src/tool-registry.ts` | 工具查找、Schema 注册校验、参数解析、显式权限注入（`Permission` 或 `null`）、失败折成 `ERROR` | `ToolRegistry.execute(call)`、`definitions` |
| `src/tool-result-status.ts` | 纯展示事实判断：非 Shell 的 `ERROR:` 与 Shell 的 exit / timeout / cancelled；CLI/TUI 复用，不改工具结果文本 | `isToolResultFailure` |
| `src/permission.ts` | 三档权限策略、`permissionPrompt` 模型指导、shell 的一次性审批、审批期间撤权后的版本复验；不是沙箱 | `Permission`、`PermissionMode`、`parsePermissionMode`、`isApproved`、`approvalGate`、`permissionPrompt` |
| `src/approval.ts` | 审批提示格式化与读取：完整命令、实际 cwd、控制字符转义；`AbortSignal` / readline close / 正常回答的竞态收口 | `formatApproval`、`askWithSignal` |
| `src/workspace.ts` | 工作区内的文件与 shell，含真实路径复用、编辑句柄一致性、写入前取消检查及其已知竞态边界；有界读取、扫描预算、超时与取消 | `Workspace.read/write/edit/glob/grep/list/run`、`createWorkspaceTools()` |
| `src/grep-worker.ts` | `grep` 的正则匹配线程：逐行匹配，主线程超时/取消时 terminate；不依赖任何模块 | — |
| `src/llm.ts` | `ChatClient` 的 HTTP 适配器，含 usage、`max_tokens` 与 SSE 流式 | `Llm.chat(messages, tools, options)` |
| `src/tui.ts` | Claude Code 风格 TUI：顶部项目/模型/路径、对话从顶部排列、底部带边框输入、状态行在下、工具状态/审批面板、颜色/字形降级、PageUp/PageDown、resize；不碰 Agent 循环 | `Tui`（`start`、`logError`、`setThinking`、`readLine`、`approve`、`finishTurn`、`close`） |
| `src/cli.ts` | 组装：命令行参数 / 环境变量 → 对象图 → 跑一次、进 REPL 或进 TUI；`--permission`、`/permission`、SIGINT/SIGTERM 取消链的起点 | — |
| `src/cli-presenter.ts` | 仅 CLI 展示：阶段、动态台词与日志展开；不改 Transcript | `RunPresenter` |

依赖方向：`cli` → `agent` / `tool-registry` / `workspace` / `permission` / `approval` / `llm` / `errors` / `tui` → `types`。`types` 是叶子；`errors` 只依赖 `types` 的类型（`TokenUsage`），`permission` 复用 `errors` 的 `describeError`，`approval` 只依赖 `permission` 的类型；`tui` 只依赖 `approval` / `permission` / `types`，并只 import `agent` 的统计类型；`agent` 不认识 `workspace`，也不认识 `permission`（权限在 `ToolRegistry` 这一层检查），更不认识 `tui`。

## 测试放哪

九处缝，重构不该让任何用例变红：

- `Agent.run`（用 `test/support/harness.mjs` 里的脚本化 `ChatClient`）：消息顺序、id 配对、两个预算、最后一步、会话生命周期（多 Run、预算按 Run 重算）、取消、token 统计、system 提示动态刷新、`onRequestStart` / `onToolCall` / `onToolResult` 的顺序。
- `ToolRegistry`：Schema 注册校验、权限拒绝折成 `ERROR`，漏传 / `undefined` / 非法 permission 在构造阶段报错，以及每个失败分支都折成文本。
- `Permission`：三档策略、`permissionPrompt` 三档说明、shell 每次询问、无 TTY / 取消信号 / 审批异常默认拒绝。
- `Approval`：`formatApproval` 的多行 / 超长 / 控制字符展示，`askWithSignal` 的正常 / 取消 / EOF 竞态，以及 Linux PTY 下的真实终端行为。
- `Workspace` 的七个方法：路径越界、有界读取、扫描预算、exit code、`edit` 唯一命中、`glob` 模式、`grep` 正则与 `fixed` 模式（含灾难性回溯必须被超时打断）、取消进程树。
- `Llm.chat`（对着假 HTTP 端点）：合法响应归一化、非法形状必须报错，不能变成「空成功」；usage 与 `max_tokens`；SSE 流式的正文 / tool_calls 拼装与坏 chunk。
- `test/tui.test.mjs`：对话贴顶、输入框/状态行、工具运行/成功/失败/拒绝/未执行、审批面板完整命令与 cwd、y/N、排队输入、thinking、颜色开关、PageUp/PageDown、resize、中文宽度；用假输入/输出流，不需要真终端。
- `test/cli.test.mjs`：端到端只验证组装 —— 环境变量、退出码、stdout、请求体形状、取消、TUI 的聊天布局/命令/统计；循环细节留在单元层。
- `eval/selfcheck.mjs`：初始断言失败、任务无效、基础设施错误必须分开。

写法规范见 [CODING_STANDARDS.md](./CODING_STANDARDS.md) 第 7 节。

## 领域文档

- [GLOSSARY.md](./GLOSSARY.md)：概念、关系、要避开的同义词。
- [docs/adr/](./docs/adr/)：已经定下、别在评审里重新讨论的决定。
- [docs/agents/domain.md](./docs/agents/domain.md)：探索代码前该读什么。

## Agent skills

技能装在 `.agents/skills/`（来自 [mattpocock/skills](https://github.com/mattpocock/skills)，MIT）。DSH 在会话开始时扫描这个目录，改动后新开一个会话才生效。

### Issue tracker

本地 markdown：`.scratch/<feature>/`。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个标准角色，在本地 tracker 里写成工单顶部的 `Status:` 行。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根目录一个 `GLOSSARY.md` 加 `docs/adr/`。见 `docs/agents/domain.md`。

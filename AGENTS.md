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
| `npm run agent -- --repl` | 多轮会话：`/exit`、`/reset`、`/help`；需要 `.env` |
| `npm run eval` | 评测集：20 个真实小任务，记录成功率/请求数/工具调用/token/耗时；需要 `.env`，会花钱 |
| `npm run eval:check` | 评测自检：不调用模型，验证每个任务初始状态确实会断言失败 |
| `node eval/cross-day.mjs --date <YYYY-MM-DD>` | 跨天评测：固定 tag `stability-2026-11-04` 的 worktree 里跑 3 轮，按日期归档；需要 `.env` |

## 代码地图

| 文件 | 职责 | 对外接口 |
| --- | --- | --- |
| `src/types.ts` | 协议词汇，不依赖任何人 | `Message`、`Tool`、`ToolDefinition`、`TokenUsage`、`ChatClient` |
| `src/errors.ts` | 错误文案兜底：任何抛出物都变成一行非空文本 | `describeError(error)` |
| `src/agent.ts` | **Kernel**：循环、消息顺序、请求/工具预算、会话生命周期 | `Agent.run(task)`、`sessionStats`、`transcript`、`stats` |
| `src/tool-registry.ts` | 工具查找、Schema 注册校验、参数解析、失败折成 `ERROR` | `ToolRegistry.execute(call)`、`definitions` |
| `src/workspace.ts` | 工作区内的文件与 shell，含路径守卫、有界读取、扫描预算、超时与取消 | `Workspace.read/write/edit/glob/grep/list/run`、`createWorkspaceTools()` |
| `src/grep-worker.ts` | `grep` 的正则匹配线程：逐行匹配，主线程超时/取消时 terminate；不依赖任何模块 | — |
| `src/llm.ts` | `ChatClient` 的 HTTP 适配器，含 usage 与 `max_tokens` | `Llm.chat(messages, tools)` |
| `src/cli.ts` | 组装：环境变量 → 对象图 → 跑一次或进 REPL；SIGINT/SIGTERM 取消链的起点 | — |

依赖方向：`cli` → `agent` / `tool-registry` / `workspace` / `llm` / `errors` → `types`。`types` 和 `errors` 是叶子，`agent` 不认识 `workspace`。

## 测试放哪

八处缝，重构不该让任何用例变红：

- `Agent.run`（用 `test/support/harness.mjs` 里的脚本化 `ChatClient`）：消息顺序、id 配对、两个预算、最后一步、会话生命周期（多 Run、预算按 Run 重算）、取消、token 统计。
- `ToolRegistry`：Schema 注册校验，以及每个失败分支都折成文本。
- `Workspace` 的七个方法：路径越界、有界读取、扫描预算、exit code、`edit` 唯一命中、`glob` 模式、`grep` 正则与 `fixed` 模式（含灾难性回溯必须被超时打断）、取消进程树。
- `Llm.chat`（对着假 HTTP 端点）：合法响应归一化、非法形状必须报错，不能变成「空成功」；usage 与 `max_tokens`。
- `test/cli.test.mjs`：端到端只验证组装 —— 环境变量、退出码、stdout、请求体形状、取消；循环细节留在单元层。
- `eval/selfcheck.mjs`：初始断言失败、任务无效、基础设施错误必须分开。
- `eval/diagnostics.mjs`：只观察不改行为 —— 请求 usage、工具顺序/参数/结果大小、文件大小与 hash。
- `eval/cross-day.mjs`：按日聚合多轮记录，保留中位数、逐任务波动和失败类型。

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

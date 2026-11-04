# AGENTS.md

agent-Kernel 是一个最小 coding agent：模型说话，内核把工具调用跑掉，把结果发回去。
给人看的介绍在 [README.md](./README.md)，领域词汇在 [GLOSSARY.md](./GLOSSARY.md)。
**规范本体在 [CODING_STANDARDS.md](./CODING_STANDARDS.md)：写或改 `src/`、`test/` 之前先读它**（注释、模块形状、命名、错误处理、测试、提交）。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm test` | 全部测试，不需要 API Key、不联网 |
| `npm run typecheck` | `tsc --noEmit`（strict） |
| `npm run check` | 上面两个一起跑：提交前跑这个 |
| `npm run agent -- "<task>"` | 真跑一次，需要 `.env` |

## 代码地图

| 文件 | 职责 | 对外接口 |
| --- | --- | --- |
| `src/types.ts` | 协议词汇，不依赖任何人 | `Message`、`Tool`、`ToolDefinition`、`ChatClient` |
| `src/agent.ts` | **Kernel**：循环、消息顺序、步数上限 | `Agent.run(task)`、`transcript` |
| `src/tool-registry.ts` | 工具查找、参数解析、失败折成 `ERROR` | `ToolRegistry.execute(call)`、`definitions` |
| `src/workspace.ts` | 沙箱内的文件与 shell，含路径守卫、截断、超时 | `Workspace.read/write/edit/glob/grep/list/run`、`createWorkspaceTools()` |
| `src/llm.ts` | `ChatClient` 的 HTTP 适配器 | `Llm.chat(messages, tools)` |
| `src/cli.ts` | 组装：环境变量 → 对象图 → 跑一次 | — |

依赖方向：`cli` → `agent` / `tool-registry` / `workspace` / `llm` → `types`。`types` 是叶子，`agent` 不认识 `workspace`。

## 测试放哪

四处缝，重构不该让任何用例变红：

- `Agent.run`（用 `test/support/harness.mjs` 里的脚本化 `ChatClient`）：消息顺序、id 配对、步数上限。
- `ToolRegistry.execute`：每个失败分支都折成文本。
- `Workspace` 的七个方法：路径越界、截断、exit code、`edit` 唯一命中、`glob` 模式、`grep` 命中格式。
- `test/cli.test.mjs`：端到端只验证组装 —— 环境变量、退出码、stdout、请求体形状；循环细节留在单元层。

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

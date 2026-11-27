# 行为承诺与回归验证契约

设计注释是“为何如此”，测试证明“是否如此”。不要用注释行数代替验证覆盖率。

| 行为承诺 | 权威来源 | 验证入口 |
| --- | --- | --- |
| CLI 把 Windows CRLF 当作换行处理，孤立 CR 仍安全转义 | src/ui/cli-presenter.ts | test/cli-presenter.test.mjs |
| grep 不从文件末尾的 LF 造出不存在的一行，内部空行保留 | src/tools/grep-worker.ts | test/workspace.test.mjs |
| 字符数截断不切断 UTF-16 代理对 | src/protocol/text-boundaries.ts | test/project-instructions.test.mjs、test/workspace.test.mjs |
| 文件句柄短读不能损坏 BOM 或丢失剩余内容 | fillBuffer + readTextUpToHandle | test/workspace.test.mjs |
| 模型使用本次请求实际提供的工具定义，不信静态提示列举 | ToolRegistry.definitions | test/agent.test.mjs |
| 模型错误显示标题与修复建议不维护两套标题 | modelFailure | test/model-errors.test.mjs |
| TUI 不主动启用鼠标跟踪，但会过滤意外到达的 SGR 鼠标报告 | Tui 输入层 | test/tui.test.mjs + test/cli-pty.test.mjs |
| Shell 前台非零退出 / 超时 / 取消 = isError:true，内容原文不变；后台启动不是失败 | src/tools/workspace.ts | test/tool-registry.test.mjs + test/tool-hooks.test.mjs |

## 修改规则

1. 重要注释凡含“必须”“不得”“始终”“支持”之类行为承诺，优先关联行为测试；纯解释不必强制测试。
2. 注册表、权限、错误文案等同一事实只维护一个权威来源，避免第二份手写列表。
3. 不只测试内部解析；对真实用户入口，额外验证功能是否可达。
4. 重要边界优先安排回归用例（EOF、CRLF、Unicode、短读、空文件、并发、取消）。
5. 本文是契约与测试索引，不代表未经执行的跨平台测试或真人终端验收已通过。

## 大文件结构审查（本次不做大规模拆分）

src/ui/tui.ts 同时负责输入、状态、渲染，src/tools/workspace.ts 同时负责文件 I/O、搜索、后台进程。
行数本身不是缺陷；拆分前必须先明确模块边界、跨模块契约和端到端测试。
本次保留 SGR 输入过滤：即使 TUI 不主动启用鼠标跟踪，PTY 或上游输入仍可能送来 SGR 报告，必须阻止坐标混入任务文本。
主视图不主动接管鼠标滚轮和文本选中；输入安全过滤与鼠标交互功能不是一回事。
后续如需拆分，优先通过稳定的纯函数和独立测试逐步迁移。

## 验证命令

npm run check
npm run eval:check

真实终端另行验收 Windows CLI --details 与主视图原生鼠标滚轮/文本选中；不得用假的输入输出测试冒充实机验证。

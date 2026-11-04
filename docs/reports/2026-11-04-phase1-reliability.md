# 第一阶段可靠性修复报告（2026-11-04）

- 仓库：`wwxst/agent-Kernel`
- 分支：`feat/minimal-agent-loop`
- 审查基准：`b0e9e72`（本分支上的 `b95e297` 只改了 eval，`src/` 与基准一致）
- 修复提交：`757ce88` → `f0522db` → `7ee949b` → `4e7c552` → `ad69f5e`
- 验收基线：commit `4e7c552`，20 个任务，DeepSeek-V4.1-Flash，单轮 20/20
- 当前基线（追加）：commit `9e52e5c`，同一套任务，`hy3`，单轮 20/20
- CI：[run 41792841368](https://github.com/wwxst/agent-Kernel/actions/runs/41792841368)（Linux + Windows 全绿）

## 1. 修复前后架构对比

架构没有变：仍然是 `CLI → Agent + ChatClient + ToolRegistry + Workspace`，一个类、一个循环、七个工具、运行时零依赖。变的是每个模块对自己那件事的**执行边界**：

| 模块 | 修复前 | 修复后 |
| --- | --- | --- |
| `Agent` | 只有 `maxSteps`（模型请求数）；最后一步仍会执行工具；实例可被第二次 `run()` 复用 | 模型请求 / 工具执行 / token 三个预算；最后一步只收尾；单实例单任务；`stats` 暴露请求数、工具数、usage |
| `ChatClient` / `Llm` | 只返回 `Message`，usage 被丢弃；只有超时 signal | 返回 `{ message, usage? }`；请求带 `max_tokens`；外部 abort 与超时合并 |
| `Workspace` | 单次 `read()`；`readdir()` 后截断；grep 跑用户正则；超时杀进程树但不等待 | 循环读到 EOF；`opendir()` 真预算；字面搜索；超时/取消共用清理路径并等待进程树 |
| `ToolRegistry` | 执行期做轻量校验；重名与不支持的 Schema 静默通过 | 注册期拒绝重名、拒绝校验器不懂的类型；执行期严格校验已声明类型 |
| `CLI` | 无信号处理；`API_KEY ?? OPENAI_API_KEY`；不输出成本 | 一个 `AbortController` 贯穿三处；SIGINT/SIGTERM → 退出码 130；trim 后回退；打印成本摘要 |
| 评测 | 只记成功率/步数/耗时；自检把任何异常当「初始状态失败」 | 记模型、Commit SHA、token、请求、工具调用；失败分四类；自检分 ok / BROKEN / INFRA |

不变的部分同样是决定：工具仍串行、错误仍折成 `ERROR` 文本、`shell` 仍不是沙箱（[ADR-0008](../../docs/adr/0008-trusted-local-agent.md)）。

## 2. 11 项问题的处理结果

| # | 问题 | 结果 | 主要文件 |
| --- | --- | --- | --- |
| 1 | 文件读取完整性 | 已修复。循环读到 EOF 或上限；截断必然意味着「读满了 limit+1 字节」；`edit` 遇到截断直接拒绝；UTF-8 截断点不再产生替换字符 | `src/workspace.ts` |
| 2 | 目录扫描资源限制 | 已修复。`opendir()` 逐项迭代，`scanLimit` 是真实读入项数；`list` 排序后截断；预算耗尽时明说结果可能不完整 | `src/workspace.ts` |
| 3 | grep 正则阻塞主线程 | 已修复。改为字面字符串搜索；Schema 参数从 `pattern` 改为 `text`；超长行有显式截断标记 | `src/workspace.ts`、`docs/adr/0009-grep-is-literal.md` |
| 4 | Shell 取消与进程树 | 已修复。CLI → Agent → Llm → Workspace 共用一条 signal；超时与取消共用 `terminateTree`；清理完成后才返回；取消后不再启动工具 | `src/cli.ts`、`src/agent.ts`、`src/llm.ts`、`src/workspace.ts` |
| 5 | 工具调用预算 / 最后一步语义 | 已修复。新增 `maxToolCalls`；整批执行前检查；最后一步要工具时不执行；所有停止路径都补齐 `not run` 工具结果，配对不断 | `src/agent.ts`、`src/cli.ts` |
| 6 | Agent 生命周期 | 已修复。第二次 `run()`（含并发、失败后、取消后）抛 `single-use` 生命周期错误 | `src/agent.ts` |
| 7 | Token 统计与预算 | 已修复。usage 经 `ChatResponse` 保留并校验；累计 prompt/completion/total；`max_tokens`；任务 token 预算；缺 usage 单独计 `unknown`，统计与错误文案只声称下限 | `src/types.ts`、`src/llm.ts`、`src/agent.ts`、`src/cli.ts` |
| 8 | 评测自检误判 | 已修复。只有 `AssertionError` 算预期失败；加载失败 / 非断言异常判 `INFRA`；四个检查器把「文件不存在 / 代码抛错」改成断言失败 | `eval/selfcheck.mjs`、`eval/tasks/04,06,16,17` |
| 9 | 系统提示词 | 已修复。关键歧义允许询问；禁止编造验证结果；无法验证要明说 | `src/agent.ts` |
| 10 | 工具 Schema 边界 | 已修复。注册期拒绝重复名、非法 `parameters`、未声明类型、不支持的 `array/object`、未声明的 `required`；`number` 拒绝 `NaN/Infinity` | `src/tool-registry.ts` |
| 11 | CI / 评测基线 / 配置 | 已修复。CI 跑 `eval:check`；记录模型/SHA/token/请求/工具/耗时并分类失败；API Key 先 trim 再回退；重新跑完 20 个任务并保存基线 | `.github/workflows/ci.yml`、`eval/run.mjs`、`eval/summary.mjs`、`eval/baseline.md`、`src/cli.ts` |

## 3. 关键实现方案及原因

### 3.1 完整读取：循环 + EOF 判定，而不是「多读一点」

`fillBuffer()` 每次从上次停下的位置续读，直到读满 `limit + 1` 字节或 `read` 返回 0。这样「没截断」在结构上等价于「读到了 EOF」，`edit` 就不可能拿半截内容覆盖文件。`fillBuffer` 单独导出是为了能用假句柄确定性地模拟「一次只返回几个字节」——普通磁盘文件几乎不会触发半截读，而这正是这段循环存在的理由。截断点落在多字节字符中间时用 `TextDecoder` 的 `stream` 模式丢掉残片，不制造 `U+FFFD`。

### 3.2 目录扫描：`opendir` + 先排序再截断 + 诚实的尾注

`readdir` 在预算生效之前就已经把整层目录读进内存，所谓上限只是「读完之后切多少」。`opendir` 让预算落在真正读入的目录项上。`list` 收集到预算上限后排序、再取前 500 条；扫描提前停止时同时报告「还有多少条没列」和「results may be incomplete」，不声称拿到了全局结果。符号链接仍不跟随（`isFile()`/`isDirectory()` 对链接为 false）。

### 3.3 字面 grep：用能力换确定性

正则由模型提供、匹配跑在主线程，一条灾难性回溯就能挂住整个进程。第一阶段直接改成字面搜索，从结构上消除这类输入；工具描述与参数名都写明「不是正则」。恢复正则的前提是 worker + 可中断超时，已记入 ADR-0009。同时给超长行加 `…[line truncated]`，避免模型把 200 字当成整行。

### 3.4 取消链：一个 signal，不建管理器

CLI 收到 SIGINT/SIGTERM 只做一件事：`abort` 同一个 `AbortController`。Agent 在每次请求和每次工具调用前检查；Llm 用 `AbortSignal.any([timeout, signal])` 合并超时与取消；Workspace 在 `run` 里监听同一个 signal。超时与取消走同一个 `stop()` → `terminateTree()`，**第一次停止原因获胜**；`terminateTree` 返回 Promise，`close` 后要等它完成才 resolve，避免「调用方以为停了、孙进程还在写文件」。POSIX 杀进程组，Windows 用 `taskkill /T /F`，失败时回落到 `child.kill()`。

### 3.5 预算与最后一步：先算账，再动手

工具预算按「真正执行的次数」算，和模型请求数分开。每批工具在执行**之前**整批检查：会超限就一个都不跑，避免「跑了一半才发现」。第 `maxSteps` 次请求只用于收尾：模型仍要工具时，这些调用不执行——执行了也没有下一次请求去验证结果，只是制造无法确认的副作用。所有「没跑」的调用都写入 `ERROR: not run: <原因>` 的 tool 消息，保证 assistant/tool 配对完整，失败报告里也带上「已经执行了多少」。

### 3.6 Usage 与预算：未知就是未知

`usage` 不挂在 `Message` 上（那会被原样发回 API），而是作为 `ChatResponse` 的一部分返回。缺失 usage 记 `unknown`，不补 0；此时 CLI 写 `at least N tokens`，预算错误也会说明「真实总量更高」。字段存在但类型不对是端点违反协议，直接报错而不是悄悄当成未知。token 预算只在**已知**合计达到上限时触发，配合 `maxSteps` 兜住「端点一直不给 usage」的极端情况。

### 3.7 生命周期与 Schema：把错误提前到装配期

Agent 只有一个 `started` 布尔量，第一次 `run()` 同步置位，因此并发调用的第二个也会立刻失败。ToolRegistry 在构造时校验 Schema 形状与重名：一个声明 `array` 参数的工具会「看起来被校验过、其实完全没查」，这比不支持更危险，宁可在装配阶段报错。

## 4. 新增和修改的测试

`npm test`：124 个用例（Windows 上 122 通过 + 2 条平台用例跳过；Linux 全跑）。新增/扩展的覆盖：

| 类别 | 用例 |
| --- | --- |
| 读取完整性 | `fillBuffer` 半截读与 EOF；正好等于上限不截断；多字节字符截断不产生 `U+FFFD`；2 MB+ 的 `edit` 拒绝且原文件逐字节不变；接近上限的文件改完后尾部仍在 |
| 目录扫描 | 505 个条目排序后截断并给出剩余数；扫描预算耗尽时明确报告不完整；工作区内的符号链接目录不会带出边界 |
| grep | 正则元字符按字面处理；`([` 不再抛错；空搜索文本拒绝；超长行截断标记 |
| 取消 | `run` 取消后孙进程不再写文件且等待清理；已取消时不再启动进程；Agent 预取消不发请求；中途取消剩余调用补 `not run`；Llm 取消立刻中断 HTTP；POSIX 上 CLI SIGINT 退出码 130 |
| 预算 / 最后一步 | 整批预检查不执行；跨批次累计；最后一步不执行无法验证的工具；步数错误报告已执行数 |
| 生命周期 | 第二次调用、并发调用、失败后调用都抛错且不污染 transcript |
| Token / usage | 累计三项 token；缺失 usage 计 unknown；预算达到后停手；unknown 时只声称下限；`max_tokens` 随请求发出；usage 字段类型错误报错 |
| Schema | 重名、非 object schema、array/object 参数、未声明 required、缺类型；`Infinity` 与非布尔值 |
| 评测自检 | 断言失败 = ok；初始通过 = BROKEN；TypeError / 依赖缺失 / 加载失败 = INFRA；无默认导出 = BROKEN |
| 端到端 | `max_tokens`、usage 摘要、空白 API_KEY 回退、仅空白时按缺失处理 |

## 5. CI 结果

| 平台 | 结果 | 链接 |
| --- | --- | --- |
| Linux (ubuntu-latest) | ✅ Typecheck and Tests + Self-check the evaluation set | [job](https://github.com/wwxst/agent-Kernel/actions/runs/41792841368/job/126449975673) |
| Windows (windows-latest) | ✅ Typecheck and Tests + Self-check the evaluation set | [job](https://github.com/wwxst/agent-Kernel/actions/runs/41792841368/job/126449975433) |

CI 现在除了 `npm run check`，还会跑 `npm run eval:check`（不调用模型）：任务初始状态如果直接通过，构建就会失败。

## 6. 真实 Coding 任务成功率

**20/20 通过（100%）**。单轮，4 并发，DeepSeek-V4.1-Flash（`deepseek-flash`），commit `4e7c552`。

逐任务表、复现步骤和口径见 [`eval/baseline.md`](../../eval/baseline.md)，原始记录在 [`eval/baselines/2026-11-04-deepseek-flash.json`](../../eval/baselines/2026-11-04-deepseek-flash.json)。

切换模型后（2026-11-04，`hy3`，同一套 20 个任务，commit `9e52e5c`）又跑了一轮：**20/20**，95 次请求、93 次工具调用、133,091 tokens、墙钟 82.7s。记录在 [`eval/baselines/2026-11-04-hy3.json`](../../eval/baselines/2026-11-04-hy3.json)。

> 单轮 20/20 说明「当前版本能做完这套任务」，不证明稳定性。旧版本在同一天的 3 轮基线是 19/20、20/20、20/20，其中唯一失败是检查器写错；本轮修复后检查器也做了分类改造，因此两边的分数不能直接当作「提升」来读。两个模型各跑一轮都满分，但这不是跨模型的能力比较。

## 7. Token、请求次数、工具调用次数和耗时

| 指标 | 数值 |
| --- | --- |
| 模型请求次数 | 178（平均 8.9 / 任务） |
| 工具调用次数 | 200（平均 10.0 / 任务） |
| Prompt tokens | 362,129 |
| Completion tokens | 26,945 |
| Total tokens | 389,074 |
| 缺失 usage 的响应 | 0（因此合计是精确值） |
| 墙钟 | 66.5s（4 并发） |
| 任务耗时合计 | 250.2s（平均 12.5s / 任务） |

最重的任务是 `13-callback-to-promise`（17 请求 / 19 工具 / 45,504 tokens / 25.3s）；最轻的是 `04-create-doc`（4 请求 / 7 工具 / 6,280 tokens / 5.1s）。

换到 `hy3` 后（同上 20 个任务、4 并发、commit `9e52e5c`）：95 次请求（4.8 / 任务）、93 次工具调用（4.7 / 任务）、prompt 124,652 + completion 8,439 = 133,091 tokens、墙钟 82.7s（任务耗时合计 249.9s）。请求数和 token 约为 deepseek-flash 的三分之一，但单次模型往返更慢，4 并发下的墙钟反而更长（82.7s vs 66.5s）。

## 8. 尚未解决的问题及其风险

1. **字面 grep 丢掉了正则能力。** 模型搜 `a.*b` 会当字面量。风险是搜索效率下降，而不是正确性；要用回正则必须上 worker + 可中断超时。
2. **token 预算只覆盖端点报告了 usage 的部分。** 端点完全不给 usage 时，预算不会触发（`maxSteps` 仍兜底），统计只显示下限。风险是「以为有预算，其实只限制了请求次数」。
3. **Windows 上的「用户 Ctrl-C」没有自动化端到端用例。** Node 不能向另一个进程投递 SIGINT，所以 CLI 的 SIGINT 用例只在 POSIX 跑；Windows 的取消逻辑通过 Workspace 单元测试（直接 abort）覆盖，真实控制台里的 Ctrl-C 需要人工确认。
4. **Windows 进程树清理依赖 `taskkill`。** 它不可用时只能回落到 `child.kill()`，会留下孙进程；这是已有兜底行为，不是完整保证。
5. **单轮评测不足以证明稳定性。** 20/20 是当前版本的快照；模型输出有波动，需要用多轮中位数看趋势。
6. **`list` 在排序前最多保留 `scanLimit`（默认 20 000）个条目。** 内存有界，但超大目录仍会读 20 000 项才停；这是「真实上限」的代价，不是泄漏。
7. **成本只有 usage 统计，没有 tokenizer 级估算。** 端点不返回 usage 时无法给出精确成本；没有上下文压缩，长任务会稳定撞到 `MAX_TOTAL_TOKENS`。
8. **兼容性变化：** `ChatClient.chat` 返回 `ChatResponse`、Agent 单次使用、grep 参数改名 `text`。仓库内调用方都已同步；外部库使用者需要迁移。

## 9. 下一阶段最值得做的三项工作

1. **多轮评测与趋势看板（不改内核）。** 给 `eval/run.mjs` 加 `--repeat N`，按任务记录跨轮通过率和 token 方差；把 `eval:summary` 的中位数作为版本对比口径。当前最大的不确定性不是代码，而是「一次 20/20 能代表多少」。
2. **在 worker 里恢复正则 grep，并带可中断超时。** 需求真实（模型习惯传模式），但必须保留「不会被输入卡死」这条不变量；这是 ADR-0009 预留的升级路径。
3. **请求级上下文预算（先明确失败，不做静默压缩）。** 记录每次请求的 prompt tokens，超过阈值就明确中止并报告，而不是继续把 transcript 撑大；等评测证明这确实是瓶颈，再讨论裁剪或摘要。上下文压缩、Session、Subagent 等仍不在本阶段范围内。

## 10. 验收对照

- 原有测试全部通过：是（语义变更的用例已同步更新）
- 新增边界测试全部通过：是
- Linux / Windows CI 通过：是（run 41792841368）
- 文件读取无静默不完整：是（循环 + EOF 判定；`edit` 拒绝截断）
- `edit` 不会覆盖丢内容的原文件：是（超大文件拒绝且原文件字节不变有测试）
- 目录扫描有真实上限：是（`opendir` 预算）
- grep 不会被恶意正则阻塞：是（字面搜索）
- Shell 取消清理整个进程树：是（超时/取消共用路径，等清理完成）
- 工具执行量受限：是（`maxToolCalls` + 整批预检查）
- Agent 生命周期约束有效：是（单次使用）
- Token 成本可统计：是（`Agent.stats`、CLI 摘要、评测记录）
- 自检能区分断言失败与基础设施错误：是（ok / BROKEN / INFRA）
- 非法工具 Schema 被拒绝：是（注册期校验）
- 完整任务重新评测并保存：是（20/20，`eval/baseline.md`）

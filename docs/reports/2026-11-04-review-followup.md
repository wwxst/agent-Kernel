# 第二轮复核跟进报告（2026-11-04）

- 分支：`feat/minimal-agent-loop`
- 本轮 HEAD：`e86cde4`（代码修复 `7829faf` + 评测任务修正 `e86cde4`）
- 范围：只处理复核提出的前三项 + 记录第四项；不引入新架构、不进入下一阶段功能
- 多轮基线：[`eval/baseline.md`](../../eval/baseline.md)
- CI：`7829faf` [run 41795501081](https://github.com/wwxst/agent-Kernel/actions/runs/41795501081)、`e86cde4` [run 41795793064](https://github.com/wwxst/agent-Kernel/actions/runs/41795793064)（Linux + Windows 全绿）

## 1. 四项处理结果

| 优先级 | 问题 | 结果 | 文件 |
| --- | --- | --- | --- |
| P1 | `finish_reason` 与 `tool_calls` 不一致 | 已修复：三种矛盾响应一律拒绝 | `src/llm.ts`、`test/llm.test.mjs` |
| P2 | Token 预算语义不清 | 已明确为软预算；失败请求计入 unknown；`stats.tokenBudget` 可识别 | `src/agent.ts`、`src/errors.ts`、`src/cli.ts`、测试 |
| P2 | 评测未处理 rejection 只记日志 | 已修复：轮级基础设施失败，`ok=false`、退出码 1 | `eval/run.mjs`、`test/eval.test.mjs`、夹具 |
| P2 | `glob` / `grep` 截断后受遍历顺序影响 | 按建议**记录**，不改行为 | `README.md`、`eval/baseline.md` |

### 1.1 响应协议一致性

`readMessage` 现在把 `finish_reason` 和 `tool_calls` 放在一起判断：

- `stop` + 非空 `tool_calls` → 拒绝（端点说结束了，却给了要执行的工具）；
- `tool_calls` + 空/缺失 `tool_calls` → 拒绝（端点声称调用了工具，Agent 却会当成最终答复）；
- 同一批 `tool_calls` 出现重复 `id` → 拒绝（结果无法唯一配对）；
- `stop` + 空数组按「没有工具调用」处理并归一化，不写进 Message。

先确认了 `hy3` 在真正调用工具时返回 `finish_reason: "tool_calls"`，所以严格校验不会误杀当前模型。协议细节记在 `readMessage` 的注释里：两种矛盾都会让 Agent「猜一个」继续跑，而猜错的方向正好相反。

### 1.2 Token 预算语义

明确为**软预算 / 请求准入**，不是硬性总量上限：

- 达到上限后不再发新请求、不再执行没有后续请求验证的工具；
- 把预算顶穿的那条回复已经产生费用，Agent 如实记录；
- 如果它就是最终答复，Run 可以成功返回，但 `stats.tokenBudget.exceeded` 为 true，CLI 也会打印 `budget exceeded (limit=…)`；
- 调用方要硬上限，应该在成功返回后自己检查这个标志。

另外补了两个记账缺口：

1. **失败请求不再丢账。** 请求抛错时，能拿到 usage 就精确记账，拿不到就 `unknown++`；`stats.requests === reported + unknown` 成为可验证的不变量（测试覆盖）。
2. **响应形状非法时 usage 不再被丢。** `Llm.chat` 先解析 usage 再校验 message；校验失败时抛 `ChatResponseError`，把已返回的 usage 一起带出来，Agent 收到后照样记账。

### 1.3 评测的未处理 rejection

`eval/run.mjs` 拆成 `runRound` / `summarize` / `report`：

- `runRound` 在一轮开始时挂上 `unhandledRejection` 监听，任务跑完后留 20ms 结算窗口；
- 窗口内冒出的 rejection 记入 `infraErrors`，`summarize` 把整轮 `ok` 置为 false（即使所有任务 PASS）；
- `report` 单独打印「评测基础设施错误」，退出码 1；
- 更晚才炸的 rejection 会走 Node 默认非零退出，同样不会静默通过。

测试用子进程跑完整一轮（`test/support/eval-floating-check.mjs`），避免 `node:test` 自己的 unhandledRejection 监视抢先失败；同时有「没有 rejection 时整轮通过」的对照用例。

### 1.4 第四项：结果确定性

按建议只记录、不改行为。`glob` / `grep` 达到 200 条上限时，返回的是遍历顺序里先遇到的那 200 条；排序只保证这 200 条内部有序，不保证是全局 Top N。要稳定 Top N 就得扫完整棵树，会牺牲扫描预算。已写进 README 的已知边界，后续需要时再优化。

## 2. 多轮真实评测

**配置**：`hy3`，commit `e86cde4`，20 个任务，4 并发，连续 3 轮。原始记录（三轮合并）在 [`eval/baselines/2026-11-04-hy3-3rounds.json`](../../eval/baselines/2026-11-04-hy3-3rounds.json)。

| 指标 | 第 1 轮 | 第 2 轮 | 第 3 轮 | 中位数 |
| --- | ---: | ---: | ---: | ---: |
| 通过 | 20/20 | 20/20 | 20/20 | **20/20** |
| 模型请求 | 103 | 100 | 92 | **100** |
| 工具调用 | 99 | 99 | 87 | **99** |
| prompt tokens | 132,588 | 127,436 | 110,469 | **127,436** |
| completion tokens | 8,953 | 9,103 | 7,623 | **8,953** |
| total tokens | 141,541 | 136,539 | 118,092 | **136,539** |
| 墙钟 | 82.6s | 75.4s | 74.8s | **75.4s** |

对应复核里要观察的五点：

1. **每轮成功率**：3/3 轮都是 20/20，没有跨轮失败的任务。
2. **每个任务的 Token 波动**：多数任务稳定在 1.0–1.4×；四个任务波动明显——`13-callback-to-promise` 5.27×（同一件事有时 4 次请求、有时 14 次）、`11-fix-slice-boundary` 3.72×、`20-fix-email-regex` 1.80×、`07-add-quiet-flag` 1.79×。逐任务表见 `eval/baseline.md`。
3. **平均模型请求次数**：每轮 103 / 100 / 92，中位数 100，即每任务 5.0 次。
4. **是否有任务反复失败**：没有反复失败。多轮第一次尝试时 `20-fix-email-regex` 失败过一次，但复盘发现是 **task.md 没写 `+tag` 要求、检查器却要求**——评测缺陷，不是 agent 的问题；补全 prompt 后 3/3 通过。
5. **Token 是否随任务复杂度增长**：重任务（`13`、`20`、`10`、`07`）确实更贵；但主要方差来自**同一任务的重试次数**，不是任务规模。`13` 的三轮 token 差距 5.27×，请求数从 4 到 14，说明「模型这一次绕了多少路」才是成本主因。

**输入 token 占比**：中位数 127,436 / 136,539 = **93.3%**，与复核观察一致。成本主要来自反复发送完整 transcript，而不是模型输出。这一阶段仍然不做上下文压缩：先积累跨天、更多轮的数据，再决定是否值得做。

## 3. 测试与 CI

- 测试：134 个用例（Windows 132 通过 + 2 条平台用例跳过；Linux 全跑），`npm run eval:check` 20/20。
- 新增针对性用例：
  - `stop + tool_calls`、`tool_calls + 空数组`、重复 id、`stop + []` 归一化；
  - 形状错误时 usage 随错误带出；
  - 失败请求的 usage 记账与 unknown 计数；
  - 软预算成功返回 + `tokenBudget.exceeded`；
  - 评测轮次的未处理 rejection（含对照）。
- CI：Linux + Windows 均通过，包含 `npm run eval:check`。

## 4. 尚未解决的问题

1. **结果确定性（第 4 项）**：`glob` / `grep` 的 Top N 仍受遍历顺序影响；已明确提示不完整，暂不优化。
2. **token 预算仍是软上限**：`tokenBudget.exceeded` 可识别，但不阻止最后一条回复顶穿；端点不报 usage 时预算无法覆盖那部分成本。
3. **样本量仍小**：3 轮、单模型、单机、同一天。20/20 不能外推成长期稳定性。
4. **Windows 真实 Ctrl-C 仍无自动化用例**：Node 不能向子进程投递 SIGINT；Workspace 的取消逻辑由单元测试直接 abort 覆盖。
5. **任务级方差很大**：`13` 这类任务 5 倍波动说明优化需要看中位数和分布，不能看单轮。

## 5. 下一阶段建议（仍不扩大范围）

1. 用现在的评测器再跑跨天/更多轮（5 轮起），观察 `13`、`11`、`20` 的方差是否收敛。
2. 在 worker 里恢复可中断的正则 grep（ADR-0009 预留路径），保留「不会被输入卡死」的不变量。
3. 请求级 prompt-token 预算：先记录每次请求的 prompt tokens，超阈值明确失败；等数据证明上下文是瓶颈，再讨论裁剪。

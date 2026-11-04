# 评测基线

这里记录「某一版内核 + 某一个模型」在 20 个任务上的成功率与成本。对比时看**同模型、同任务**的趋势；跨模型的数字反映的是模型本身的单价和往返速度，不是内核变强或变弱。

## 当前基线：2026-11-04，hy3

- **模型**：`hy3`（本地 OpenAI 兼容端点，`MODEL=hy3`）
- **Commit**：`9e52e5c`（第一阶段可靠性修复之后的内核）
- **命令**：`npm run eval`（20 个任务，4 并发，单轮）
- **原始记录**：[`baselines/2026-11-04-hy3.json`](./baselines/2026-11-04-hy3.json)

**20/20 通过** · 95 次模型请求 · 93 次工具调用 · **133,091 tokens**（prompt 124,652 + completion 8,439）· 墙钟 **82.7s**（任务耗时合计 249.9s）

| 任务 | 请求 | 工具调用 | 耗时 | tokens |
| --- | ---: | ---: | ---: | ---: |
| 01-add-health-route | 3 | 2 | 8.2s | 3,663 |
| 02-fix-failing-test | 4 | 4 | 10.6s | 5,183 |
| 03-rename-function | 5 | 8 | 13.2s | 6,760 |
| 04-create-doc | 3 | 4 | 7.6s | 3,699 |
| 05-extract-constant | 3 | 2 | 13.6s | 3,937 |
| 06-guard-missing-file | 4 | 3 | 9.2s | 4,700 |
| 07-add-quiet-flag | 3 | 2 | 7.6s | 3,569 |
| 08-extract-duplication | 4 | 4 | 11.0s | 5,072 |
| 09-update-readme | 3 | 3 | 7.0s | 3,572 |
| 10-delete-dead-code | 6 | 8 | 16.2s | 8,153 |
| 11-fix-slice-boundary | 5 | 4 | 18.8s | 6,304 |
| 12-add-input-validation | 4 | 3 | 10.0s | 4,593 |
| 13-callback-to-promise | 13 | 17 | 33.9s | 23,657 |
| 14-fix-sort-order | 4 | 3 | 7.8s | 4,494 |
| 15-merge-defaults | 4 | 3 | 7.7s | 4,565 |
| 16-handle-bad-json | 4 | 3 | 8.2s | 4,641 |
| 17-write-missing-test | 4 | 4 | 9.1s | 5,068 |
| 18-remove-debug-logs | 3 | 2 | 5.6s | 3,358 |
| 19-banned-admin-bug | 4 | 3 | 10.2s | 5,052 |
| 20-fix-email-regex | 12 | 11 | 34.4s | 23,051 |
| **合计** | **95** | **93** | **249.9s** | **133,091** |

## 历史基线：2026-11-04，deepseek-flash

第一阶段验收时用的是 DeepSeek-V4.1-Flash（commit `4e7c552`，单轮、4 并发）：

**20/20 通过** · 178 次模型请求 · 200 次工具调用 · **389,074 tokens**（prompt 362,129 + completion 26,945）· 墙钟 **66.5s**（任务耗时合计 250.2s）

| 任务 | 请求 | 工具调用 | 耗时 | tokens |
| --- | ---: | ---: | ---: | ---: |
| 01-add-health-route | 9 | 9 | 10.9s | 17,185 |
| 02-fix-failing-test | 6 | 7 | 8.6s | 11,294 |
| 03-rename-function | 15 | 25 | 20.5s | 38,693 |
| 04-create-doc | 4 | 7 | 5.1s | 6,280 |
| 05-extract-constant | 7 | 6 | 8.1s | 11,221 |
| 06-guard-missing-file | 16 | 16 | 19.9s | 43,970 |
| 07-add-quiet-flag | 6 | 8 | 8.5s | 9,428 |
| 08-extract-duplication | 11 | 13 | 21.2s | 34,204 |
| 09-update-readme | 5 | 5 | 7.5s | 8,270 |
| 10-delete-dead-code | 7 | 10 | 8.9s | 12,450 |
| 11-fix-slice-boundary | 10 | 10 | 13.3s | 21,764 |
| 12-add-input-validation | 5 | 6 | 6.5s | 7,699 |
| 13-callback-to-promise | 17 | 19 | 25.3s | 45,504 |
| 14-fix-sort-order | 7 | 7 | 11.6s | 11,767 |
| 15-merge-defaults | 10 | 9 | 13.0s | 18,719 |
| 16-handle-bad-json | 9 | 8 | 9.9s | 15,146 |
| 17-write-missing-test | 4 | 4 | 5.8s | 6,314 |
| 18-remove-debug-logs | 13 | 13 | 15.9s | 27,476 |
| 19-banned-admin-bug | 10 | 11 | 16.3s | 25,921 |
| 20-fix-email-regex | 7 | 7 | 13.4s | 15,769 |
| **合计** | **178** | **200** | **250.2s** | **389,074** |

原始记录：[`baselines/2026-11-04-deepseek-flash.json`](./baselines/2026-11-04-deepseek-flash.json)。

两个模型都 20/20，但成本结构不同：`hy3` 的请求和 token 约为 `deepseek-flash` 的三分之一，单次往返更慢，所以 4 并发下的墙钟反而更长（82.7s vs 66.5s）。这说明「省 token」和「省时间」不是同一个优化。

## 怎么复现

1. `.env` 里填 `BASE_URL`、`API_KEY`、`MODEL`（当前基线是 `hy3`）。
2. `npm run eval:check`：不需要 Key，确认 20 个任务的初始状态都会**断言失败**。
3. `npm run eval`：跑一轮；控制台打印表格，同时写 `eval/results/<时间戳>.json`。
4. `npm run eval:summary`：汇总最近几轮完整评测的中位数。

## 口径

- **一次请求** = 一次 `llm.chat()` 调用；**一次工具调用** = 真正执行的工具。被预算或取消拦下、只写了 `ERROR: not run` 的调用不计入。
- token 全部来自端点返回的 `usage`。两轮基线都没有缺失 usage，所以合计是精确值；如果有缺失，汇总会写 `at least` 并单列未知数量。
- 墙钟是 4 并发下的实际耗时；「任务耗时合计」是每个任务耗时相加，两者不能直接比较。
- 单轮 20/20 说明「当前版本能做完这套任务」，**不证明稳定性**。要比较版本，跑多轮看中位数和失败任务的分布。

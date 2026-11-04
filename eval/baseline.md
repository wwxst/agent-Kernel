# 评测基线：2026-11-04

- **模型**：`deepseek-flash`（DeepSeek-V4.1-Flash）
- **Commit**：`4e7c552`（第一批到第四批可靠性修复之后的内核）
- **命令**：`npm run eval`（20 个任务，4 并发，单轮）
- **原始记录**：[`baselines/2026-11-04-deepseek-flash.json`](./baselines/2026-11-04-deepseek-flash.json)

## 结果

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

## 怎么复现

1. `.env` 里填 `BASE_URL`、`API_KEY`、`MODEL=deepseek-flash`（或任何 OpenAI 兼容端点）。
2. `npm run eval:check`：不需要 Key，确认 20 个任务的初始状态都会**断言失败**。
3. `npm run eval`：跑一轮；控制台打印表格，同时写 `eval/results/<时间戳>.json`。
4. `npm run eval:summary`：汇总最近几轮完整评测的中位数。

## 口径

- **一次请求** = 一次 `llm.chat()` 调用；**一次工具调用** = 真正执行的工具。被预算或取消拦下、只写了 `ERROR: not run` 的调用不计入。
- token 全部来自端点返回的 `usage`。本轮 20 个任务都没有缺失 usage，所以合计是精确值；如果有缺失，汇总会写 `at least` 并单列未知数量。
- 墙钟是 4 并发下的实际耗时；「任务耗时合计」是每个任务耗时相加，两者不能直接比较。
- 单轮 20/20 说明「当前版本能做完这套任务」，**不证明稳定性**。要比较版本，跑多轮看中位数和失败任务的分布。

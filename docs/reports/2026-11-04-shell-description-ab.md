# Shell 描述三臂实验（2026-11-04）

- 目的：在一个 commit 上比较「原始」「简单命令提示词（B）」「平台感知 shell 描述（C）」三条路径，判断哪一条能减少无价值的执行步骤，同时不损失成功率。
- 依据：[`2026-11-04-high-variance-diagnosis.md`](./2026-11-04-high-variance-diagnosis.md)（§3.1 证据口径、§7 候选 B、§9 候选 C）。
- 状态：**进行中**；结果见文末，未通过门槛的变体不采纳。

## 1. 三臂定义

三臂使用**同一个 commit、同一套任务、同一份内核源码**，每臂只改一个变量：

| 实验组 | 系统提示词 | shell 工具描述 |
| --- | --- | --- |
| Base | 默认（`DEFAULT_SYSTEM_PROMPT`） | 默认（`DEFAULT_SHELL_DESCRIPTION`） |
| B | 默认 + `Run one shell command per call with simple syntax; do not use \| to sequence commands or alternate quoting.` | 默认 |
| C | 默认 | `Run a shell command in the workspace root; uses cmd.exe on Windows and /bin/sh elsewhere; returns exit code plus stdout/stderr.` |

这意味着 C **不修改** `src/workspace.ts` 的默认值：评测层通过 `--shell-description-file` 传入覆盖文案，三组跑的是同一份内核源码；只有 C 的收益被证实后，才单独提交对默认值或 CLI 的正式修改。

变体文件：

- `eval/prompts/simple-shell.txt`（B 的完整系统提示词，= 默认提示词 + 1 行）
- `eval/prompts/shell-platform.txt`（C 的 shell 描述，单行）

## 2. 固定条件

- 模型：`hy3`（本地 OpenAI 兼容端点）
- 任务：重点任务 `13-callback-to-promise`、`20-fix-email-regex`、`08-extract-duplication`
- 配置：`maxSteps=30`、每任务 `maxTotalTokens=200000`、`--jobs 3`、每轮开启 `--diagnostics`
- 轮次：每臂先在重点任务上跑 5 轮（15 次任务运行），再跑一次完整 20 任务
- 失败分类沿用 `eval/run.mjs`：`task` / `check` / `infra` / `environment`

## 3. 命令

```bash
# 重点任务，5 轮
node --env-file-if-exists=.env eval/run.mjs 13 20 08 --jobs 3 \
  --diagnostics eval/baselines/<date>-shell-ab/<arm>/round-01

# 完整 20 任务，1 轮
node --env-file-if-exists=.env eval/run.mjs --jobs 4 \
  --diagnostics eval/baselines/<date>-shell-ab/<arm>/full
```

B 追加 `--system-prompt-file eval/prompts/simple-shell.txt`；C 追加 `--shell-description-file eval/prompts/shell-platform.txt`；Base 不加。

## 4. 指标

1. **成功率（硬约束）**：重点任务必须 15/15，完整任务必须 20/20；任何失败都不直接采纳，需记录失败类别与原因。
2. **请求数**：每轮三任务合计的中位 / 最小–最大；完整轮另行记录。
3. **tokens**：prompt / completion / total 的中位与最差轮。
4. **shell 失败次数**：从 `--diagnostics` 的 `tools` 里统计 `resultHead` 以 `exit <非零>` 开头的调用。
5. **最差表现**：单轮最大请求、最大 tokens、最大耗时，避免只看均值。
6. **描述本身的成本**：C 的描述比默认长，需在 tokens 里体现（每个请求都会重发 tool schema）。

## 5. 判定

- 先过成功率门槛，再比较成本；成功率不达标直接否决。
- 只在 B 与 C 之间选一个更优者进入下一轮，不直接叠加两项改动。
- 5 轮 × 3 任务 + 完整 20 任务各 1 轮仍是小样本；结论要写明样本量与不可外推的部分。

## 6. 结果

（跑完后填写：逐臂汇总表、失败明细、结论与建议。）

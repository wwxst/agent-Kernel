# Shell 描述三臂实验（2026-11-04）

- 目的：在一个 commit 上比较「原始」「简单命令提示词（B）」「平台感知 shell 描述（C）」三条路径，判断哪一条能减少无价值的执行步骤，同时不损失成功率。
- 依据：[`2026-11-04-high-variance-diagnosis.md`](./2026-11-04-high-variance-diagnosis.md)（§3.1 证据口径、§7 候选 B、§9 候选 C）。
- 状态：**已完成**（2026-11-04）；结果与结论见 §6。

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

- 运行：2026-11-04 21:02–21:31（本地时间）
- 代码：`e32b766`（三臂同一 commit；C 的描述通过评测层覆盖传入，未改 `src/workspace.ts` 默认值）
- 样本：每臂 5 轮重点任务（15 次运行）+ 1 轮完整 20 任务（20 次运行），共 **105 次任务运行**
- 门禁：**105/105 通过**（`0 task` / `0 check` / `0 infra` / `0 environment`，usage 未知数 0）

### 6.1 重点任务（5 轮 × 3 任务）

| 臂 | 通过 | 请求 中位 / 范围 | tokens 中位 / 范围 | 最差轮 tokens | shell 失败 / 调用 |
| --- | --- | --- | --- | --- | --- |
| Base | 15/15 | 26 / 22–37 | 48,096 / 35,346–81,167 | 81,167 | 44 / 74 |
| B | 15/15 | 21 / 19–31 | 36,498 / 29,379–61,706 | **61,706** | 32 / 60 |
| C | 15/15 | 21 / 17–37 | 36,114 / 28,488–83,374 | 83,374 | 30 / 62 |

逐任务均值（请求 / tokens）：

| 任务 | Base | B | C |
| --- | --- | --- | --- |
| `13-callback-to-promise` | 12 / 27,488 | 13 / 27,433 | 11 / 20,984 |
| `20-fix-email-regex` | 9 / 15,595 | **5 / 6,956** | 10 / 21,522 |
| `08-extract-duplication` | 7 / 12,243 | 5 / 8,147 | **4 / 5,107** |

### 6.2 完整 20 任务（1 轮）

| 臂 | 通过 | 请求 | tokens | 墙钟 | shell 失败 |
| --- | --- | --- | --- | --- | --- |
| Base | 20/20 | 96 | 133,125 | 102.5s | 9 / 19 |
| B | 20/20 | 94（-2%） | 131,460（-1%） | 100.5s | 8 / 17 |
| C | 20/20 | 99（+3%） | 140,773（+6%） | 99.7s | 11 / 22 |

### 6.3 观察

1. **B 的收益集中在尾部和高方差任务，不在全量均值。** 重点任务中位请求 26→21（-19%）、中位 tokens 48.1k→36.5k（-24%）、最差轮 81.2k→61.7k（-24%）、shell 失败 44→32。逐任务看，收益主要来自 `20`（9→5 请求，5 轮都在 4–6，而 Base 在 5–13 之间摆动）和 `08`（7→5）；`13` 没有改善（12→13）。
2. **C 的分布更极端。** 中位数与 B 持平（21 请求 / 36.1k tokens），但第 1 轮的 `20` 出现 23 请求 / 59.6k tokens / 13 次 shell 失败，直接把 C 的最差轮推到 83.4k（高于 Base 的 81.2k）；完整轮 `20` 也是 14 请求 / 27.5k（Base 与 B 都是 5 请求 / 6.8k）。C 在 `13`（11 请求 / 21.0k）和 `08`（4 请求 / 5.1k）上更好，但在 `20` 上退步，方向不一致。
3. **今天的 Base 本身偏快。** 完整轮 Base 96 请求、133.1k tokens，低于六轮基线的中位数 101.5 / 139,040。因此上一份报告里「相对历史中位数 -12% / -14%」在今天的同日对照中缩小为 **-2% / -1%**；日间漂移与提示词效应同量级，不能把 -12% 当成可复现收益。
4. **描述长度不是主导因素。** C 的 shell 描述 127 字符（默认 80），在流程相同的 `08` 任务上 prompt tokens 从 5,008 升到 5,116（+2%），B 为 5,036（+0.6%）；相对于请求数波动，这部分可以忽略。

### 6.4 结论

按事先约定的门槛（成功率优先，再看成本）：

- **B 通过门槛，保留进入下一阶段**：它是三臂中唯一在「重点任务中位/最差、shell 失败、`20` 的稳定性」上方向一致的方案；但完整 20 任务的同日收益只有 -2% / -1%，属于噪声量级，不能据此宣称成本显著下降。
- **C 本轮不采纳**：成功率虽然达标，但最差轮和完整轮都劣于 Base，且改善只出现在部分任务；13 次失败的单轮样本说明它可能触发新的绕路，而不是消除失败。
- 不叠加 B+C；不改 `src/workspace.ts` 默认值；`4edd0e4` 的跨天基线继续冻结。

### 6.5 限制

- 重点任务每臂只有 5 轮 × 3 任务（15 次运行），完整任务是每臂 1 轮；范围重叠很大，均值差不是统计显著。
- 单日、单模型、单机；C 的 23 请求轮是单样本异常，不能据此断言「平台事实一定更差」，只能说这一版描述没有证明更好。
- shell 失败次数来自 `--diagnostics` 的 `resultHead`，统计的是「命令退出码非零」，其中包含任务要求的合法失败（例如 13 号缺 `config.json` 时应 exit 1），不全是浪费。
- 跨天结论仍以 `4edd0e4` 的冻结基线为准，本实验不改变该基线。

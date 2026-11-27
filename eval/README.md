# Agent 评测

> 单元测试回答“代码有没有坏”，这里回答“Agent 到底能不能把真实任务做完”。

评测属于项目的**证据层**，不负责定义架构，也不替代单元测试。

完整文档导航：[docs/README.md](../docs/README.md)。

# 最小评测集

单元测试证明「代码没坏」，评测证明「agent 还能干活」。这里放一组小任务，用真实模型跑一遍，记录**成功率、请求数、工具调用数、token 用量和耗时**。

任何影响 agent 行为的改动（提示词、工具描述、命名、错误文案、预算）都可以跑一次对比——评测的价值在趋势，不在单次分数。

## 怎么跑

```bash
npm run eval                 # 全部任务（默认 4 个并发）
npm run eval -- rename       # 只跑名字里带 rename 的
npm run eval -- --jobs 1     # 串行跑，方便看单个任务的原始耗时
npm run eval:check           # 自检：不需要 API Key
npm run eval:summary         # 汇总最近 3 轮完整评测的中位数
```

需要 `.env` 里的 `BASE_URL` / `API_KEY` / `MODEL`，跑一次会真的调用模型、真的花钱。当前基线见 [baseline.md](./baseline.md)：套件 `2026-11-19-checkers-v2`、提交 `76a024a`、`hy3`，三轮 57/60（每轮 19/20），中位数 132 次请求 / 542,515 tokens / 79.5 秒；旧套件的 6 轮 120/120 属于不同提交，不能混算。

任务之间互不依赖，所以默认并发 4 个：20 个任务的墙钟从约 226 秒降到约 74 秒。单任务的平均耗时不变（约 11 秒，8.8 步），因为时间几乎都花在等模型上——一次模型往返约 1.2 秒，工具执行和内核开销合计不到 5%。

结果会打印成一张表，同时写进 `eval/results/<时间戳>.json`（不进 git）：

```
  PASS  01-add-health-route            9 req    9 tool   10.9s   17185 tok
  FAIL  02-fix-failing-test            6 req    7 tool    8.6s   11294 tok  [check] 测试文件被改动了

18/20 通过 · 150 次模型请求 · 160 次工具调用 · 210000 tokens · 墙钟 74.0s（任务耗时合计 210.0s）
```

每行是：结果、任务名、模型请求数、真正执行的工具调用数、耗时、token。请求数和工具调用数是两个指标——一次模型回复可以要多个工具，只报「步数」会把副作用次数藏起来。端点没返回 `usage` 时，汇总的 token 前面会写 `at least`，因为那只是已统计到的下限。

记录里同时写模型名、Commit SHA、每个任务的 token / 请求 / 工具调用明细，方便把一次分数对回到具体代码。

加 `--keep` 会保留工作区，方便事后翻看 agent 到底改了什么。

## 失败先分类，再判断是谁的错

汇总会把失败分成四类：

| 分类 | 含义 | 该看什么 |
| --- | --- | --- |
| `[task]` | agent 没做完：步数/工具预算、token 预算、模型空回复 | 任务是不是太大，或者内核预算太紧 |
| `[check]` | agent 交卷了，但检查断言没过 | 先确认检查器没写错，再判断 agent 的行为 |
| `[infra]` | 检查器自己抛了非断言错误（写错、依赖缺失），或留下没 await 的 promise | 评测代码的问题，不是 agent 的 |
| `[environment]` | 网络、端点超时之类的环境问题 | 换个时间重跑，别拿它判断 agent |

前三类里，只有确认检查器没写错之后的 `[check]` 才是 agent 的真实失败。

除了逐任务分类，一轮结束还会结算一次未处理的 promise rejection：检查器里没 await 的任务如果在结算窗口内失败，**整轮判为评测基础设施失败**（记录里 `ok=false`、`infraErrors` 有内容），即使任务表全 PASS。更晚才炸的 rejection 会走 Node 默认行为，让进程非零退出——同样不会静默通过。

## 一个任务长什么样

```
tasks/01-add-health-route/
├── task.md        # 给 agent 的任务描述，就是 prompt
├── check.mjs      # export default async (root) => { ... }，失败就抛
└── files/         # 初始工作区，跑之前原样复制到临时目录
```

- **`task.md`** 只写要求，不写「用哪个工具」。任务要像真的：一个从 issue 里抄下来的小改动。
- **`check.mjs`** 只验行为，不看实现。可以 import 夹具里的模块、读文件、起子进程。
- **`files/`** 越小越好：两三个文件足够暴露「读—改—验证」的差别。

## 三条规矩

1. **初始状态必须以断言失败。** 一个任务如果在 agent 动手前就已经通过，它什么都没测。`npm run eval:check` 专门查这个，不看模型；它把结果分成 `ok`（预期断言失败）、`BROKEN`（初始就通过，或 check 没有导出函数）、`INFRA`（check.mjs 加载失败、检查器抛 TypeError/导入错误等非断言错误）。**只有 `ok` 算通过**：检查器自己崩了不等于任务有效。
2. **检查不能太松，也不能太紧。** 只断言结果（行为、文件内容、命令输出），不断言实现细节；否则 agent 换一种写法就误判。任务要求新建文件/修掉异常时，检查也要把「文件不存在」「代码抛错」写成断言失败，而不是把底层 `ENOENT` / `SyntaxError` 漏出去——那是任务没做对，不是检查器坏了。
3. **任务对齐真实工作。** 修 bug、改名、加路由、抽重复、补文档——都是这个内核每天要干的事，不要造玩具题。

## 为什么不在 CI 里跑

真实评测需要 API Key、会花钱、而且是非确定性的（模型输出有波动）。CI 只跑确定性的 `npm run check` 和不调用模型的 `npm run eval:check`；真实评测由人按需触发，或者以后单独立一条定时任务。

## 评测套件版本和检查器质量

每轮结果都会写入 `suiteVersion`。当前套件标识为 `2026-11-19-checkers-v2`，定义在 `eval/run.mjs` 的 `EVAL_SUITE_VERSION`。

只要修改任务提示、初始夹具或检查器的验收语义，就必须更新套件标识。不同套件版本的成绩不能直接混算。旧结果没有 `suiteVersion` 字段，会被标记为 `legacy`。

### v2 已加强的检查器

- `02-fix-failing-test`：对原始测试文件做 SHA-256 校验，防止删减或改写测试后仍通过。
- `03-rename-function`：递归检查整个任务目录，不能把旧函数名藏在子目录。
- `04-create-doc`：检查表头、全部 npm scripts、说明内容，并确认 README 原有介绍保留。
- `05-extract-constant`：用 TypeScript AST 确认 `TAX_RATE` 是值为 0.2 的 const，而且计算逻辑确实引用它。
- `08-extract-duplication`：用 AST 确认两个导出校验函数都委托给同一个本地共享函数，再验证行为和错误文案。
- `09-update-readme`：动态读取 `package.json`，确认全部 scripts 都列在「命令」章节内，并保留 README 原有介绍。
- `10-delete-dead-code`：递归检查整个任务目录，子目录中的旧文件和引用也不能残留。
- `19-banned-admin-bug`：除了验证被 ban 的管理员和普通用户都不能编辑，还检查 `canEdit` 不再包含嵌套 `if` 和 `else`。

历史审查指出的另外三个检查器也已加强：`06-guard-missing-file` 会验证非 `ENOENT` 错误继续抛出；`07-add-quiet-flag` 会验证普通模式的输出；`17-write-missing-test` 会运行测试并用三种错误实现做变异验证。

`test/eval-task-checkers.test.mjs` 专门测试检查器本身：既验证正确实现能通过，也验证删内容、漏检查、把表格放错位置、留下嵌套旧引用等不完整实现会被拒绝。

`eval/checker-helpers.mjs` 把任务工作区里缺失文件、模块加载失败和无效 JSON 转成断言失败，避免把 Agent 没完成任务误报成评测基础设施故障。

### 评测汇总口径

`npm run eval:summary` 只统计最近一条完整记录所属的同一组：

- 评测套件版本；
- 模型名称；
- 完整 Git Commit SHA。

不同组的记录会跳过并明确报告，不再把不同模型或不同代码版本的结果混在一起。想比较两个版本，应分别在相同任务集和模型配置下跑真实评测，再对照记录。

注意：`npm run eval:check` 只验证每个任务的初始夹具确实会让检查器失败；它不负责证明检查器足够严格。检查器的正反例由普通单元测试覆盖。

新套件的第一份真实基线已建立：三轮、同一提交 `76a024a`、同一模型 `hy3`、同一套件 `2026-11-19-checkers-v2`，共 60 次任务执行，57 次通过。逐轮数据、三轮汇总和那次单独复跑都归档在 [`baselines/2026-11-19-checkers-v2/`](./baselines/2026-11-19-checkers-v2/)：

```
round-01.json              第 1 轮完整记录
round-02.json              第 2 轮完整记录
round-03.json              第 3 轮完整记录
summary.json               三轮汇总（中位数、逐任务波动、失败分布）
04-create-doc-retry.json   该任务的单独复跑，不计入三轮成绩
diagnostics/               单任务 --trace 记录，用于定位失败与逐请求成本，不计入成绩
```

归档沿用 `eval/results/<时间戳>.json` 的原始记录，一个字段都不裁剪；`summary.json` 的口径和 `baselines/cross-day/*/summary.json` 一致（`perRound` + `perTask`），不是另一套格式。

**每轮都要单独看。** 三轮都是 19/20，合起来 57/60（95.0%）；`04-create-doc` 三轮全败，属于重复失败而不是偶发。它的失败点是检查器要求的表格形状（两列、首列表头必须叫 `命令`、命令列必须写成 `npm run <script>`），而模型稳定地写成三列或只写脚本名。这条结论有独立的复现实验支撑，见 [最终报告](../docs/reviews/2026-11-20-eval-baseline.md)。

### 一轮要花多少钱

以三轮中位数为口径：132 次请求、542,515 tokens（prompt 528,968 / completion 12,981）、墙钟 79.5 秒、任务耗时合计 286 秒（并发 4，利用率约 3.6 倍）。平均每个任务 6.6 次请求、27,177 tokens。

成本结构比总量更值得关注：**单次请求有 3,572 tokens 是固定开销**（系统提示 1,600 + 9 个工具的定义 1,972），每次都要重发。平均每请求 prompt 4,010 tokens，其中约 89% 是这段固定内容；固定块占全部 Token 账单的 87%。Completion 只占 2.4%。

所以「Token 变多」优先怀疑提示词和工具说明变长，而不是模型变啰嗦。要定位到单次请求，用 `--trace` 跑单任务（`npm run eval -- <任务名> --jobs 1 --trace --keep`），记录里会多出每请求的 `messageChars` / `toolDefinitionChars` / `promptTokens`；正式基线**不开** `--trace`，因为追踪有 I/O 开销。

诊断和跨天实验的当前约束见 [固定基线与诊断说明](../docs/eval-diagnostics.md)。

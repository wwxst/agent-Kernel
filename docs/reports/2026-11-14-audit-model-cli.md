# 2026-11-14 模型、协议与 CLI 全量审查

## 范围与方法

基线：`bacb4a498f45e76d79b7f04bee347d446723b746`。本分工对下表 10 个文件、基线合计 **3416 行**逐文件完整阅读，再按边界追踪数据流。没有用搜索命中、测试通过或抽样代替阅读。改动后逐行复核了六个修改文件的完整 diff，并重新阅读了整个项目指令读取实现。

前置完整阅读：`CODING_STANDARDS.md`、`GLOSSARY.md`、`docs/agents/domain.md`、ADR-0001 / 0004 / 0011 / 0012 / 0019 / 0022、`docs/notes/cli-and-tooling.md`。使用 systematic-debugging / test-driven-development 的先定位、写回归、确认红灯、最小修复、确认绿灯流程。相邻 `src/ui/text.ts` 也完整阅读，以复用既有终端转义能力。

本分工未读取 `.env`，未请求真实模型，未提交或推送；本分工 HTTP 都是本机测试端点。全部修复保持公开接口与运行时零依赖。总审查代理随后已完成真实模型 smoke，验证记录由总报告单独提供。

| 文件 | 基线行数 | 完整阅读区间（含首尾，连续覆盖） | 修改后行数 | 审查重点 |
| --- | ---: | --- | ---: | --- |
| `src/model/llm.ts` | 531 | 1–220、221–531 | 542 | 请求、取消、响应上限、SSE、usage、消息校验 |
| `src/model/project-instructions.ts` | 69 | 1–69 | 93 | 文件读取、trim、字符截断、提示拼接 |
| `src/protocol/errors.ts` | 180 | 1–180 | 180 | 类型、重试分类、双语显示与非空兜底 |
| `src/protocol/types.ts` | 141 | 1–141 | 141 | 协议字段、依赖方向、类型边界 |
| `src/cli.ts` | 668 | 1–230、231–460、461–668 | 669 | 参数、配置、组装、提示刷新、TUI/CLI、失败与退出 |
| `bin/agent.mjs` | 32 | 1–32 | 32 | 包内 env 路径、现有环境变量优先、导入入口 |
| `test/llm.test.mjs` | 590 | 1–180、181–390、391–590 | 620 | 假 HTTP 与 SSE、资源与取消、协议失败 |
| `test/model-errors.test.mjs` | 67 | 1–67 | 67 | 鉴权、404、网络、SSE 分类与重试矩阵 |
| `test/project-instructions.test.mjs` | 76 | 1–76 | 87 | 缺失、空白、正文、字符截断、目录 |
| `test/cli.test.mjs` | 1062 | 1–210、211–440、441–670、671–880、881–1062 | 1096 | 真 CLI 子进程、配置、工具、账单、会话、提示注入 |

## 评分口径

每文件上限 100：C 正确性 30、R 健壮稳定 25、S 安全与资源 15、P 性能 10、M 结构维护 20。只按本次发现的具体事实扣分，不以行数或主观复杂度扣分。100 表示本次阅读范围未发现应扣分项，不表示不存在未知缺陷。修复不能抵消仍未验证的具体风险；潜在兼容性/平台风险见 R1、R2。缺少某个回归用例的扣分只关联已证实会漏检的具体事故，不因为增加测试普遍涨分。

| 文件 | 修复前 C/R/S/P/M | 前总分 | 修复后 C/R/S/P/M | 后总分 | 扣分依据 |
| --- | --- | ---: | --- | ---: | --- |
| `src/model/llm.ts` | 25/22/15/10/20 | 92 | 30/24/15/10/20 | 99 | F1：C−1/R−2；F2：C−2；F3：C−2；R1：R−1 |
| `src/model/project-instructions.ts` | 30/24/10/8/19 | 91 | 30/24/15/10/20 | 99 | F4：S−5/P−2；F7：M−1；R2：R−1 |
| `src/protocol/errors.ts` | 30/25/15/10/20 | 100 | 30/25/15/10/20 | 100 | 未发现需要修改的具体错误 |
| `src/protocol/types.ts` | 30/25/15/10/20 | 100 | 30/25/15/10/20 | 100 | 类型叶子，字段与现有协议/调用一致 |
| `src/cli.ts` | 26/25/11/10/19 | 91 | 30/25/15/10/20 | 100 | F5：C−4；F6：S−4；F8：M−1 |
| `bin/agent.mjs` | 30/25/15/10/20 | 100 | 30/25/15/10/20 | 100 | env 路径与优先级符合现有约定 |
| `test/llm.test.mjs` | 30/22/15/10/20 | 97 | 30/25/15/10/20 | 100 | F1/F2/F3 原无对应回归，各 R−1 |
| `test/model-errors.test.mjs` | 30/25/15/10/20 | 100 | 30/25/15/10/20 | 100 | 分类矩阵与公开行为一致，无改动 |
| `test/project-instructions.test.mjs` | 30/24/15/10/20 | 99 | 30/25/15/10/20 | 100 | F4 原仅检查最终字符数，不能拦全量读取，R−1 |
| `test/cli.test.mjs` | 30/23/15/10/20 | 98 | 30/25/15/10/20 | 100 | F5/F6 原无对应端到端回归，各 R−1 |

本分工按文件等权平均 **96.8 → 99.8**。这不是全仓评分；仓库汇总以总报告统一口径为准。S/P 双维度扣分的 F4 分别对应「最大资源无约束」和「小输出仍全量读取的耗时」，不是两个不同缺陷。

## 已确认与修复

### F1：HTTP 错误页中断丢失已确认状态码

- 基线位置：`src/model/llm.ts:131`，读错误页时的失败直接越过 `ModelHttpError`；`src/protocol/errors.ts:80` 将所有 `ModelConnectionError` 视为可重试。
- 现象：本地服务先回 401，再写短错误正文并断开 socket，客户端抛 `ModelConnectionError`。TUI 因而有机会把明确的鉴权失败重试。
- 根因：已确认的 HTTP 状态与用于诊断的正文使用同一条失败路径，正文故障覆盖状态事实。
- 解法：`src/model/llm.ts:129–140` 保留用户取消；其余正文读取失败写入详情，仍抛原状态对应的 `ModelHttpError`。
- 防复发：`test/llm.test.mjs:202` 的真实本地 HTTP 连接中断回归。
- 扣分：基线 C−1、R−2；对应测试缺口 R−1。修复后恢复。

### F2：SSE 非 assistant 角色被伪造成 assistant

- 基线位置：`src/model/llm.ts:308–315` 忽略 `delta.role`，`:338` 固定写成 `assistant`。
- 现象：端点明确发 `role: "user"`，客户端仍成功返回 assistant 消息，流式校验弱于 JSON 校验。
- 根因：拼装器在最终 `readMessage()` 前已经丢弃了错误角色。
- 解法：`src/model/llm.ts:321` 对显式角色校验；后续合法 delta 省略角色仍允许。
- 防复发：`test/llm.test.mjs:605`，旧实现为 Missing expected rejection，新实现明确拒绝。
- 扣分：基线 C−2；对应测试缺口 R−1。修复后恢复。

### F3：SSE 完成原因可由后续帧改成成功

- 基线位置：`src/model/llm.ts:303–305` 每次覆盖 `finishReason`。
- 现象：第一帧 `length`，后续帧 `stop`，被截断的正文被当作正常完成返回。
- 根因：只验证最后的完成原因，没有保护已收到的终态一致性。
- 解法：`src/model/llm.ts:310–315` 拒绝互相冲突的完成原因；重复相同原因仍兼容。
- 防复发：`test/llm.test.mjs:612`，明确保护 `length` 不能被覆盖成成功。
- 扣分：基线 C−2；对应测试缺口 R−1。修复后恢复。

### F4：项目指令输出有界，实际文件读取无界

- 基线位置：`src/model/project-instructions.ts:48` 使用 `readFileSync` 读完整文件，`:58` 才截正文；`test/project-instructions.test.mjs:55` 仅验证输出长度。
- 现象：即使最终只给模型 32000 字符，宿主仍可先读完任意大的 AGENTS.md；大量前导空白也会全部读取并 trim。
- 根因：把最终字符串截断误当成 I/O 与内存上限。
- 解法：`src/model/project-instructions.ts:53–70` 以 64 KiB 缓冲区累计读取至 8 MiB，另探 1 字节确认实际截断；流式 UTF-8 解码避免切断半字符产生替换字符，finally 关闭文件。保持原 32000 字符正文截断；达到字节窗口时也给出截断提示。
- 防复发：`test/project-instructions.test.mjs:78`，8 MiB 空白后的正文不再读取，仍明确报告截断。该用例保护公开输出边界，不 mock 自己模块、不断言内部 read 调用次数。
- 行为边界：8 MiB 之外的项目指令不再加入提示，包括极端前导空白之后的正文。此项事前已通知总审查代理；极端输入从「继续全读」变成「明确截断」。公开返回形状不变，正常文件仍按既有字符上限处理。
- 扣分：基线 S−5/P−2；对应测试缺口 R−1。修复后恢复；特殊文件的打开风险 R2 仍保留。

### F5：CLI 项目指令动态刷新只有函数外壳

- 基线位置：`src/cli.ts:337` 在创建 Agent 时缓存正文，`:350–351` 却称每次请求会看到新内容。
- 现象：模型第一轮工具修改 AGENTS.md，下一次请求仍带旧规范；多 Run 的 Session 也一直使用旧正文直到 reset。
- 根因：systemPrompt 每次求值，但它闭包捕获的指令是启动时快照。
- 解法：`src/cli.ts:348–352` 把读取移入 systemPrompt 函数，每次请求前读取当前文件。
- 防复发：`test/cli.test.mjs:1081` 启动真实 CLI，模型脚本要求 write 更新 AGENTS.md，断言第二次真实请求的新 system 内容；第一个请求仍是旧内容。
- 扣分：基线 C−4；对应测试缺口 R−1。修复后恢复。

### F6：普通 CLI 致命错误可输出终端控制字符

- 基线位置：`src/cli.ts:663` 原样输出 `describeForUser()`，其内容包含上游 HTTP 正文；现有正文/工具展示已转义，但该异常路径遗漏。
- 现象：本机假服务回 401 与包含 U+009B（C1 CSI）/U+202E 的错误详情，stderr 含这些原始字符，可影响终端显示。
- 根因：错误诊断没有复用统一的终端转义入口。
- 解法：`src/cli.ts:638` 与 `:664` 复用 `ui/text.ts` 的 `escapeControlCharacters()`，保持错误对象与协议原文不变，只改变显示。
- 防复发：`test/cli.test.mjs:990`，断言失败退出码、HTTP 状态保留、原始控制字符消失、可见转义仍在。测试端点 JSON.stringify 会转义 ESC，所以使用仍原样保留的 C1 CSI 与 bidi 验证该路径。
- 扣分：基线 S−4；对应测试缺口 R−1。修复后恢复。

### F7：项目提示缺少源码中文逐句对照

- 基线位置：`src/model/project-instructions.ts:64–65` 的标题和两句英文指令没有中文翻译，违反编码规范 2.3。
- 解法：当前 `src/model/project-instructions.ts:85–89` 补齐三条中文注释，运行时字符串保持不变。
- 扣分：基线 M−1；修复后恢复。注释修复不另造行为测试。

### F8：目录参数校验注释仍描述已删除的工作区边界

- 基线位置：`src/cli.ts:161` 的 isDirectory 注释写「路径越界由 Workspace 负责」，与 Full access 已无工作区边界的事实冲突。
- 解法：当前 `src/cli.ts:162` 注释明确完全访问不设路径边界，该函数只判断目录是否存在。实际参数与访问行为不变。
- 扣分：基线 M−1；修复后恢复。注释修复经逐行 diff 复核，不新增行为测试。

## 残留风险与建议

| 编号 | 类别 / 扣分 | 事实位置与边界 | 建议与本轮未做原因 |
| --- | --- | --- | --- |
| R1 | 潜在兼容性，R−1（前后保留） | `src/model/llm.ts:180–194` 按每个 `data:` 行独立 JSON.parse，而不是先按 SSE event 收集多行 data；传统单行 JSON chunk 工作正常。 | 只有端点采用多行 data 或 CR 单独换行时可能失败。本轮没有真实该类端点验证；扩展 SSE 事件语法需补专门协议用例，不把它冒充已复现的生产事故。 |
| R2 | 潜在特殊文件阻塞，R−1（前后保留） | `src/model/project-instructions.ts:53–54` 先同步 open 再 fstat；普通文件/目录已覆盖，但 POSIX FIFO 的打开可能先于类型检查阻塞。 | 后续可在 POSIX 通过 nonblocking open 与独立子进程超时用例验证。当前 Windows 环境未验证，8 MiB 上限只保证普通文件读取量，不是所有设备 I/O 的时间上限。 |

不把以下情况另算故障：项目指令读取失败返回 undefined 是现有函数文档与用例明确规定的容错，未擅自改为启动失败；流式缺省角色仍兼容；已收到 finish_reason 后是否必须再见 DONE 沿用 ADR-0012 的口径；真实模型与真实终端未验证是证据边界，不等于发现新的代码缺陷。

## 红绿证据与验证

1. 新增 F1/F2/F3/F5 四个测试后，运行：

   ```text
   node --test --test-name-pattern='正文中断|非 assistant|完成原因不能|工具更新 AGENTS' test/llm.test.mjs test/cli.test.mjs
   ```

   修复前 exit 1，4 tests / 0 pass / 4 fail。分别是：401 实际变 ModelConnectionError；非法 role 与改写 finish_reason 都 Missing expected rejection；第二次请求仍 OLD_PROJECT_RULE。最小修复后 exit 0，4/4 pass。

2. 新增 F4 测试后运行：

   ```text
   node --test --test-name-pattern='8 MiB 读取窗口' test/project-instructions.test.mjs
   ```

   修复前 exit 1，truncated 实际 false、期望 true，旧实现读到窗口外尾部。修复后整个 `test/project-instructions.test.mjs` 6/6 pass。

3. 新增 F6 测试后运行：

   ```text
   node --test --test-name-pattern='HTTP 错误详情里的' test/cli.test.mjs
   ```

   修复前 exit 1，stderr 中存在原始 U+009B/U+202E；显示层转义后 exit 0，1/1 pass。

4. 修改完成后相邻测试全跑：

   ```text
   node --test test/llm.test.mjs test/model-errors.test.mjs test/project-instructions.test.mjs test/cli.test.mjs
   tests 92 / pass 91 / fail 0 / skipped 1 / duration 8639.8762 ms / exit 0
   ```

   唯一 skip 是 Windows 不能向另一 Node 进程投递 SIGINT 的既有平台跳过。未删任何测试，新增 6 个行为回归；这四个文件既在 package.json 测试清单内，未新增测试文件。

全仓 `npm run check` 由总审查代理在所有分工停止修改后统一执行，结果见总报告。本报告的数字是独立分工验证，不能替代全仓结果。未做真实模型请求、真实终端人工验收、POSIX FIFO 实验或多行 SSE 端点兼容性验收。

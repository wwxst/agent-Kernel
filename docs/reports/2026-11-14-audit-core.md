# Core、TodoWrite 与对应测试全量审查

日期：2026-11-14。基线：`bacb4a498f45e76d79b7f04bee347d446723b746`。范围：`src/core/*`、`src/tools/todo.ts` 与下表六份测试/夹具。审查采用逐文件完整阅读；测试用于复现和验证，未代替阅读。

发现并处理两个确定问题：工具说明书中的嵌套 Schema 与注册表内部共享引用；失败 Hook 测试把断言写在会吞掉异常的回调内，可能错误通过。没有新增运行时依赖，没有提交、推送、读取 `.env` 或调用真实模型。

## 阅读记录

开始前完整阅读了 `CODING_STANDARDS.md`（429 行；分为 1–220、221–429 两段，补齐第一次合并读取被截断的部分）、`GLOSSARY.md`（135 行）与 `docs/agents/domain.md`。相关 ADR 完整阅读：0001、0002、0003、0004、0011、0012、0019、0020、0021、0024。另读取了 `package.json` 以确认现有测试入口。

下表区间均为基线行号，端点包含在内。`全文` 表示一次返回了完整文件，没有以检索片段替代。全部分配文件共 3341 行；改动后共 3360 行。

| 文件 | 基线行数 | 完整阅读区间 | 改动后行数 |
| --- | ---: | --- | ---: |
| `src/core/agent.ts` | 583 | 1–220、221–420、421–583 | 583 |
| `src/core/tool-hooks.ts` | 185 | 全文 1–185 | 185 |
| `src/core/tool-log.ts` | 103 | 全文 1–103 | 103 |
| `src/core/tool-registry.ts` | 248 | 全文 1–248 | 249 |
| `src/core/tool-result-status.ts` | 33 | 全文 1–33 | 33 |
| `src/tools/todo.ts` | 117 | 全文 1–117 | 117 |
| `test/agent.test.mjs` | 899 | 1–230、231–460、461–690、691–899 | 899 |
| `test/tool-registry.test.mjs` | 410 | 1–220、221–410 | 425 |
| `test/tool-hooks.test.mjs` | 385 | 1–200、201–385 | 388 |
| `test/tool-log.test.mjs` | 174 | 全文 1–174 | 174 |
| `test/todo.test.mjs` | 117 | 全文 1–117 | 117 |
| `test/support/harness.mjs` | 87 | 全文 1–87 | 87 |

修改后又核对了全部 diff、新增回归和修改处周边分支；未修改的行以上述全读记录为准。

## 逐文件检查结论

- `src/core/agent.ts`：检查默认提示、系统消息刷新、观察者异常隔离、Run 排他和计数复位、会话累计、请求重试和退避取消、usage 已知/未知、token 软上限、末步禁止工具、工具整批预算、串行顺序、取消时补齐 Tool result、进程树清理失败后跨 Run 禁用工具。现有的失败历史保留、软预算最终答复可成功等行为与对应 ADR 一致。本次未发现需要扣分的问题。
- `src/core/tool-hooks.ts`：检查每个 Hook 的参数/调用副本、登记顺序、阻止原因兜底、前置抛错放行、后置故障计数和继续后续 Hook。无超时和失败事件传原始错误是 ADR-0020 明示边界，不能在此次审查中自行改成另一套行为。
- `src/core/tool-log.ts`：检查显式开启、统一字段、参数/结果截断、JSONL 追加、父目录建立、写失败只提醒一次、shell 非零退出归类、前置拦截不落日志。日志原文、不脱敏、不轮转均为 ADR-0021 已决定的取舍。
- `src/core/tool-registry.ts`：检查注册重名和 Schema 体检、嵌套对象/数组校验、自有必填字段、防止非有限数、未知参数保留、JSON 错误折文本、Hook 时机、普通错误兜底与 `ProcessCleanupError` 例外。确定问题 C01 已修复。
- `src/core/tool-result-status.ts`：检查首个非空行、`ERROR:`、shell 非零/null 退出码、超时和取消。没有扩大 `shell-output` 的语义：成功读取后台状态，与后台命令本身是否成功是两个事实；现有 ADR 没有要求把这次读取记成失败。本次不把该产品选择算成缺陷。
- `src/tools/todo.ts`：检查 20 项/200 字符上限、原始输入在 trim 前拒绝控制字符和 Unicode 行分隔符、空白/重复、三个状态、最多一个进行中、错误更新不提交、返回文本不能反向改写状态、不同管理器隔离。未发现需要扣分的问题。
- `test/agent.test.mjs`：逐个读完用例及断言，核对公开接口、固定期望值、工具 id 配对、预算失败后的历史、取消与会话延续、回调异常、真实请求数与重试数。未因本次别处新增回归而给本文件加分。
- `test/tool-registry.test.mjs`：逐个检查 schema 和异常分支；新增一项公开接口回归，覆盖读取者篡改嵌套 Schema 的行为。原有测试没有已确认的错误断言，未因新增用例给整文件额外加分。
- `test/tool-hooks.test.mjs`：检查顺序、阻止、上下文、副本、故障隔离、普通错误和致命错误、九工具接入、Run 集成。确定问题 C02 已修复。
- `test/tool-log.test.mjs`：检查真实临时文件的字段、顺序、截断、目录、失败提醒、shell 状态和拦截无日志；stderr 替换由 finally 恢复。未发现需要扣分的问题。
- `test/todo.test.mjs`：检查完整替换、非法更新原子性、Unicode 首尾与内部控制字符、调用者引用隔离、管理器共享/隔离和工具说明书结构。未发现需要扣分的问题。
- `test/support/harness.mjs`：检查消息形状、脚本响应/usage、请求和响应深复制、工具装配、每用例临时目录 finally 清理。脚本重复末项用于驱动预算用例，是明确的夹具行为。未发现需要扣分的问题。

## 扣分依据、修复与证据

### C01：说明书返回的 Schema 可修改注册后的参数校验（确定问题，已修复）

基线位置：`src/core/tool-registry.ts:181`。`definitions` 为每个工具创建了新外层对象，但 `parameters` 仍指向内部工具的同一对象。调用方只需读取 `registry.definitions`，再清空 `required` 或改 `properties.value.type`，下一次 `execute()` 就按被改过的规则校验，注册期体检和后续校验失去一致性。

影响：读取者本应只获取说明书，却获得了改写参数校验规则的入口。该问题可造成错误参数被执行，或合法参数被错误拒绝；它是进程内状态隔离问题，不等于操作系统提权或 Sandbox 绕过。

扣分：C 正确性 −4、R 健壮稳定 −3、S 安全资源 −2、M 结构维护 −1；P 性能不扣。建议和实际修复：在说明书出口深拷贝 `parameters`，保持校验唯一入口和既有注册接口。改动后位置 `src/core/tool-registry.ts:182`。没有冻结工具、增加新配置或改写构造方的装配约定。

回归位置：`test/tool-registry.test.mjs:55`。通过公开 `definitions` 与 `execute` 验证：改返回值后，新的说明书仍保留原始类型/必填规则，缺失值和错误类型仍被拒绝。

红绿记录：

```text
node --test --test-name-pattern="definitions：修改嵌套" test/tool-registry.test.mjs
修复前：exit 1；tests 1 / pass 0 / fail 1
实际 Schema 的 type 变成 object，required 变成 []，与固定期望不符。
修复后：exit 0；tests 1 / pass 1 / fail 0
```

### C02：Hook 回调里的断言会被故障隔离吞掉（确定的测试盲点，已修复）

基线位置：`test/tool-hooks.test.mjs:87`、`:88`、`:89`。失败事件回调内先登记 `failure` 事件，再检查错误实例、错误内容和工具名。`ToolHooks` 有意捕获回调异常（`src/core/tool-hooks.ts:178`）；这些断言即使失败，也只增加 `failureCount`，原测试没有检查该计数，外围结果和事件顺序仍可通过。

扣分：C 正确性 −4、R 健壮稳定 −2、M 结构维护 −1；S 安全资源/P 性能不扣。建议和实际修复：Hook 只捕获收到的上下文，所有断言移到 `execute()` 完成之后，在测试本身直接判断。改动后位置 `test/tool-hooks.test.mjs:97`、`:98`、`:99`。产品行为未改变。

另做了无落盘的断言敏感性实验：从 `git show <基线>:test/tool-hooks.test.mjs` 读出完整测试，在内存中只把错误内容期望值改成故意错误的字面量，再通过 data URL 加载，限定运行该测试。基线仍 exit 0（1/1 通过），证明假通过；对修复后的测试做同样的内存替换则 exit 1（1/1 失败，actual 为 `disk on fire`），证明修复后错误断言能传播到测试结果。实验没有改坏工作区文件。

正常用例随后与其余分配测试一起通过。该改动是提高既有断言的可观察性，不宣称发现了产品目前会返回错误上下文的问题。

## 逐文件维度评分

维度上限：C 正确性 30、R 健壮稳定 25、S 安全资源 15、P 性能 10、M 结构维护 20。每格依次为 C/R/S/P/M，括号为总分。100 仅表示在本次完整审查范围内没有发现可扣分项，不表示不存在未知缺陷。除 C01、C02 外没有其他确定问题或尚未处理、需要扣分的潜在风险；已有 ADR 的显式取舍单独写在上文，不伪装成缺陷。测试不因新增用例而普遍加分。

| 文件 | 审查前 C/R/S/P/M（总分） | 审查后 C/R/S/P/M（总分） | 扣分依据 |
| --- | --- | --- | --- |
| `src/core/agent.ts` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |
| `src/core/tool-hooks.ts` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |
| `src/core/tool-log.ts` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |
| `src/core/tool-registry.ts` | 26/22/13/10/19（90） | 30/25/15/10/20（100） | C01，基线 :181 |
| `src/core/tool-result-status.ts` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |
| `src/tools/todo.ts` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |
| `test/agent.test.mjs` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |
| `test/tool-registry.test.mjs` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无；新增回归未普遍加分 |
| `test/tool-hooks.test.mjs` | 26/23/15/10/19（93） | 30/25/15/10/20（100） | C02，基线 :87–89 |
| `test/tool-log.test.mjs` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |
| `test/todo.test.mjs` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |
| `test/support/harness.mjs` | 30/25/15/10/20（100） | 30/25/15/10/20（100） | 无 |

## 验证与限制

```text
node --test test/agent.test.mjs test/tool-registry.test.mjs test/tool-hooks.test.mjs test/tool-log.test.mjs test/todo.test.mjs
exit 0；tests 101 / pass 101 / fail 0 / skipped 0

git diff --check -- <本报告所列分配的 src/test 文件>
exit 0，无空白错误输出
```

本分工只运行了上述定向测试；全仓库 `npm run check` 由主审统一运行和记录。本分工没有运行真实模型或读取 `.env`；主审另外通过标准启动器完成一次真实模型读写冒烟，证据见总报告。该冒烟不等于完整 TUI 验收。定向测试在当前 Windows 环境执行，没有据此宣称 Linux/macOS 实机验证。

修复保持公开字段和错误文案，保留串行工具、既有预算、Hook 隔离、会话与全访问行为。C01 防复发由新增公开接口回归保护；C02 防复发由回调外断言和上述敏感性实验确认。此次未引入需要新 ADR 的产品选择。

## 追加：主审修改的独立逐行复核

在上述分工完成后，主审另外要求独立复核以下文件的**修改部分和必要上下文**：`src/tools/workspace.ts`、`eval/run.mjs`、`eval/summary.mjs`、`eval/diagnostics.mjs`、`test/workspace.test.mjs`、`test/eval.test.mjs`、`test/eval-diagnostics.test.mjs`。这次复核没有把这些文件计入前面的 3341 行全文覆盖和逐文件评分，也没有修改它们。

复核逐行读取了当时完整 `git diff` 的全部 hunk；额外读取 `Workspace.glob`/`resolveGlobRoot`、`readJobOutput`/`readJobText`/`jobLogSize`、动态规划匹配器及遍历入口上下文，`eval/run.mjs:1–220`，`eval/summary.mjs` 全文，`eval/diagnostics.mjs:1–190` 及主审后续资源边界修改后的 `:120–185`，以及相关测试夹具/修改用例周边。

复核结果：

- glob：`*` 的同层消费、`**` 的跨目录消费、`?` 的一个 UTF-16 单元，以及 `**/` 的零层跳过或恰好停在 `/` 后的状态转移一致。每 token 只扫描候选路径位置，不枚举星号分配组合；时间为 O(模式长度 × 路径长度)，每候选路径工作空间为 O(路径长度)。这消除了原正则回溯的指数路径，不声称它有独立的固定毫秒时限。
- glob 兼容实验：只在内存提取基线正则函数和当前动态规划函数，枚举由 `a`、`b`、`/`、`*`、`?`、`**`、`**/` 构成的短模式及 `a`、`b`、`/` 候选字符串，总计比较 1,019,564 组，无差异。该实验是辅助诊断，没有新增测试私有函数的永久用例。比较域不包含换行：旧 `.`/`$` 正则对 POSIX 换行文件名的行为与严格按字符消费的动态规划可能不同，已向主审说明；当前 Windows 环境不能据此宣称该边界的文件系统实机验证。
- shell-output：轮询开始时取消检查可在下一次轮询拒绝；日志 stat 失败向上抛出，符合 Workspace 抛异常、Registry 折 ERROR 文本的边界。新测试从真实后台进程取得日志并在 finally 清理进程，没有伪造工具内部状态。
- eval jobs：CLI 不再通过 `||`/`Math.max` 静默修复非法值；`runRound` 在登记进程级监听器和启动任务池前拒绝非正的非安全整数。合法大并发值仍由任务池缩至任务数。新用例检查拒绝和零端点请求。
- summary：轮数正安全整数校验、只数任务目录、完整任务集合/唯一性、任务 ok 布尔值及 passed 自洽检查相互配合；缺少任务结果不会再仅凭 total 被当成完整轮次。`results` 含 null 等畸形记录仍可能明确抛错，这是已有坏记录边界，已提醒主审；本轮校验不等于所有损坏输入都静默跳过。
- diagnostics：无原型字典使 `__proto__` 普通文件名参与新增/修改对比；主审后续把 lstat/readFile 改成同句柄 stat 和 `size+1` 上限的循环 read，逐行复核了增长/短读/空文件、metadata 降级、complete=false 和 finally 关闭句柄。每次读取有明确上限，但不声称获得原子快照或消除所有目录/符号链接 TOCTOU。新增大文件用例验证正常降级，不构成竞态先红后绿复现。

复核时未发现这些修改引入的阻断问题；上述边界和验证范围已发回主审。本次额外运行：

```text
node --test --test-name-pattern="glob：|shell-output：等待新输出期间取消|shell-output：日志丢失|评测：非法并发数|评测汇总：|诊断：__proto__" test/workspace.test.mjs test/eval.test.mjs test/eval-diagnostics.test.mjs
exit 0；tests 14 / pass 14 / fail 0

node --test test/eval-diagnostics.test.mjs
exit 0；tests 5 / pass 5 / fail 0
```

没有运行全量 check；最终全量检查仍由主审统一负责。后续这些文件若继续修改，以主审最终复核记录为准。

## 追加：UI 修改的独立逐行复核

主审通知 UI 修改冻结后，逐行读取了 `git diff -- src/ui/text.ts src/ui/tui-image.ts src/ui/tui.ts test/cli-presenter.test.mjs test/tui-image.test.mjs test/tui.test.mjs` 的全部 hunk；并补读控制字符转义全文，PNG 调色板采样和解码上下文，TUI 粘贴解析、快捷键/补全、外部编辑器、主视图/整屏视图输入定位、宽度裁剪和活动组渲染上下文。这里只复核修改及上下文，不冒称这些额外文件全文已读。

未发现新增阻断问题。主要检查结果：

- 新增 ALM/LRM/RLM 方向控制字符都转为可见转义；文件补全候选通过单行化、转义、宽度裁剪后上色，选中项不再绕过安全输出。
- PNG 的实际 PLTE 索引检查在每像素采样之前执行；合法索引保留实际像素，越界索引拒绝预览，未把损坏数据冒充白色像素。
- transcript 使用独立 WeakMap 保存轮次/活动组展开状态；主视图仍按原有 flat 状态打印，已打印历史不会因详情切换而回写。主视图另外保留读取截断警告和无结果工具状态。
- 外部编辑器使用独立临时目录和 0600 文件；路径经单独环境变量在 Shell 中双引号展开，避免把含空格/元字符的路径直接拼进 Shell 语法。Windows 实际空格路径用例通过；没有据此宣称 POSIX 编辑器交互已实机验证。
- 输入段索引同时用于锚点回退、状态行上移和光标列计算；横向裁剪同步更新 `inputOffset`，并按 Unicode code point 向左测宽。暂停输出时输入刷新仍能更新编辑文字。
- 在途粘贴超过单段容量后清空缓存并丢弃直到结束标记；正常结束后后续输入能继续。该保护针对输入缓存，没有借此宣称整个进程存在统一 32 MiB 总内存上限。

两项低影响建议已即时告知主审，不影响以上主要路径验证：

1. 当时 `src/ui/tui.ts:613` 的单段超限复用了 `:646` 的「会话归档已满，需重开」警告；此时会话历史可能仍为空，较小粘贴无需重开即可继续。建议单独解释单段容量限制，避免把一次输入过大误报成会话已耗尽。
2. 当时 `src/ui/tui.ts:2037–2048` 在新建临时目录后准备文件失败会返回，没有尝试移除自己刚创建的目录。它不会破坏输入，但反复失败可能留下小量临时资源。建议准备失败分支也做有界清理，并保留原错误及清理失败的可观察信息。

本次额外运行：

```text
node --test --test-name-pattern="方向控制|PNG 调色板|TUI transcript：完成后的|TUI 主视图：真实 Run|任务结束时无结果|长行滚动|多行内容中|暂停刷新时|历史阶段说明|TUI 文件补全：|TUI 外部编辑器：临时目录|TUI 粘贴：未闭合" test/cli-presenter.test.mjs test/tui-image.test.mjs test/tui.test.mjs
exit 0；tests 14 / pass 14 / fail 0
```

以上额外复核结论均基于复核时的工作区快照；主审此后另外修改 summary 的 null 条目过滤和 eval report 落盘等待/失败传播，不在上述早先快照结论中冒称已经独立检查。最终状态由主审统一验证。

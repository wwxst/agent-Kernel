# Multi-Agent 代码审查报告：Tool Registry / Tool Execution

> 记录时间：2026-11-20 · 类型：多 Agent 代码审查记录（不是规格）· 代码未改动 · 审查基线 `main@76a024a`

审查模式：**Review Only（未修改任何代码）**
执行框架：`multi-agent-code-review` Skill

---

## 1. 最终结论

| 项目 | 结果 |
|---|---|
| **状态** | **PASS WITH WARNINGS** |
| 审查范围 | 仓库 `E:\JavaProjects\web-project\agent-Kernel`，分支 `main`，HEAD `76a024a496a424614c47ebc6660c2b94ae6c347d`；Tool Registry / Tool Execution 模块**全量审查**（无 diff 基线） |
| 风险等级 | **High**（模块含 Shell 执行、文件系统访问、Agent 工具调用边界 → 强制独立安全审查） |
| 实际创建 Agent | **13 个；完成 13 个；失败 0 个；超时 0 个** |
| 候选问题 | 16 条（Bug Hunt 10 + 安全审查 6） |
| 去重后唯一问题 | **12 条**（F-001 ~ F-012） |
| 已确认问题 | **7 条**（1 × MEDIUM，6 × LOW） |
| 已排除/误报 | **5 条**（F-006、F-007、F-008、F-010、F-012） |
| 另有 1 条安全发现 | SEC-06，因 ADR 已明文登记为已知缺口而排除（未走投票，见第 10 节） |
| 已修复问题 | **0 条**（Review Only，按要求不修改代码） |
| 测试 | 3 项通过 / 0 失败 / 0 未运行 |
| 开发者是否需要处理 | **是**（F-001 建议在开启 `AGENT_TOOL_LOG` 前修复） |

> 本次**确实创建了 13 个真实独立上下文子 Agent**，并行执行、独立回收结果，未使用单 Agent 模拟多角色。

### 一句话结论

模块整体设计成熟、契约文档详尽、714 个测试全绿，**没有发现阻断级问题**。唯一值得优先处理的是 **F-001**：Hook 机制的上下文复制被写在故障隔离的 `try` 之外，导致「工具已执行、结果丢失、Run 崩溃、会话 transcript 永久损坏、审计无记录」四重后果同时发生——它只在开启 `AGENT_TOOL_LOG` 后可达，但一旦触发不可自愈。

---

## 2. 环境能力检查（正式审查前完成）

| 能力 | 结论 | 依据 |
|---|---|---|
| 创建独立上下文子 Agent | ✅ | `Agent` 工具实际创建 13 个，各自独立上下文 |
| 并行启动 | ✅ | 3 个 Bug Hunter、4 个 Voter 均同批发出并发执行 |
| 结果回收 | ✅ | 13 个 Agent 全部返回 `COMPLETED` 与完整结果 |
| 失败/超时状态 | ✅ | 支持 `FAILED / TIMED_OUT / CANCELLED` 状态位 |
| Agent 间沟通 | ⚠️ **受限** | 首轮 Agent 完成后 `SendMessage` 返回 `Not in a team`；改用 `Agent(resume=…)` 续跑实现主 Agent 中转式交叉质疑（COORDINATOR_RELAY）。详见第 10 节流程异常 |

**能力判定：`MULTI_AGENT_FULL`（创建/并行/回收完整）+ `COORDINATOR_RELAY`（交叉质疑经主 Agent 中转）**。因交叉质疑确实执行成功，**未启用降级模式**，未标记 `SINGLE_AGENT_FALLBACK` 或 `MULTI_AGENT_NO_CROSS_TALK`。

---

## 3. 主 Agent 做了什么

1. **加载规则**：读取 Skill 主文件，以及 `agent-orchestration.md`、`agent-collaboration.md`、`workflow.md`、`reporting.md`（每次必读四份）、`bug-hunting.md`、`finding-validation.md`、`security-review.md`、`templates/review-report.md`。
2. **确认范围**：当前工作区 `C:\Users\Administrator\WorkBuddy AI\2026-11-20-08-52-01` 是空目录、非 git 仓库。扫描本机后与开发者确认，目标为 `E:\JavaProjects\web-project\agent-Kernel`；`git status` 初始干净，HEAD `76a024a`，`main` 分支。确认为**全模块审查**（该仓库无可用的变更 diff 基线）。
3. **读取项目规则**：`AGENTS.md`、`CODING_STANDARDS.md`、`GLOSSARY.md`、`docs/architecture.md`、`docs/contracts/behavior-verification.md`、`docs/configuration.md`、ADR-0002 / 0019 / 0020 / 0021 / 0025 / 0030 / 0031。
4. **基础验证（真实执行）**：
   - `npm run typecheck` → **PASS**（无输出）
   - `npm run architecture:check` → **PASS**（28 个源文件、70 条内部依赖）
   - `npm test` → **PASS**（714 用例：700 通过 / 0 失败 / 14 跳过，32s）
5. **调度 Agent**：并行创建 3 个 Bug Hunter（A 行为与根因 / B 集成与数据流 / C 边界与失败路径），各自收到自包含 Brief（角色、范围、必读规则路径、隔离要求、输出格式、只读约束）。
6. **冻结首轮**：等三个 Hunter 全部真实返回后冻结，未提前引用任何未返回 Agent 的结论。
7. **组织交叉质疑**：按「A 查 B、B 查 C、C 查 A」的分工发起定向质疑，并向 A 追加针对其首轮「主动豁免」的质询。
8. **独立验证**：12 条候选问题去重后，各派 2 个独立 Voter（voter-1/2 覆盖 F-001~F-006，voter-3/4 覆盖 F-007~F-012）；三处分歧各追加第 3 票（voter-5 裁 F-007/F-010，voter-6 裁 F-006）。
9. **安全审查**：并行启动独立 Security Reviewer（与投票互不可见）。
10. **主 Agent 亲自复核**：对关键结论自行写探针脚本复现，不依赖子 Agent 的转述（见第 7 节）。
11. **出报告**：汇总账本、核对数量一致性、标注流程异常。

**主 Agent 自己实测复现的项**（不依赖子 Agent）：

| 复现项 | 结果 |
|---|---|
| 深嵌套参数 + 双后置 Hook（生产装配） | `run()` 抛 `RangeError`；`sideEffect:1`；transcript = `system,user,assistant(tool_calls:1)`，**0 条 tool 消息**；第二次 `run()` 继续沿用残缺历史 |
| 深嵌套参数 + 仅 `postToolUse` | 工具成功执行，但调用方收到 `ERROR: Maximum call stack size exceeded`、`isError:true`（成功被改写成失败） |
| 深嵌套参数 + 无 Hook | 完全正常，工具收到完整参数并返回真实结果（**对照实验**） |
| 深度阈值（受控二分） | `structuredClone` 最大 1896 层；`JSON.parse` 20 万层仍正常 |
| `Workspace.run` 返回形状 | 确认返回纯文本，`tool-registry.ts:281` 一律 `isError:false` |
| `ToolHooks.failureCount` 读取者 | `src/` 下**零读取者**，仅测试读取 |
| `cli.ts:389` 装配 | 未设 `AGENT_TOOL_LOG` 时为 `undefined`（空 Hook）；设了只登记两个后置事件、**无 `preToolUse`** |
| 脱敏引入提交 | `6e9ef2a "fix(logging): redact credentials from tool diagnostics"`，只改 `tool-log.ts`（+19/−2），未同步 ADR |

---

## 4. Agent 之间的沟通情况

- **沟通模式**：`COORDINATOR_RELAY`（主 Agent 中转）。首轮 Agent 结束后 `SendMessage` 不可用，改用 `Agent(resume=原 agent_id)` 续跑原 Agent 完成第二轮。
- **是否完成交叉讨论**：**是**。3 个 Hunter 各自对收到的 finding 给出了有代码证据的质疑/确认，共 3 组 × 3 议题 = 9 次定向质询。

| 发起 → 接收 | 议题 | 讨论内容 | 回应与证据 | 是否改变结论 |
|---|---|---|---|---|
| 主 → A | C-01 | A 首轮主动豁免了 cloneContext 路径（"当前无工具改写 args"），C 却立案 HIGH | A 承认豁免理由作废：真实触发源是参数深度，且 `cli.ts:389` 无 `preToolUse`，`tool-hooks.ts:151` 那条"在 try 内"的保护从未执行 | **是**（A 由"不立案"改为 CONFIRM） |
| 主 → A | B-01 | shell 三类失败走"成功"事件，算不算缺陷 | A 引 ADR-0002 末句「宿主代码不能靠 try/catch 感知工具失败——需要感知时看文本前缀」+ ADR-0021:18，判为既定设计，最多 LOW 文档缺口 | 否（维持不立案） |
| 主 → A | C-02 | `readBlockReason` 对非对象返回放行，是代码错还是注释错 | A：代码自洽（`{block}` 三态），错的是 `tool-hooks.ts:92` 那句「返回非空字符串 = 阻止」 | 否（判注释缺陷） |
| 主 → B | C-01 | 端到端：RangeError 逃出后 transcript 是否残缺、下次 run 是否发出去 | B 逐行核对 `agent.ts:761`（append）先于 `:776`（executeToolBatch），确认残缺；并补出**两个必要条件**：必须同时注册两个后置 Hook、必须无 `preToolUse` | 是（首轮"六条路径配对完整"补为第七条） |
| 主 → B | C-05 | failureCount 无人读取，算不算违反 CODING_STANDARDS | B：`runQuietly` 确实 `failures++`，缺的是"出口"，定性为可观测性缺口而非吞异常 | 是（由"仅观察"改为立案） |
| 主 → B | A-01 | `execute()` 是否有生产调用者 | B：`src/` 零调用者，属文档缺陷 + API 陷阱，LOW | 否 |
| 主 → C | A-02 | 结构化失败时 Hook 拿到的是合成 Error | C：路径成立，且 `test/subagent.test.mjs:453-465` **只断言事件名、从不校验 `context.error` 形状**（测试盲区） | 否（补强证据） |
| 主 → C | B-01 | shell 失败是否"永不"触发失败 Hook | C：**"永不"说过头了**——`ProcessCleanupError`、启动前取消、spawn 失败仍会触发；准确表述是"正常收尾的三类失败不触发" | 是（收敛表述） |
| 主 → C | B-02 | redact 与 ADR-0021 是否矛盾 | C：ADR + `configuration.md:85` 说"不做脱敏"，代码 + 测试要求脱敏，两套事实并存；补出 `slice(0,100)` 静默丢元素 | 否（补强证据） |

### 交叉质疑带来的实质修正

1. **C-01 根因上移**：从"structuredClone 有深度上限"上移到"`cloneContext` 被写成 `runQuietly` 的实参，求值发生在 `try` 之外"。B-x 与 C-x 各自独立补出**对照实验**：不登记任何 Hook 时 1900 层深参数完全无害——证明缺陷由 Hook 机制自己引入，与深参数、与 registry 的 `JSON.parse`、与参数校验都无关。修复点因此唯一且明确。
2. **B-01 表述收敛**：从"永不触发"收敛为"正常收尾的三类失败不触发"，并补出三个反例。
3. **阈值三方不一致被纠正**：C-x 最初报"JSON.parse 1900 层抛"，经自查发现是把 `JSON.stringify` 的失败误记成 parse；B-x 报 1350；主 Agent 受控测量 1896。最终按区间表述。
4. **A-01 与 B-01 正交**：B-x 判定两者不叠加，不存在"同一调用两处都错"的放大路径。

---

## 5. Agent 执行账本

| # | Agent ID | 角色 | 状态 | 实际检查范围 | 读取规则 | 候选问题 | 交叉沟通 | 最终贡献 |
|---|---|---|---|---|---|---|---:|---|---|
| 1 | `bug-hunter-a@_auto_4b4be284…` | Bug Hunter A（行为与根因） | COMPLETED | tool-registry / tool-hooks / tool-log / tool-result-status / agent.ts 工具执行段 / protocol / cli 装配 / tools run() 形状 | bug-hunting.md + AGENTS / CODING_STANDARDS / GLOSSARY / ADR-0002·0019·0020·0030·0031 | 2（A-01、A-02） | 发出 0 / 收到 3（C-01、B-01、C-02） | 发现 2 条契约不一致；C-01 质询中承认首轮豁免理由作废 |
| 2 | `bug-hunter-b@_auto_4b4be284…` | Bug Hunter B（集成与数据流） | COMPLETED | 调用链、definitions 复制、isError 三处消费、tool-log 脱敏、依赖方向、串行假设、兼容接口 | bug-hunting.md + AGENTS / CODING_STANDARDS / architecture / ADR-0003·0020·0021·0031 | 3（B-01、B-02、B-03） | 发出 0 / 收到 3（C-01、C-05、A-01） | 发现 B-01（shell 失败语义）等 3 条；确认 C-01 端到端配对断裂 |
| 3 | `bug-hunter-c@_auto_4b4be284…` | Bug Hunter C（边界与失败路径） | COMPLETED | 参数校验边界、Hook 边界、结果形状、取消/预算、失败恢复、测试遗漏 | bug-hunting.md + AGENTS / CODING_STANDARDS / ADR-0002 / behavior-verification | 5（C-01~C-05） | 发出 0 / 收到 3（A-02、B-01、B-02） | 发现 C-01（HIGH 级机制缺陷）等 5 条；三条议题全部 CONFIRM |
| 4 | `bug-hunter-a-x@_auto_4b4be284…` | A 交叉质疑（续跑） | COMPLETED | 仅针对 C-01 / B-01 / C-02 三个议题复核 | bug-hunting.md（沿用） | 0（不新增） | 发出 3 结论 / 收到 3 | 承认豁免作废；以 ADR-0002 判定 B-01 为既定设计 |
| 5 | `bug-hunter-b-x@_auto_4b4be284…` | B 交叉质疑（续跑） | COMPLETED | C-01 端到端配对、C-05、A-01 | bug-hunting.md（沿用） | 0（不新增） | 发出 3 结论 / 收到 3 | 补出 C-01 的两个必要条件与"第七条路径"；提供对照实验 |
| 6 | `bug-hunter-c-x@_auto_4b4be284…` | C 交叉质疑（续跑） | COMPLETED | A-02、B-01、B-02 | bug-hunting.md（沿用） | 0（不新增） | 发出 3 结论 / 收到 3 | 全部 CONFIRM；补出测试盲区与 `slice(0,100)` 静默丢元素 |
| 7 | `security-reviewer@_auto_4b4be284…` | Security Reviewer | COMPLETED | 信任边界、PreToolUse 绕过、日志敏感数据、子 Agent 隔离、失败折叠、命令/路径处理 | security-review.md + AGENTS / CODING_STANDARDS §11 / ADR-0008·0013·0019·0021 | 6（SEC-01~SEC-06） | 无（按设计不参与） | 6 条安全发现，**无 Blocking**；SEC-01 与 C-01 同源 |
| 8 | `voter-1@_auto_4b4be284…` | Voter（F-001~F-006） | COMPLETED | 6 条候选，独立实测 + 端到端复现 | finding-validation.md | 6 票 | 不参与 | F-001~F-005 CONFIRM、F-006 REJECT |
| 9 | `voter-2@_auto_4b4be284…` | Voter（F-001~F-006） | COMPLETED | 同上，独立实测 | finding-validation.md | 6 票 | 不参与 | 6 条全 CONFIRM，严重度普遍下调 |
| 10 | `voter-3@_auto_4b4be284…` | Voter（F-007~F-012） | COMPLETED | 6 条候选，独立实测 | finding-validation.md | 6 票 | 不参与 | F-009/F-010/F-011 CONFIRM；F-007/F-008/F-012 REJECT |
| 11 | `voter-4@_auto_4b4be284…` | Voter（F-007~F-012） | COMPLETED | 同上，独立实测 | finding-validation.md | 6 票 | 不参与 | F-007/F-009/F-011 CONFIRM；F-008/F-010/F-012 REJECT |
| 12 | `voter-5@_auto_4b4be284…` | 第三票（F-007、F-010） | COMPLETED | 2 条分歧项 | finding-validation.md | 2 票 | 不参与 | 两条均 REJECT |
| 13 | `voter-6@_auto_4b4be284…` | 第三票（F-006） | COMPLETED | 1 条分歧项 | finding-validation.md | 1 票 | 不参与 | REJECT（ADR-0025:34 已记录该限制） |

**统计（由本表汇总）**：实际创建 **13**；完成 **13**；失败 **0**；超时 **0**；取消 **0**。

---

## 6. Finding 来源账本

| Finding ID | 首次来源 | 首次阶段 | 交叉质疑 | Voter 结果 | 最终状态 |
|---|---|---|---|---|---|
| F-001 | Agent C（C-01）；SEC-01 同源 | 首轮 Bug Hunt | 是（A 撤销豁免、B 补必要条件） | v1 CONFIRM / v2 CONFIRM | **已确认（MEDIUM）** |
| F-002 | Agent B（B-01） | 首轮 Bug Hunt | 是（C 收敛表述、A 判既定设计） | v1 CONFIRM / v2 CONFIRM | **已确认（LOW）** |
| F-003 | Agent A（A-02） | 首轮 Bug Hunt | 是（C 确认 + 测试盲区） | v1 CONFIRM / v2 CONFIRM | **已确认（LOW）** |
| F-004 | Agent A（A-01） | 首轮 Bug Hunt | 是（B 确认零调用者） | v1 CONFIRM / v2 CONFIRM | **已确认（LOW）** |
| F-005 | Agent B（B-02）；SEC-02 同源 | 首轮 Bug Hunt | 是（C 补 `slice(0,100)`） | v1 CONFIRM / v2 CONFIRM | **已确认（LOW）** |
| F-006 | Agent B（B-03） | 首轮 Bug Hunt | 是（A 引 ADR-0025） | v1 REJECT / v2 CONFIRM / **v6 REJECT** | **已排除**（已知边界） |
| F-007 | Agent C（C-02）；SEC-04 同源 | 首轮 Bug Hunt | 是（A 判注释缺陷） | v3 REJECT / v4 CONFIRM / **v5 REJECT** | **已排除**（注释措辞） |
| F-008 | Agent C（C-03） | 首轮 Bug Hunt | 是 | v3 REJECT / v4 REJECT | **已排除** |
| F-009 | Agent C（C-04） | 首轮 Bug Hunt | 是 | v3 CONFIRM / v4 CONFIRM | **已确认（LOW）** |
| F-010 | Agent C（C-05） | 首轮 Bug Hunt | 是（B 改定性） | v3 CONFIRM / v4 REJECT / **v5 REJECT** | **已排除**（无可达触发） |
| F-011 | Security Reviewer（SEC-03） | SECURITY_REVIEW | 无 | v3 CONFIRM / v4 CONFIRM | **已确认（LOW）** |
| F-012 | Security Reviewer（SEC-05） | SECURITY_REVIEW | 无 | v3 REJECT / v4 REJECT | **已排除**（设计边界） |
| SEC-06 | Security Reviewer | SECURITY_REVIEW | 无 | **未投票**（见第 10 节） | **已排除**（ADR 已登记为已知缺口） |

**数量一致性核对**：原始候选 16 条 = Bug Hunt 10（A 2 + B 3 + C 5）+ 安全审查 6。去重合并 3 条（SEC-01→F-001、SEC-02→F-005、SEC-04→F-007），安全审查新增 2 条（F-011、F-012），排除 1 条（SEC-06）→ **唯一 finding 12 条**（10 + 2）。已确认 7 + 已排除 5 = 12 ✓。

---

## 7. 已确认问题（7 条）

### F-001｜后置 Hook 的上下文复制逃出故障隔离，导致工具已执行但结果丢失、Run 崩溃、会话 transcript 永久损坏、审计无记录

- **严重程度**：**MEDIUM**（*Important*）。**若部署环境默认开启 `AGENT_TOOL_LOG`，应升为 HIGH。**
- **发现者**：Agent C（C-01）；Security Reviewer 独立报为 SEC-01（同源）
- **独立验证**：voter-1 CONFIRM（MEDIUM）、voter-2 CONFIRM（MEDIUM）。三名 Hunter 中 C 与 B 判 HIGH、A 判 MEDIUM；两名 Voter 均判 MEDIUM，主 Agent 采纳 MEDIUM 并加升级条件。
- **代码位置**：
  - `src/core/tool-hooks.ts:86` — `cloneContext()` 用 `structuredClone`
  - `src/core/tool-hooks.ts:165` / `:172` — `await this.runQuietly(hook, { ...cloneContext(call, args), result })`：**`cloneContext` 是 `runQuietly` 的实参，在进入 `try`（`:177-183`）之前求值**
  - `src/core/tool-registry.ts:295`（成功链）/ `:300`（catch 内再跑失败链，同样不在自己的 `try` 内）
  - `src/core/agent.ts:724`（调 executeWithStatus）、`:725-726`（只放行 `ProcessCleanupError`，其余上抛）、`:761`（append assistant 早于 `:776` executeToolBatch）
- **问题证据**：`runQuietly` 的 `try` 只包住 `await hook(context)`，而 `cloneContext` 在实参位置求值，因此**复制失败不会被 fail-open 接住**。`tool-registry.ts:300` 在 catch 块内再次复制，第二次抛出即逃出 `executeWithStatus`。
- **触发条件**（三者同时满足）：
  1. 开启 `AGENT_TOOL_LOG`（`cli.ts:389` 恰好登记两个后置 Hook、且**无 `preToolUse`**）
  2. 模型某次调用带一个**未声明**的深层嵌套参数（默认非 strict 工具忽略未声明字段，能通过 Schema 校验）
  3. 嵌套深度超过 `structuredClone` 上限（受控测量 1896 层；`JSON.parse` 可解析 20 万层，**上界不受解析限制**）
- **实际影响**（三种装配、全部实测）：
  | 装配 | 后果 |
  |---|---|
  | 两个后置 Hook（= 生产 `AGENT_TOOL_LOG` 配置） | 工具已执行 → `RangeError` 逃出 → Run 中断；transcript 停在 `assistant(tool_calls)` 无对应 tool 结果；**下一次 `run()` 继续发送残缺历史**；日志零记录；`failureCount` 仍为 0 |
  | 仅 `postToolUse` | 不崩，但**已成功的调用被改写成 `ERROR: Maximum call stack size exceeded`**（`isError:true`），模型可能重试 → 重复副作用 |
  | 含 `preToolUse` | 执行前被 fail-closed 挡住（无副作用），但原因文案误报为 `"pre-tool hook failed; execution blocked"` |
- **对照实验（决定性）**：**不登记任何 Hook 时，1900 层深参数完全无害**（工具收到完整参数并返回真实结果）。证明缺陷由 Hook 机制自身引入，与深参数、与 `JSON.parse`、与参数校验无关。
- **违反的成文不变量**：`architecture.md`「Hook 自己出错不会把 Tool 变成失败，也不会修改 Transcript，只增加诊断计数」；ADR-0021「日志 Hook 抛错也只记 `ToolHooks.failureCount`」；ADR-0002「工具出错不许让程序崩」。
- **修复建议**：把 `cloneContext(...)` 移进 `runQuietly` 的 `try`（例如 `runQuietly(hook, () => ({...cloneContext(call, args), result}))`），或在 `runPostToolUse`/`runPostToolUseFailure` 内用 `try/catch` 包住复制并计入 `failures`；并在 `executeWithStatus` 的 catch 里对 `runPostToolUseFailure` 再包一层保护。**不要**改成"限制参数深度"——对照实验已证明那不是根因。补一条「后置 Hook 上下文复制失败」的用例。
- **最终状态**：**未解决**（Review Only 未修改代码）

---

### F-002｜shell 的非零退出 / 超时 / 运行中取消在 registry 层仍是 `isError:false`，走的是"成功"的 PostToolUse

- **严重程度**：**LOW**（两名 Voter 均从 MEDIUM 下调；定性由"行为缺陷"改为"文档/消费方不一致"）
- **发现者**：Agent B（B-01）
- **独立验证**：voter-1 CONFIRM（LOW）、voter-2 CONFIRM（LOW）。A 主张 REJECT（既定设计）。
- **代码位置**：`src/tools/workspace.ts:1272`（`run(...): Promise<string>`）、`:1372`（`status: stopped ?? \`exit ${code}\``）、`:1383`（返回 `${status}\n${output}`）；`src/core/tool-registry.ts:281`（字符串一律 `isError:false`）、`:292-296`（按 isError 二选一）；`src/core/tool-result-status.ts:20-28`；`eval/diagnostics.mjs:350`
- **问题证据**：三类终态都以**文本** resolve，不抛异常；registry 对字符串结果一律置 `isError:false`，于是走 `PostToolUse`。`PostToolUseFailure` 只对应"工具抛错"（`docs/adr/0020:19-20` 状态图为「↘ 抛错 → PostToolUseFailure」）。
- **触发条件**：`shell` 命令非零退出（如 `exit 3`）、前台超时、执行中被取消。
- **实际影响**：
  - 登记在 `postToolUseFailure` 上的 Hook 看不到 shell 最常见的三类失败；
  - `eval/diagnostics.mjs:350` 用 `isError ? "error" : "text"`，且**未复用** `isToolResultFailure`，把失败命令记成 `resultKind:"text"`，评测 trace 系统性少报失败；
  - `architecture.md:141-142` 用"成功/失败"命名这两个事件，与"`exit 3` 会进成功事件"的语义矛盾。
- **反例（候选原表述"永不触发"已收敛）**：`ProcessCleanupError`、启动前取消（`workspace.ts:1274`）、spawn 失败仍会正常走失败 Hook。
- **现状为何没有可见错误**：tool-log 自己在 Hook 内复用 `isToolResultFailure`（`tool-log.ts:114`），CLI/TUI 也显式传 `isError` 并重判（`cli-presenter.ts:219`、`tui.ts:3608`）。所以产品侧无错误输出，缺口落在"未来 Hook 作者"与 eval 工具链。
- **修复建议**：二选一并写进 ADR——(a) 让 shell 的 `run` 返回 `{content, isError}`（由 status 首行判定），根因在 `Workspace.run` 的返回形状，不在 registry 的归一化；(b) 维持"退出码是数据"，则把 `architecture.md` / `GLOSSARY` 的事件命名改准确，并让 `eval/diagnostics.mjs` 复用 `isToolResultFailure`。
- **最终状态**：**未解决**

---

### F-003｜PostToolUseFailure 的 `error` 在"结构化失败"时是 registry 合成的 Error，文档承诺是工具抛出的原始错误

- **严重程度**：**LOW**
- **发现者**：Agent A（A-02）
- **独立验证**：voter-1 CONFIRM（LOW）、voter-2 CONFIRM（LOW）
- **代码位置**：`src/core/tool-registry.ts:292-293`（`runPostToolUseFailure(call, args, new Error(result.content))`）；`src/core/tool-hooks.ts:43-50`（文档"工具抛出的原始错误"）；`src/tools/subagent.ts:443-447`（`isError: outcome.status !== "completed"`）
- **问题证据**：结构化失败时 registry 现造一个 `Error`，`message` 是已排版正文，`stack` 指向 `tool-registry.ts:293`。
- **触发条件**：`run_subagent` 子任务失败或取消（返回 `isError:true` 而非抛异常）。
- **实际影响**：按 `error instanceof XxxError`、`error.stack` 归因的 Hook 会静默失配；**测试盲区**——`test/subagent.test.mjs:453-465` 只断言事件名 `["PostToolUseFailure"]`，全文件无 `context.error` 断言。当前唯一消费者 tool-log 只用 `describeError(error)` 取文本，故无现网危害。
- **修复建议**：在 `PostToolUseFailureContext` 文档与 ADR-0020 状态图补上"工具返回 `isError:true`"这条分支，并写明此时 `error` 是合成错误；或给上下文加 `thrown: boolean`。
- **最终状态**：**未解决**

---

### F-004｜`ToolRegistry.execute()` 静默丢弃 `isError`，而多份权威文档仍称它是"唯一执行入口"且 Agent 调用它

- **严重程度**：**LOW**
- **发现者**：Agent A（A-01）
- **独立验证**：voter-1 CONFIRM（LOW）、voter-2 CONFIRM（LOW）
- **代码位置**：`src/core/tool-registry.ts:246-249`；`src/core/agent.ts:724`（实际调 `executeWithStatus`）；`docs/adr/0020:25`、`GLOSSARY.md:84`、`docs/architecture.md`
- **问题证据**：`execute()` 只 `return (await this.executeWithStatus(call)).content`。全仓 `src/` 内**零生产调用者**（唯一真实入口是 `agent.ts:724`）。ADR-0020:25 仍写「`Agent` 主循环……调用的仍然是 `this.tools.execute(call)`」，与代码不符。
- **触发条件**：新宿主按文档接 `execute()` + `isToolResultFailure(call, text)`（不传 isError）。
- **实际影响**：voter-1 实测四类失败（未知工具、坏 JSON、参数不合法、工具抛错）全部被 `isToolResultFailure` 判成**成功**。
- **修复建议**：把"唯一执行入口"统一改为 `executeWithStatus`（ADR-0020 §决定/§代价、GLOSSARY、architecture、文件头）；把大段注释挪到 `executeWithStatus` 上，并注明 `execute` 只是兼容包装、会丢 `isError`。
- **最终状态**：**未解决**

---

### F-005｜tool-log 的 `redact()` 与 ADR-0021「记录原文，不做脱敏」的决定矛盾，且脱敏覆盖不均

- **严重程度**：**LOW**
- **发现者**：Agent B（B-02）；Security Reviewer 独立报为 SEC-02（同源）
- **独立验证**：voter-1 CONFIRM（LOW）、voter-2 CONFIRM（LOW）
- **代码位置**：`src/core/tool-log.ts:50`（注释"对……凭据字段脱敏"）、`:51-65`（`redact`）、`:99-100`（调用点）；`docs/adr/0021-tool-log-is-opt-in.md`「敏感信息：记录原文，不做脱敏」节；`docs/configuration.md:85`；`test/tool-log.test.mjs` 中断言 `REDACTED` 的用例
- **问题证据**：脱敏由提交 `6e9ef2a "fix(logging): redact credentials from tool diagnostics"` 引入，**只改 `tool-log.ts`（+19/−2），未同步 ADR 与 configuration.md**。`redact` 只按 key 名正则 + `Bearer` 正则，而 `detail` 是纯字符串，只剩 `Bearer` 一条规则。
- **触发条件**：设 `AGENT_TOOL_LOG` 后 `read` 一个 `.env` 或执行 `printenv`。
- **实际影响（两个方向都实测成立）**：
  - 该脱的没脱：`OPENAI_API_KEY=…`、`DB_PASSWORD=…`、`AWS_SECRET_ACCESS_KEY=…` **原文落盘**；
  - 不该改的被改：同一行里的 `Authorization: Bearer …` 被替换成 `Bearer [REDACTED]`，日志不再是原文；
  - 另有 `depth>=8 → "[MAX_DEPTH]"`、数组/对象 `slice(0,100)` **静默丢弃且不留标记**，与同文件 `clip()` 的自我要求（"静默截断会让人以为日志里就这么多"）冲突。
  - 后果正是 ADR-0021 当初反对脱敏的理由：日志既不能当"原文日志"取证，也不能当"脱敏日志"使用；且读代码/读测试的人会误以为已有脱敏层，从而把日志放到弱权限位置。
- **修复建议**：二选一并写进 ADR——(a) 删除 `redact()`，回到"原文 + 受控路径"；(b) 保留脱敏但覆盖 `detail`（key=value / JSON 片段解析），并在 ADR 与 `configuration.md` 明确"尽力而为，不是保证"，同时给 `[MAX_DEPTH]` / `slice(0,100)` 加截断标记。
- **最终状态**：**未解决**

---

### F-009｜「工具返回非法执行结果」这个失败分支没有任何测试守着

- **严重程度**：**LOW**
- **发现者**：Agent C（C-04）
- **独立验证**：voter-3 CONFIRM、voter-4 CONFIRM
- **代码位置**：`src/core/tool-registry.ts:289-291`
- **问题证据**：`grep -rn "invalid execution result" test/` 零命中；`test/tool-registry.test.mjs` 所有 `run` 都返回字符串，无一命中该分支。而 `AGENTS.md:84` 明文把该缝的测试范围写成"每个失败分支都折成文本"。
- **触发条件**：工具返回 `undefined` / `null` / 数字 / `{content:123}` / `{content:"x",isError:"false"}` / `{content:"x",isError:false,isWaiting:"yes"}`。
- **实际影响**：当前实现正确（voter-3 实测全部折成 `ERROR: tool returned an invalid execution result` + `isError:true`），**零运行时影响**；风险是这条分支被放宽时无人变红，而它守的正是"工具返回奇怪形状时不许伪装成功"。
- **修复建议**：补一条用例，逐个断言这些形状得到该 ERROR 文本、`isError:true`，且 `run` 未被二次调用。
- **最终状态**：**未解决**

---

### F-011｜工具日志文件以默认权限创建（通常 0644），而仓库同类日志用 0600

- **严重程度**：**LOW**
- **发现者**：Security Reviewer（SEC-03）
- **独立验证**：voter-3 CONFIRM、voter-4 CONFIRM
- **代码位置**：`src/core/tool-log.ts:104`（`appendFileSync(file, …, "utf8")`，未传 `mode`）；对照 `src/tools/workspace.ts:1047-1048`（`openSync(logPath, "wx", 0o600)` + 注释"日志可能含敏感输出，POSIX 上只让当前用户读写"）；`src/core/context-archive.ts:74/98`、`src/ui/prompt-history.ts` 亦为 0600/0700
- **触发条件**：POSIX 多账户主机 + 默认 umask（022）+ 设了 `AGENT_TOOL_LOG`。
- **实际影响**：日志（含 shell 命令行可能带的 token、`write` 正文、`read` 命中的文件内容）默认对同机其他本地账户可读。按 ADR-0008/0019「本地可信用户」威胁模型，这不是越权，而是**纵深防御缺口 + 仓库内口径不一致**。
- **修复建议**：`appendFileSync(file, line, { encoding: "utf8", mode: 0o600 })`（已存在文件需另处理），或与 workspace 一致用 `openSync("wx", 0o600)`。
- **最终状态**：**未解决**

---

## 8. 已排除的问题（5 条 + 1 条安全项）

| ID | 主张 | 排除理由 |
|---|---|---|
| **F-006** | 父子 Agent 共用 `AGENT_TOOL_LOG`、无角色字段、id 可能撞车 | **已知边界**：`docs/adr/0025-subagent-uses-fresh-agent-instance.md:34` 逐字记录「`AGENT_TOOL_LOG` 的记录不区分父子，排障时要结合时间顺序看」；`cli.ts:387` 注释说明共用同一文件是刻意设计；委派不并行，时间顺序 workaround 可用。voter-1 REJECT / voter-2 CONFIRM / **voter-6 REJECT** → 排除 |
| **F-007** | `readBlockReason` 对非对象返回值静默放行，违反 fail-closed | **代码自洽，仅注释措辞**：`{block}` 三态与类型 `PreToolUseDecision`、三条细则、测试一致；fail-closed 的适用范围是"抛错"而非"返回奇怪形状"。`src/` 下无任何 `preToolUse` 登记，生产影响为零。voter-3 REJECT / voter-4 CONFIRM / **voter-5 REJECT** → 排除（建议打磨 `tool-hooks.ts:92` 一句注释） |
| **F-008** | `clip()` 裸切 UTF-16 会切断代理对 | 契约（`docs/contracts/behavior-verification.md:9`）的权威来源与验证入口都不含 `tool-log`；仓库另有 8 处同类裸切（`llm.ts:296`、`subagent.ts:333`、`workspace.ts:984` 等）；影响仅为日志可读性，JSONL 仍合法。voter-3 REJECT / voter-4 REJECT → 排除（可作为一致性清理） |
| **F-010** | `failureCount` 无人读取，Hook 失败不可观测 | 事实成立（`src/` 零读取者），但**生产装配下无可达抛错路径**：唯一 Hook 用户 tool-log 的 `append()` 自带 `try/catch`，args 来自 `JSON.parse` 不会成环或含 BigInt；ADR-0021 已把"只记 failureCount"写成不变量。voter-3 CONFIRM / voter-4 REJECT / **voter-5 REJECT** → 排除（可作 backlog 增强） |
| **F-012** | 注册期接受但运行期不校验 `enum`/`pattern`/`additionalProperties` 等关键字 | **设计边界且文档自陈**：`tool-registry.ts:137` 写明"只覆盖真正用到的子集"，`:143` 承诺的是拒绝不支持的 **type**（已兑现）；`grep` 确认内置工具零使用；未声明字段另有 `strictArguments` 正路。voter-3 REJECT / voter-4 REJECT → 排除 |
| **SEC-06** | 被拒绝的调用（未知工具/坏 JSON/参数不合法/被拦）不进日志 | ADR-0021「已知缺口」节明文登记「被前置 Hook 拦下的调用不留记录」；且当前无任何策略 Hook，无实际暴露。**未走 Voter**（见第 10 节） |

---

## 9. 安全审查结果

- **Security Review Status: COMPLETED**
- **结论：在当前「本地可信用户 + 完全访问」（ADR-0008/0019）威胁模型下，不存在阻断级安全问题。无 `Blocking: YES` 项。**
- 6 条发现中：SEC-01 与 C-01 同源（已合并为 F-001）、SEC-02 与 B-02 同源（已合并为 F-005）、SEC-04 与 C-02 同源（已合并为 F-007）、SEC-03 → F-011、SEC-05 → F-012、SEC-06 排除。
- Security Reviewer 明确确认**不构成漏洞**的项（避免噪音）：shell 任意执行与无工作区边界（ADR 明确设计）、explore 子 Agent 只读隔离（工具表无 shell/write，无法绕过）、`run_subagent` 参数校验完整、`ProcessCleanupError` 传播正确、模型输出 `ToolCall` 逐字段校验、`__proto__` 无原型污染路径、后台日志 0600 独占创建、grep ReDoS 已隔离、日志路径不校验属已接受。

---

## 10. 流程异常

| # | 异常 | 影响 | 是否纠正 | 是否影响结论 |
|---|---|---|---|---|
| 1 | **交叉质疑通道切换**：首轮 Agent 全部完成后 `SendMessage` 返回 `Not in a team`，无法直接给已结束的 Agent 发后续消息 | 交叉质疑无法用原定方式发起 | 是。改用 `Agent(resume=原 agent_id)` 续跑，成功执行 3 组 × 3 议题的定向质询 | 否。协作阶段确实完成，标注为 `COORDINATOR_RELAY` |
| 2 | **resume 未继承原上下文**：C-x 续跑后读到的是陈旧快照 `C:\Users\Administrator\AppData\Local\Temp\ak-main`（2026-11-16，`tool-registry.ts` 277 行 vs 真实 305 行），行号整体偏移 30–45 行 | 其引用行号一度不可对齐 | 是。C-x 自查后切回 76a024a 并作废旧行号；**最终报告中所有行号均由主 Agent 在真实仓库逐条核对** | 否（语义结论一致，仅行号需重映射） |
| 3 | **阈值数据三方不一致**：C-x 报"JSON.parse 1900 抛"、B-x 报 1350、主 Agent 受控测量 1896 | 报告数字可能被质疑 | 是。C-x 自查发现是把 `JSON.stringify` 失败误记为 parse；最终按"约 1300–1900 层，随栈深度浮动，上界不受 parse 限制"表述 | 否 |
| 4 | **审查期间工作区被外部修改**：09:05–09:07 出现 `docs/README.md`、`eval/README.md`、`eval/baseline.md` 的未提交改动，以及未跟踪的 `docs/reviews/2026-11-20-eval-baseline.md`、`eval/baselines/2026-11-19-checkers-v2/`（审查开始时工作区是干净的） | 属他人/其他会话改动，**全部在本次审查模块之外** | 未触碰、未 stash、未回滚；如实记录 | 否 |
| 5 | **SEC-06 未走 Voter 流程** | 违反"每条候选默认 2 票"的默认流程 | 未补票。理由：ADR-0021 已将其明文登记为已知缺口，属"文档已接受的边界"，非缺陷主张。**此处如实标注为流程偏差** | 否（该条结论为排除，方向不受影响） |
| 6 | 提前引用未返回 Agent 的结论 | 无 | — | 否。主 Agent 在 A、B 返回前只汇报了已返回者，未替未返回 Agent 填写结论 |
| 7 | 报告数量与账本不一致 | 无 | — | 否。已核对：13 Agent 全部 COMPLETED；16 原始候选 → 12 唯一 finding（7 确认 + 5 排除） |

**没有发生**：未经授权的 Git 写操作、Agent 失败/超时、数量不一致、受限模式被写成完整模式。

---

## 11. 测试与验证结果

| 检查项 | 实际命令 | 结果 | 说明 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | **PASS** | `tsc --noEmit`，strict，无输出 |
| 架构依赖检查 | `npm run architecture:check` | **PASS** | 28 个源文件、70 条内部依赖，依赖方向未被违反 |
| 单元/集成测试 | `npm test` | **PASS** | 714 用例：700 通过 / 0 失败 / 14 跳过 / 32s |
| 子 Agent 复跑（相关文件） | `node --test test/tool-hooks|tool-log|tool-registry|subagent` | **PASS** | 81 项全绿（voter-1、voter-2 各自独立复跑） |
| Lint | — | **NOT RUN** | 仓库无格式化器/Lint 脚本（`CODING_STANDARDS.md` §10「没有格式化器」），`npm run check` = typecheck + test |
| 构建 | — | **NOT RUN** | 项目为纯 TS 直跑（`node src/cli.ts`），无构建步骤 |
| 端到端（Agent 循环） | 主 Agent 自写探针 + 真实 `Agent`/`ToolRegistry`/`createScriptedChat` | **PASS（复现缺陷）** | 复现 F-001 三条分支与对照实验，脚本写在系统临时目录，未落仓库 |
| `npm run agent` / `npm run eval` | — | **NOT RUN** | 需要 API Key 且会产生费用，按约束不执行 |

---

## 12. 修复与复审记录

| 轮次 | 本轮检查内容 | 新发现 | 修复内容 | 复审结果 |
|---|---|---:|---|---|
| 第 1 轮 | 全模块（Tool Registry / Tool Execution） | 10（Bug Hunt）+ 6（安全） | **无**（Review Only） | 首轮结论冻结 |
| 第 2 轮 | 交叉质疑：9 个定向议题 | 0 条新 finding，4 处结论修正 | 无 | C-01 根因上移并补对照实验；B-01 表述收敛；A 撤销首轮豁免 |
| 第 3 轮 | 独立投票 + 三处分歧追加第三票 | 0 | 无 | 12 条候选全部裁定：7 确认 / 5 排除 |

**共 3 轮，未超出"最多三轮"限制，且未启动第四轮。**

**Review Only 模式：未修改任何代码。** 本轮未执行任何修复，故无回归测试需要运行；基线测试已在审查开始时全部通过。

---

## 13. Git 操作记录

- 模式：**Review Only**
- `git add`：**否**
- `git commit`：**否**
- `git push`：**否**
- 创建分支：**否**
- 创建 PR：**否**
- merge / rebase / reset / clean / stash：**否**
- 用户明确授权来源：无（未请求授权）

只执行了只读命令：`git rev-parse`、`git log`、`git status`、`git show --stat`、`git diff --stat`。

---

## 14. 剩余风险与开发者需要知道的事

### 需要处理（按优先级）

1. **F-001（建议优先修）**：把 `cloneContext` 移进 `runQuietly` 的 `try`。在修复前，**若部署中默认开启 `AGENT_TOOL_LOG`，建议视为 HIGH 并先关闭该开关**——触发后会话 transcript 不可自愈，只能重开会话。
2. **F-005**：先决定"到底要不要脱敏"，再让 ADR-0021 / `configuration.md` / 代码 / 测试四方一致。当前是"半脱敏 + 声称已脱敏"，这是最差的一种状态。
3. **F-004**：把 ADR-0020 / GLOSSARY / architecture 里的"唯一执行入口 = `execute`"改正为 `executeWithStatus`，避免新宿主踩坑。
4. **F-002 / F-003 / F-009 / F-011**：低成本收尾（事件语义文档、Hook 上下文契约、补一条测试、`mode: 0o600`）。

### 证据不足 / 未验证事项

- **真实模型是否可能自发产出 1300+ 层嵌套参数**：只证明了"给定这种输入，代码路径必崩"，无法证明触发概率。这是 F-001 严重度定在 MEDIUM 而非 HIGH 的主要原因（若考虑提示注入场景，应上调）。
- **真实 OpenAI 兼容端点是否确实以 400 拒绝残缺 transcript**：只验证了残缺历史确实被发出，未对真实端点验证。
- **F-002 的"运行中取消"**：voter-1 仅做代码路径确认，未用真实 `AbortSignal` 实测。
- **F-011 的权限位**：Windows 环境无法实测 POSIX 权限，结论基于 Node `0o666 & ~umask` 语义与仓库内 0600 对照。
- **F-006 的 id 撞车概率**：取决于 provider 的 id 生成策略（随机 id 基本不会撞，序号式会）——但该条已因 ADR 记录而排除。

### 需要开发者决定的产品/架构事项

1. **`exit 3` 到底算不算"工具失败"**？这决定了 F-002 修在 `Workspace.run` 的返回形状，还是修文档。本次审查中两名 Hunter 与两名 Voter 在此分歧，最终按"既定设计 + 文档缺口"（LOW）收敛，但这是**产品口径问题**，应由你拍板。
2. **Hook 的失败事件是否应覆盖"进程退出码"这类语义失败**？若 PreToolUse 将来被用作策略层，这个缺口会变成"策略看不见最常见的失败"。
3. **日志脱敏的取舍**：ADR 当初拒绝脱敏的理由（半吊子脱敏会让日志在最需要时失去取证价值）已被现状证实，是回滚还是补全，需要决策。

### 外部动作提醒

- 本次审查**不代表已合并、发布或部署**。
- 仓库中他人未提交的 `docs/`、`eval/` 改动仍在原处，未被本次审查触碰。
- CI 分支保护、部署与回滚不在本 Skill 保证范围内。

---

## 15. 最终说明

本次审查严格按 `multi-agent-code-review` 流程执行：**真实创建了 13 个独立上下文子 Agent**（3 个 Bug Hunter 并行 → 3 组定向交叉质疑共 9 个议题 → 6 个 Voter 含 3 次分歧裁决 → 1 个独立 Security Reviewer），13 个全部 `COMPLETED`，无失败无超时。

三个 Bug Hunter 从行为、集成、边界三个角度独立找问题，交叉质疑阶段产生了 4 处实质修正——最有价值的一处是 **A 主动撤销了自己首轮的豁免理由**：它原本认为"cloneContext 在 try 外"只有工具改写 args 才会出问题，C 用"参数深度"这个触发源推翻了这个前提，B 又补出两个必要条件，最终由对照实验（无 Hook 时深参数完全无害）把根因钉死在 Hook 机制自身。

**结果**：16 条原始候选 → 12 条唯一问题 → **7 条确认（1 MEDIUM + 6 LOW）、5 条排除**，安全审查无阻断项。714 个测试、类型检查、架构检查全部通过。**没有发现 Critical/High 阻断问题**，模块整体可以放行；但 F-001 是一个"触发条件苛刻、后果不可逆"的机制缺陷，建议在开启 `AGENT_TOOL_LOG` 的部署中先修。

**状态：PASS WITH WARNINGS。** 未修改任何代码（Review Only），是否需要修复由你决定。

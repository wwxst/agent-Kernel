# 编码规范

本文件是规范本体。`AGENTS.md` 是地图，`README.md` 是导览，`GLOSSARY.md` 是词汇，`docs/adr/` 是决策记录。
规矩只在写一处；别处给指针。两份文件说法冲突时，以本文件为准。

适用范围：`src/` 与 `test/` 下的代码，以及仓库里的文档。

## 1. 语言分层

| 位置 | 语言 | 理由 |
| --- | --- | --- |
| 源码注释 | 中文 | 读者是中文母语的学习者，注释要能当教材读 |
| 标识符（类、函数、变量、文件） | 英文 | 跟上生态，方便与协议字段对照 |
| 运行时字符串（系统提示词、工具 description、`ERROR:` 文本） | 英文 | 模型协议相关文案必须稳定、通用，不混入角色语气 |
| CLI 用户可见的角色台词 | 中文 | 只供展示，不进模型请求或 Transcript；便于中文用户理解情绪状态 |
| 测试名 | 中文 | 测试名是规格，和注释同源，读起来是「什么情况下发生什么」 |
| 提交信息 | 英文，Conventional Commits | `feat(agent): …`、`refactor(workspace): …`、`docs: …` |
| 文档 | 中文，术语保留英文原词 | Kernel、ToolRegistry、Transcript 这类词不翻译 |

## 2. 教学式注释

注释的目标：下一个读代码的人（或模型）看完之后**不需要再问「为什么」**。

1. **文件头讲「为什么存在」**：这个模块解决什么问题、它和邻居怎么分工。不要列函数清单 —— 那是代码自己会说的事。
2. **导出符号先给一句「它是什么」**，再补「为什么长成这样」。
3. **非显然的决定写「不这样会怎样」**：把踩过的坑固化下来，让下一个人不重踩。
4. **注释解释意图、权衡、边界，不复述语句**。`// 遍历工具列表` 是零信息的译文，删掉。
5. **改行为时，同一次改动里改注释**。过期的注释比没有注释更贵。
6. **领域词用 `GLOSSARY.md` 的写法**；缩写第一次出现时展开。
7. **已知边界用固定句式**「已知边界：……」，放在它约束的那段代码旁边。
8. **给出生态锚点**：在实现旁边一句「这就是 X」，把代码钉到读者已经知道的概念上。读的人认出熟悉的东西，比读一段自造术语的解释快。一个概念只钉一次，钉在它实现的地方；别处用 `GLOSSARY.md` 里的短名带过（`Step`、`Tool call`），不再解释一遍。
9. **英文文案配中文对照**：给模型或终端看的英文（系统提示词、工具 `description`、参数说明）在源码里逐行给出中文翻译，放在英文那一行的正上方；中文只留在源码里，不进运行时。读者不需要会英文，也能看懂 agent 到底被交代了什么。

锚点对照（写注释、写文档时从这里取名字）：

| 代码 | 生态里的名字 |
| --- | --- |
| `Agent.run()` 里的循环 | **agent loop**，教科书里的 `while (true)` |
| `tool_calls`、`Tool`、`ToolRegistry` | **function calling** |
| `shell` 工具 | **bash** —— 跑命令的那个工具 |
| `Workspace` | 文件工具的工作区根目录，**不是安全边界**（见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)） |
| `Permission` | **策略**，不是 **Sandbox**：只决定一次 Tool call 放不放行（见 [ADR-0013](./docs/adr/0013-permission-is-a-policy-not-a-sandbox.md)） |

写法就是一句判断句：`// 这就是 agent loop：教科书里那个 while (true)，外加一道步数闸门。` 不要写成「本系统的 XXX 模块负责……」。

正例（解释为什么，且给出了不这样写的后果）：

```ts
// relative 为空 = 就是根目录本身；以 ".." 开头 = 跑到了根目录外面；
// 返回绝对路径 = 换了盘符（Windows 上 "D:\x" 相对 C:\root 就是这种情况）。
if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
```

反例（复述代码，还看不出为什么这么写）：

```ts
// 检查相对路径是否以 .. 开头
if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
```

衡量标准：把这条注释删掉，读代码的人会不会停顿、会不会问「为什么」。会，就留着；不会，就删。

## 3. 模块形状

- **一个文件一个模块，一个改动理由**。两个不相关的原因同时要改这个文件，说明该拆了。
- **接口尽可能小**：能私有就私有。`Workspace.resolve`、`assertInsideWorkspace`、`clip` 是私有的，所以测试打在 `read` 上，而不是打在工具函数上。
- **深模块**：大量行为藏在小接口后面。判据是删除测试 —— 删掉它，复杂度是消失了（说明是空壳），还是散回调用方（说明它在干活）。
- **两种实现才开接口**：`ChatClient` 有 `Llm` 和测试里的假客户端，所以是接口；`ToolRegistry`、`Workspace` 只有一种实现，直接是类。
- **依赖方向单向**：`cli → {agent, tool-registry, workspace, llm} → types`。`agent` 不认识 `workspace`，`types` 是叶子。
- **不为「以后可能」加参数、回调、抽象层**。等第二个调用者出现再说。

## 4. 命名

**总则：先找生态里已有的名字。** 命名要回答的是「一个熟悉 OpenAI SDK 和 coding agent 的开发者，能不能一眼看懂」，而不是「这个名字能不能准确描述我们内部是怎么实现的」。自造词只在这个概念确实没有生态名字时才用，并且必须在 `GLOSSARY.md` 里定义。

改名之前先做一次检索：这个概念在 OpenAI / Anthropic 的文档、主流 SDK（AI SDK、LangChain）、MCP 规范里叫什么？有共识就照抄，没共识再自己起。

- 领域概念用 `GLOSSARY.md` 的词，不用 `_Avoid_` 列出的同义词。
- 工具名跟 agent 生态走（`read` / `write` / `edit` / `glob` / `grep` / `ls` / `shell`），见 [ADR-0005](./docs/adr/0005-name-tools-after-the-ecosystem.md)。
- 工厂用 `createX`（`createWorkspaceTools`）；缺了动词的函数名读起来像变量。
- 文件名小写单词或连字符；类 PascalCase；函数与变量 camelCase；模块级常量 SCREAMING_SNAKE。
- 动词开头表示行为（`resolve`、`truncate`、`execute`），名词表示数据（`Message`、`ToolRegistry`）。
- 缩写只留生态通用的（`ls`、`env`、`json`）。自造的缩写（`msg`、`cfg`、`mgr`）展开。

### 判例

| 旧名 | 新名 | 依据 |
| --- | --- | --- |
| `read_file` / `list_dir` / `run_command` | `read` / `ls` / `shell` | Claude Code、Codex 这类 agent 里反复出现的工具名，模型对它们有先验 |
| `ToolSpec` | `ToolDefinition` | OpenAI / Anthropic / MCP 的文档一律叫 "tool definition"；`spec` 是 OpenAPI 的行话 |
| `Toolbelt` | `ToolRegistry` | 生态里管这个叫 tools / toolkit / registry；`toolbelt` 是自造的比喻 |
| `workspaceTools()` | `createWorkspaceTools()` | TS 生态的工厂一律 `createX` |
| `dispatch()` | `execute()` | 执行工具在生态里叫 execute / call / invoke；`dispatch` 是事件总线用语 |

**允许保留的自造词**：`Kernel`、`Transcript` —— 项目里有精确含义、生态里又没有公认名字，靠 `GLOSSARY.md` 里的定义获得合法性。命名靠词表，不靠代码里临时起意。

## 5. 错误处理

两类错误，两个归属，别混：

| 层 | 失败时 | 为什么 |
| --- | --- | --- |
| `Workspace` | 抛异常 | 调用方是宿主代码，抛出去就是这次操作的失败 |
| `ToolRegistry.execute` | 折成 `ERROR: …` 文本 | 调用方是模型，它靠文本自我纠正 |

- 新增工具**不要自己 `try/catch` 折文本**：走 `execute` 就自动有了。规矩只在一个地方实现（[ADR-0002](./docs/adr/0002-fold-tool-failures-into-error-text.md)）。
- `ERROR` 文本要能指导下一步：带上原始值、可用选项，例如 `ERROR: unknown tool "x" (available: read, write)`。
- 宿主进程失败用 `process.exitCode = 1`，不用 `process.exit(1)`：Windows 上 fetch 的 keep-alive 连接没关时强退会触发 libuv 断言。
- 工具串行是有意的（[ADR-0003](./docs/adr/0003-run-tool-calls-serially.md)），不要顺手改成 `Promise.all`。

## 6. 类型与运行时

- `strict` 全程开着；`any` 只出现在边界校验的 `unknown` 收窄处。
- `verbatimModuleSyntax`：类型导入写 `import type`；相对导入写全 `.ts` 后缀。
- `erasableSyntaxOnly`：不用 `enum`、不用构造器参数属性、不用 `namespace`。联合类型 + `as const` 对象代替 `enum`。
- **运行时零依赖**（[ADR-0004](./docs/adr/0004-zero-runtime-dependencies.md)）：新能力先用 Node 内置（`fetch`、`fs/promises`、`child_process`、`node:test`）。加依赖要说明内置做不到什么。
- 测试用 `node:test` + `node:assert/strict`，不引测试框架。

## 7. 测试

- **打在缝上**：`Agent.run`、`ToolRegistry.execute`、`Workspace` 的七个方法、`Llm.chat`、CLI 进程。五处都有现成用例可参照。
- **断言外部行为**，不测私有函数，也不 mock 自己的模块。只有跨缝的外部依赖才用替身：`ChatClient` 的假实现、mock HTTP 服务。
- **期望值写死字面量**，不要用被测代码算出来（同义反复的测试永远绿，也永远没用）。
- 一个用例钉一件事；测试名写「什么情况下、发生什么」。
- **e2e 只验证组装**：环境变量、退出码、stdout、请求体形状。循环细节留在单元层。
- 新行为先红后绿（`tdd` 技能）。重构不属于红绿循环，它发生在复查阶段。

## 8. 仓库结构

- 源码扁平放 `src/`，一个文件一个模块。出现三个以上强相关文件时，才考虑建子目录。
- 测试扁平放 `test/`，共享夹具进 `test/support/`。
- 根目录只留 `README.md`、`AGENTS.md`、`GLOSSARY.md`、`CODING_STANDARDS.md`；其余文档进 `docs/`。
- 技能装 `.agents/skills/`，保持上游原样，不就地改；要改就先装成自己的技能。

## 9. 文档分工

| 文件 | 给谁 | 什么时候改 |
| --- | --- | --- |
| `README.md` | 人 | 功能、用法、结构变了 |
| `AGENTS.md` | agent | 命令、代码地图、入口变了 |
| 本文件 | 人与 agent | 规范本身变了 |
| `GLOSSARY.md` | 双方 | 领域词定下来时 |
| `docs/adr/` | 双方 | 难反转 + 反直觉 + 真有取舍，三条都满足时 |
| `docs/agents/` | agent | tracker、分诊、领域文档的约定变了 |

## 10. 格式与提交

- 没有格式化器：改动保持最小 diff，不重排无关行，不顺手改引号或缩进。
- 提交信息用英文 Conventional Commits，一次提交一件事。
- 不提交 `node_modules/`、`.env`、日志。

## 11. 防御性编程

一句话原则：**Fail Explicitly, Never Fail Silently** —— 失败要明确、可观察；宁可报错，不可假装成功。

### 五类治理

| 类别 | 要求 | 落在哪 |
| --- | --- | --- |
| 输入 | 跨信任边界的输入一律不可信：必填、类型、格式、路径、网络响应 | `ToolRegistry.execute`（参数 schema）、`Workspace.resolve` + `assertInsideWorkspace`、`Llm.chat` → `readMessage` |
| 异常 | 预期异常有归属；未知异常也有非空兜底文案 | `describeError`、`ToolRegistry.execute`、`cli` |
| 错误 | 可恢复 / 致命 / 部分成功，三类分开处理 | 见下 |
| 资源 | 读取、输出、进程、时间都要有上限 | `MAX_*` 常量、`clip`、超时 + 进程树 |
| 状态 | 失败不留半截状态；只读接口返回副本 | `edit` 先校验再写、`transcript` 深拷贝 |

### 三类错误

1. **可恢复**：折成 `ERROR: ...` 文本回灌给模型 —— 文件不存在、参数不合法、工具不存在、片段对不上。模型据此调整下一步。
2. **致命**：抛出去，由 CLI 收口、非零退出 —— 缺 API Key、模型服务不可用、内核无法继续。
3. **部分成功**：必须报告缺了什么 —— `grep` 跳过的文件、`glob`/`list` 的截断、`shell` 丢弃的字符、`read` 读到的字节上限。

归属规则：**工具层只产出文本，宿主层只抛异常**（[ADR-0002](./docs/adr/0002-fold-tool-failures-into-error-text.md)）。

### 禁止事项

- 返回空的错误文本（`ERROR: ` 后面什么都没有）。
- 把类型断言（`as`）当成运行时校验：网络响应、用户输入都必须按字段逐个检查。
- 无声吞掉异常（`catch { continue }` 必须留下计数，并写进结果）。
- 用默认空值掩盖必填参数缺失（`String(args.content ?? "")`）。
- 失败后返回看起来成功的结果。
- 部分失败不报告。
- 无限消耗资源（整文件读入、无限收集输出、无超时）。
- 把未校验的外部输入直接用于危险操作（路径、命令）。

### 防止过度防御

- 一条校验只写在一个地方：参数在 `execute`、路径在 `Workspace`、错误文案在 `describeError`。别在调用点再抄一遍。
- 只校验**跨信任边界**的输入（模型 → 宿主、用户 → 程序）；内部函数之间已经保证过的东西不重复校验。
- 兜底文案只保证「非空且可区分」，不负责把未知异常猜成具体原因。

## 复查清单

- [ ] 新增的注释解释的是「为什么」；删掉它会不会有人停顿？
- [ ] 新导出符号的接口还能不能再小；能不能直接私有？
- [ ] 失败走的是异常还是 `ERROR` 文本，跟它所在的那一层一致吗？
- [ ] 新测试打在已有的缝上；期望值有独立来源吗？
- [ ] 新错误路径有非空文案吗？`catch` 是记账还是无声吞掉？
- [ ] 部分失败（截断、跳过、读不了）在结果里报告了吗？
- [ ] 需要动 `GLOSSARY.md` 或补一条 ADR 吗？
- [ ] `npm run check` 绿。

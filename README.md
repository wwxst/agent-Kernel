# agent-Kernel

最小 Coding Agent：**一个类、一个循环、七个工具**，运行时零依赖。

> 当前状态：v0.4，个人练习项目。

## 快速开始

需要 Node.js **>= 22.18**（从 22.18 起可以直接 `node xxx.ts`，靠内置的 type stripping，不需要构建）。

```powershell
Copy-Item .env.example .env    # 填入 API_KEY；用什么模型由你决定
npm run agent -- "给这个仓库加一个 /health 接口并写测试"
```

`npm install` 只在跑类型检查和测试时需要；`npm run agent` 本身不需要任何依赖。

## 代码结构

七个模块，依赖只有一个方向，叶子是两个不依赖任何人的模块（`types.ts`、`errors.ts`）：

| 文件 | 一句话 |
| --- | --- |
| `src/types.ts` | 协议词汇：`Message`、`Tool`、`ToolDefinition`、`ChatClient`。不依赖任何人 |
| `src/errors.ts` | 错误文案兜底：`describeError()` 把任何抛出物变成一行非空文本 |
| `src/agent.ts` | 内核：循环、消息顺序、请求/工具预算、生命周期。只认 `ChatClient` 和 `ToolRegistry` |
| `src/tool-registry.ts` | 工具注册表：Schema 校验、按名字找工具、解析参数、把失败折成 `ERROR` 文本 |
| `src/workspace.ts` | 工作区：文件工具作用的那棵目录树 —— 读、写、改、找文件、搜内容、列目录、跑命令，外加路径守卫、有界读取、扫描预算与取消 |
| `src/llm.ts` | `ChatClient` 的 HTTP 实现，POST 一个 OpenAI 兼容端点并保留 `usage` |
| `src/cli.ts` | 组装层：环境变量 → 对象图 → 跑一次任务 |

`agent.ts` 不认识 `workspace.ts`：循环只管「问模型、执行调用、塞回结果」，工具怎么实现的它不关心。
这就是为什么换模型、换工具集，循环一行都不用改。

命令、代码地图、测试放哪见 [AGENTS.md](./AGENTS.md)；怎么写代码（注释风格、模块形状、命名、错误处理）见 [CODING_STANDARDS.md](./CODING_STANDARDS.md)。

## 核心循环

`src/agent.ts` 里的 `Agent.run()`，对应设计稿里的伪代码。它就是 **agent loop** —— 教科书里那个 `while (true)` 的原型，外加三道闸门：模型请求次数、工具执行次数、取消信号。

```ts
this.messages.push({ role: "user", content: task });

for (let step = 1; step <= this.maxSteps; step++) {
  const response = await this.llm.chat(this.messages, this.tools.definitions);
  this.messages.push(response.message);

  const calls = response.message.tool_calls ?? [];
  if (calls.length === 0) return response.message;

  // 最后一步 / 工具预算 / token 预算：不执行无法被后续请求验证的工具。
  stopIfNoBudgetLeft(step, calls);

  for (const call of calls) {
    const result = await this.tools.execute(call);
    this.messages.push(createToolResult(call, result));
  }
}
```

逐段理解：

1. **消息就是全部状态。** 模型无状态，它「记得」什么，完全取决于我们每轮重发多少。
2. **先入栈，再判断。** 带 `tool_calls` 的 assistant 消息必须先写进历史，工具结果才能跟在它后面。
3. **`tool_call_id` 是配对钥匙。** 每条 tool 消息靠它说明自己在回应哪一次调用，写错直接被 API 拒绝。
4. **没有工具调用 = 交卷。** 这就是循环唯一的正常出口。
5. **工具错误也要「入栈」。** 失败被折成 `ERROR: ...` 文本，模型下一轮能看见并自己纠正。
6. **两个执行预算分开算。** `maxSteps` 数「问了模型几次」，`maxToolCalls` 数「真正跑了几个工具」。一次回复可以要 3 个工具，只用一个数字会假装管住了另一个。
7. **最后的请求预算留给收尾。** 走到第 `maxSteps` 次请求时，模型只能给最终答复；它还要工具，那些工具不执行 —— 没有下一次请求去验证结果，执行了就是一批「跑过但没人看过」的副作用。
8. **一个实例只跑一次。** 第二次 `run()` 直接抛生命周期错误，不继承上一条 transcript；失败或取消后也一样。

## 与设计稿的对应

| 设计稿 | 本实现 |
| --- | --- |
| `llm.chat(messages, tools)` | `Llm.chat()`，POST `{BASE_URL}/chat/completions`（OpenAI 兼容） |
| `executeTool(call)` | `ToolRegistry.execute(call)`：工具表在对象里，不再是到处传的全局变量 |
| `createToolResult(call, result)` | `{ role: "tool", tool_call_id: call.id, content: result }` |
| `while (true)` | `for` + `maxSteps` |

字段名保留协议原样（`tool_calls`、`tool_call_id`），请求体可以原样序列化，不需要来回翻译。这个选择记在 [ADR-0001](./docs/adr/0001-keep-wire-field-names.md)。

## 七个工具

工具名是模型看到的接口，所以用的是 agent 生态里的通用叫法（`read` / `write` / `edit` / `glob` / `grep` / `ls` / `shell`），不是本仓库方法名的直译：

| 工具 | 说明 | 对应工作区方法 |
| --- | --- | --- |
| `read` | 读 UTF-8 文本，超过 8k 字符截断 | `Workspace.read` |
| `write` | 创建/覆盖整个文件，自动建父目录 | `Workspace.write` |
| `edit` | 把唯一命中的一段换成另一段 | `Workspace.edit` |
| `glob` | 按模式找文件，如 `src/**/*.ts` | `Workspace.glob` |
| `grep` | 按字面文本搜文件内容，回 `路径:行号: 内容` | `Workspace.grep` |
| `ls` | 列目录：类型、字节数、名称 | `Workspace.list` |
| `shell` | 在工作区根目录跑 shell；超时/取消杀整棵进程树，输出有上限 | `Workspace.run` |

前三个是「改文件」，中间两个是「找东西」，`ls` 看一层目录，`shell` 是兜底。模型先找后改，顺序和它自己的直觉一致。

`write` 和 `edit` 的分工就是名字说的那件事：改几行用 `edit`（省 token，也不会因为「只改三行却重写整个文件」把长文件改坏），新建文件或整体重写才用 `write`。

`edit` 要求 `old_string` 恰好命中一次：0 次或多次都回 `ERROR`，模型读一遍文件再收窄片段。行号定位会随后面的改动漂移，原文片段不会。这个取舍记在 [ADR-0006](./docs/adr/0006-edit-by-unique-snippet.md)。

`glob` 是自己遍历工作区再拿模式去套，而不是把模式交给 `fs.glob` 展开：后者支持花括号展开，`{../outside,src}/**/*.ts` 会变成两条模式，光靠字符串检查拦不住，能直接跑到工作区外。自己走目录从结构上就走不出去，代价是只支持 `*`、`**`、`?` 三种通配。

叫 `shell` 而不是 `bash`：实现是 `spawn(command, { shell: true })`，真正由哪个 shell 解释取决于平台，叫 `bash` 就是承诺了没做到的事。这个取舍记在 [ADR-0005](./docs/adr/0005-name-tools-after-the-ecosystem.md)。

路径统一过工作区的路径守卫：`../`、绝对路径、跨盘符都会被拒绝；解析之后还会再比一次**真实路径**，所以符号链接、junction 指向工作区外时同样会被拒绝。错误变成 `ERROR: path escapes workspace` 回灌给模型。

已知边界：`glob` 只认 `*`、`**`、`?` 三种通配，`{}`、`[]` 按字面匹配（这是刻意的，见下）；`glob` / `grep` 默认跳过 `.git` 和 `node_modules`、最多回 200 条命中，单次最多访问 20 000 个目录项，符号链接不跟随；`read` 最多读 32 KB，`grep` 按字节读到 1 MB 为止、超出的文件跳过，`edit` 不接受超过 2 MB 的文件（读不全就拒绝，绝不拿半截内容覆盖），`ls` 最多展示 500 条、扫到 20 000 项就停。目录用 `opendir` 边读边收，预算限制的是真正读了多少项，而不是 `readdir` 之后切了多少项；所有截断、跳过、没搜完的统计都保留在结果末尾，不会被结果自己的长度上限吃掉。扫描提前停手时会明说 `results may be incomplete`，不会声称拿到了全局排序结果。

`glob` / `grep` 达到 200 条命中上限时，返回的是**遍历顺序里先遇到的那 200 条**；排序只保证这 200 条内部有序，不保证是全局字典序的前 200 条。要拿稳定 Top N 就得扫完整棵树，那会牺牲扫描预算，所以第一阶段先保留现状并明确标注不完整。已记录为后续优化项。

`grep` 是**字面字符串**搜索，不是正则。模型给的正则可能带灾难性回溯（`(a+)+$`），而匹配跑在主线程上，一条这样的模式就能把整个 agent 挂住；第一阶段先放弃正则能力，换来不可能被输入卡死。要恢复正则，得先把匹配放进 worker 并带可中断超时，而不是把 `new RegExp` 加回来。这个取舍记在 [ADR-0009](./docs/adr/0009-grep-is-literal.md)。

还有一条更根本的：**`shell` 不受路径守卫约束**——命令里写 `cd ..`、`cat ../x` 照样能出去，进程权限跟启动它的人一样。这套路径守卫是「防模型手滑」的边界，不是安全边界；真隔离得靠容器、独立用户或只读挂载。见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `API_KEY` | — | 必填，或改用 `OPENAI_API_KEY` |
| `MODEL` | `gpt-4o-mini` | 模型名 |
| `WORKDIR` | 当前目录 | 文件工具的根目录（不是安全边界） |
| `MAX_STEPS` | `30` | 最多请求模型多少次 |
| `MAX_TOOL_CALLS` | `60` | 一次任务最多真正执行多少次工具调用 |
| `MAX_TOTAL_TOKENS` | `500000` | 任务累计 token 预算（软上限：到线后不再发请求，已发生的费用照记）；`0` 表示不限制 |
| `MAX_OUTPUT_TOKENS` | `8192` | 单次模型响应最多生成多少 token |
| `TOOL_TIMEOUT_MS` | `120000` | 单条命令超时 |

## 验证

```bash
npm install
npm run check       # typecheck + 全部测试
```

135 个用例，分七层，都不需要 API Key、不联网（其中 2 条只在 Linux 跑：chmod 权限、向子进程发 SIGINT）：

| 文件 | 打在哪个缝上 |
| --- | --- |
| `test/agent.test.mjs` | `Agent.run`：消息顺序、id 配对、两个预算、最后一步、生命周期、取消、token 统计 |
| `test/tool-registry.test.mjs` | `ToolRegistry`：Schema 注册校验、未知工具、坏 JSON、工具抛错 |
| `test/workspace.test.mjs` | 路径越界、完整读取、截断、扫描预算、符号链接、`edit` 唯一命中、`glob` 模式、`grep` 字面匹配、取消进程树 |
| `test/llm.test.mjs` | `Llm.chat`：合法响应归一化、非法形状必须报错、`finish_reason` 与 `tool_calls` 一致性、usage 保留、`max_tokens`、取消 |
| `test/cli.test.mjs` | 端到端：环境变量、退出码、stdout、请求体形状、API Key 回退、SIGINT、失败路径的 usage |
| `test/selfcheck.test.mjs` | 评测自检：断言失败 / 任务无效 / 基础设施错误三类必须分开 |
| `test/eval.test.mjs` | 评测轮次：检查器里未 await 的 promise 必须让整轮判失败 |

## 评测

单元测试证明「代码没坏」，评测证明「agent 还能干活」。`eval/` 下放了 20 个真实小任务——修 bug、改名、加路由、抽重复、补文档、删死代码、加校验、回调改 Promise、修正则——用真实模型跑一遍，记录成功率、请求数、工具调用数、token 用量和耗时：

```bash
npm run eval            # 需要 .env，会真的调用模型、真的花钱
npm run eval -- rename  # 只跑名字里带 rename 的
npm run eval:check      # 自检：不调用模型，验证每个任务的初始状态确实会断言失败
```

基线（2026-11-04，本地端点 `hy3`，commit `e86cde4`，连续 3 轮，4 并发）：

| 通过 | 模型请求（中位数） | 工具调用（中位数） | tokens（中位数，prompt + completion） | 墙钟（中位数） |
| --- | --- | --- | --- | --- |
| **3/3 轮 20/20** | 100 | 99 | 136,539（127,436 + 8,953） | 75.4s |

三轮总 token 在 118k–142k 之间（约 ±9%）。逐任务波动见 [eval/baseline.md](./eval/baseline.md)：多数任务稳定在 1.0–1.4×，但 `13-callback-to-promise` 最高到 5.3×（同一件事有时 4 次请求、有时 14 次）——单轮数字会掩盖任务级方差，所以看中位数和分布，而不是一次总分。第一阶段验收时的基线是 DeepSeek-V4.1-Flash：20/20、178 请求、200 工具调用、389,074 tokens、66.5s；两份记录都保留，便于比较不同模型的成本结构。

关于耗时与成本：`hy3` 单任务中位数约 13 秒、5.0 次模型请求，其中**请求与请求之间的等待几乎全是模型往返**，工具执行加内核开销占比很小。省时间主要靠任务之间并发（默认 `--jobs 4`，20 个任务墙钟约 75 秒）；省钱主要靠选模型（输入 token 占 93%，成本来自反复重发完整对话历史）和收紧 `MAX_TOTAL_TOKENS` / `MAX_OUTPUT_TOKENS`。上下文压缩这一阶段刻意不做，先用多轮评测判断它是不是真的瓶颈。

`eval:check` 现在把三类结果分开：`ok`（预期断言失败）、`BROKEN`（初始状态就通过，任务什么都没测）、`INFRA`（检查器加载失败或抛非断言错误）。**只有 `ok` 才算自检通过** —— 评测最容易错的地方是评测本身。真实评测也多了一道轮级检查：检查器里没 await 的 promise 如果在结算窗口内变成未处理 rejection，整轮判为基础设施失败，即使任务表全绿。

```bash
npm run eval:summary    # 汇总最近几轮：通过率、请求数、token、墙钟的中位数
```

结果同时写进 `eval/results/`（不进 git）。真实评测**不自动进 CI**：它要真实 Key、会花钱、而且本身非确定性——CI 只跑确定性的 `npm run check` 和不需要 Key 的 `npm run eval:check`。任务怎么写、失败怎么分类，见 [eval/README.md](./eval/README.md)。

## 刻意没做的事

保持「内核」的边界，下面这些留给上层或后续迭代：

- 流式输出（`stream: true` 与增量渲染）
- 多轮 REPL / 会话持久化：一次进程只跑一个任务；`Agent` 实例用一次就作废（第二次 `run()` 直接抛错）
- 工具并发（串行是有意的，见 [ADR-0003](./docs/adr/0003-run-tool-calls-serially.md)）
- 权限审批与安全隔离：文件工具以 `WORKDIR` 作为操作范围约定，`shell` 仍然是启动它的用户的权限（见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)）
- 上下文压缩、自动重试、tokenizer 级精确成本估算（只统计端点返回的 usage）

## 文档与技能

- [CODING_STANDARDS.md](./CODING_STANDARDS.md)：规范本体（语言分层、教学式注释、模块形状、命名、错误处理、防御性编程、测试）。
- [AGENTS.md](./AGENTS.md)：agent 的入口 —— 命令、代码地图、测试放哪。
- [GLOSSARY.md](./GLOSSARY.md)：领域词汇（Kernel、Step、Transcript、ERROR text……）。
- [docs/adr/](./docs/adr/)：已经定下、别再重新讨论的决定。
- [docs/reports/](./docs/reports/)：阶段修复报告（问题、方案、测试、CI 与评测基线）。
- `.agents/skills/`：装好的 agent 技能（来自 [mattpocock/skills](https://github.com/mattpocock/skills)，MIT）。

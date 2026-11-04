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
| `src/agent.ts` | 内核：循环、消息顺序、步数上限。只认 `ChatClient` 和 `ToolRegistry` |
| `src/tool-registry.ts` | 工具注册表：按名字找工具、解析参数、把失败折成 `ERROR` 文本 |
| `src/workspace.ts` | 工作区：文件工具作用的那棵目录树 —— 读、写、改、找文件、搜内容、列目录、跑命令，外加路径守卫与输出上限 |
| `src/llm.ts` | `ChatClient` 的 HTTP 实现，POST 一个 OpenAI 兼容端点 |
| `src/cli.ts` | 组装层：环境变量 → 对象图 → 跑一次任务 |

`agent.ts` 不认识 `workspace.ts`：循环只管「问模型、执行调用、塞回结果」，工具怎么实现的它不关心。
这就是为什么换模型、换工具集，循环一行都不用改。

命令、代码地图、测试放哪见 [AGENTS.md](./AGENTS.md)；怎么写代码（注释风格、模块形状、命名、错误处理）见 [CODING_STANDARDS.md](./CODING_STANDARDS.md)。

## 核心循环

`src/agent.ts` 里的 `Agent.run()`，对应设计稿里的伪代码。它就是 **agent loop** —— 教科书里那个 `while (true)` 的原型，外加一道步数闸门：

```ts
this.messages.push({ role: "user", content: task });

for (let step = 1; step <= this.maxSteps; step++) {
  const response = await this.llm.chat(this.messages, this.tools.definitions);
  this.messages.push(response);

  const calls = response.tool_calls ?? [];
  if (calls.length === 0) return response;

  for (const call of calls) {
    const result = await this.tools.execute(call);
    this.messages.push(createToolResult(call, result));
  }
}
throw new Error(`step limit ${this.maxSteps} reached`);
```

逐段理解：

1. **消息就是全部状态。** 模型无状态，它「记得」什么，完全取决于我们每轮重发多少。
2. **先入栈，再判断。** 带 `tool_calls` 的 assistant 消息必须先写进历史，工具结果才能跟在它后面。
3. **`tool_call_id` 是配对钥匙。** 每条 tool 消息靠它说明自己在回应哪一次调用，写错直接被 API 拒绝。
4. **没有工具调用 = 交卷。** 这就是循环唯一的正常出口。
5. **工具错误也要「入栈」。** 失败被折成 `ERROR: ...` 文本，模型下一轮能看见并自己纠正。
6. **`maxSteps` 是唯一多出来的硬约束。** 没有它，模型可能永远在「调工具 → 不满意 → 再调」。

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
| `grep` | 按正则搜文件内容，回 `路径:行号: 内容` | `Workspace.grep` |
| `ls` | 列目录：类型、字节数、名称 | `Workspace.list` |
| `shell` | 在工作区根目录跑 shell；超时杀整棵进程树，输出有上限 | `Workspace.run` |

前三个是「改文件」，中间两个是「找东西」，`ls` 看一层目录，`shell` 是兜底。模型先找后改，顺序和它自己的直觉一致。

`write` 和 `edit` 的分工就是名字说的那件事：改几行用 `edit`（省 token，也不会因为「只改三行却重写整个文件」把长文件改坏），新建文件或整体重写才用 `write`。

`edit` 要求 `old_string` 恰好命中一次：0 次或多次都回 `ERROR`，模型读一遍文件再收窄片段。行号定位会随后面的改动漂移，原文片段不会。这个取舍记在 [ADR-0006](./docs/adr/0006-edit-by-unique-snippet.md)。

`glob` 是自己遍历工作区再拿模式去套，而不是把模式交给 `fs.glob` 展开：后者支持花括号展开，`{../outside,src}/**/*.ts` 会变成两条模式，光靠字符串检查拦不住，能直接跑到工作区外。自己走目录从结构上就走不出去，代价是只支持 `*`、`**`、`?` 三种通配。

叫 `shell` 而不是 `bash`：实现是 `spawn(command, { shell: true })`，真正由哪个 shell 解释取决于平台，叫 `bash` 就是承诺了没做到的事。这个取舍记在 [ADR-0005](./docs/adr/0005-name-tools-after-the-ecosystem.md)。

路径统一过工作区的路径守卫：`../`、绝对路径、跨盘符都会被拒绝；解析之后还会再比一次**真实路径**，所以符号链接、junction 指向工作区外时同样会被拒绝。错误变成 `ERROR: path escapes workspace` 回灌给模型。

已知边界：`glob` 只认 `*`、`**`、`?` 三种通配，`{}`、`[]` 按字面匹配（这是刻意的，见下）；`glob` / `grep` 默认跳过 `.git` 和 `node_modules`、最多回 200 条命中，单次最多访问 20 000 个目录项（超了会在结果里说明），符号链接不跟随；`read` 最多读 32 KB，`grep` 按字节读到 1 MB 为止、超出的文件跳过，`edit` 不接受超过 2 MB 的文件，`ls` 最多列 500 条。所有这些截断、跳过、丢弃、没搜完的统计都保留在结果末尾，不会被结果自己的长度上限吃掉。

还有一条：`grep` 的正则跑在主线程上，遇到灾难性回溯（`(a+)+$` 这种）会让整个 agent 卡住——目前的防线是「单文件 1 MB + 扫描预算」，没有中断能力；真要中断得把匹配放进 worker 并加超时，这一版刻意没做。

还有一条更根本的：**`shell` 不受路径守卫约束**——命令里写 `cd ..`、`cat ../x` 照样能出去，进程权限跟启动它的人一样。这套路径守卫是「防模型手滑」的边界，不是安全边界；真隔离得靠容器、独立用户或只读挂载。见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `API_KEY` | — | 必填，或改用 `OPENAI_API_KEY` |
| `MODEL` | `gpt-4o-mini` | 模型名 |
| `WORKDIR` | 当前目录 | 文件工具的根目录（不是安全边界） |
| `MAX_STEPS` | `30` | 循环上限 |
| `TOOL_TIMEOUT_MS` | `120000` | 单条命令超时 |

## 验证

```bash
npm install
npm run check       # typecheck + 全部测试
```

78 个用例，分五层，都不需要 API Key、不联网（其中 1 条验证「读不了的文件要报出来」，只在 POSIX 上跑）：

| 文件 | 打在哪个缝上 |
| --- | --- |
| `test/agent.test.mjs` | `Agent.run`：消息顺序、id 配对、步数上限、错误回灌 |
| `test/tool-registry.test.mjs` | `ToolRegistry.execute`：未知工具、坏 JSON、工具抛错 |
| `test/workspace.test.mjs` | 路径越界、截断、exit code、`edit` 唯一命中、`glob` 模式、`grep` 命中格式 |
| `test/llm.test.mjs` | `Llm.chat`：合法响应归一化、非法形状必须报错（不能变成空成功） |
| `test/cli.test.mjs` | 端到端：环境变量、退出码、stdout、请求体形状 |

## 刻意没做的事

保持「内核」的边界，下面这些留给上层或后续迭代：

- 流式输出（`stream: true` 与增量渲染）
- 多轮 REPL / 会话持久化（现在一次进程只跑一个任务）
- 工具并发（串行是有意的，见 [ADR-0003](./docs/adr/0003-run-tool-calls-serially.md)）
- 权限审批与安全隔离：文件工具以 `WORKDIR` 作为操作范围约定，`shell` 仍然是启动它的用户的权限（见 [ADR-0008](./docs/adr/0008-trusted-local-agent.md)）
- token 预算、上下文压缩、自动重试

## 文档与技能

- [CODING_STANDARDS.md](./CODING_STANDARDS.md)：规范本体（语言分层、教学式注释、模块形状、命名、错误处理、防御性编程、测试）。
- [AGENTS.md](./AGENTS.md)：agent 的入口 —— 命令、代码地图、测试放哪。
- [GLOSSARY.md](./GLOSSARY.md)：领域词汇（Kernel、Step、Transcript、ERROR text……）。
- [docs/adr/](./docs/adr/)：已经定下、别再重新讨论的决定。
- `.agents/skills/`：装好的 agent 技能（来自 [mattpocock/skills](https://github.com/mattpocock/skills)，MIT）。

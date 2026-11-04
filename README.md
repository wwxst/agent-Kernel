# agent-Kernel

最小 Coding Agent：**一个类、一个循环、四个工具**，运行时零依赖。

> 当前状态：v0.4，个人练习项目。

## 快速开始

需要 Node.js **>= 22.18**（从 22.18 起可以直接 `node xxx.ts`，靠内置的 type stripping，不需要构建）。

```powershell
Copy-Item .env.example .env    # 填入 API_KEY；用什么模型由你决定
npm run agent -- "给这个仓库加一个 /health 接口并写测试"
```

`npm install` 只在跑类型检查和测试时需要；`npm run agent` 本身不需要任何依赖。

## 代码结构

六个模块，依赖只有一个方向 —— 都指向 `types.ts`：

| 文件 | 一句话 |
| --- | --- |
| `src/types.ts` | 协议词汇：`Message`、`Tool`、`ToolDefinition`、`ChatClient`。不依赖任何人 |
| `src/agent.ts` | 内核：循环、消息顺序、步数上限。只认 `ChatClient` 和 `ToolRegistry` |
| `src/tool-registry.ts` | 工具注册表：按名字找工具、解析参数、把失败折成 `ERROR` 文本 |
| `src/workspace.ts` | 工作区：沙箱内的读、写、列目录、跑命令，外加路径守卫与输出截断 |
| `src/llm.ts` | `ChatClient` 的 HTTP 实现，POST 一个 OpenAI 兼容端点 |
| `src/cli.ts` | 组装层：环境变量 → 对象图 → 跑一次任务 |

`agent.ts` 不认识 `workspace.ts`：循环只管「问模型、执行调用、塞回结果」，工具怎么实现的它不关心。
这就是为什么换模型、换工具集，循环一行都不用改。

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

## 四个工具

工具名是模型看到的接口，所以用的是 agent 生态里的通用叫法（`read` / `write` / `ls` / `shell`），不是本仓库方法名的直译：

| 工具 | 说明 | 对应工作区方法 |
| --- | --- | --- |
| `read` | 读 UTF-8 文本，超过 8k 字符截断 | `Workspace.read` |
| `write` | 创建/覆盖文件，自动建父目录 | `Workspace.write` |
| `ls` | 列目录：类型、字节数、名称 | `Workspace.list` |
| `shell` | 在沙箱根目录跑 shell，超时强杀，输出截断 | `Workspace.run` |

叫 `shell` 而不是 `bash`：实现是 `spawn(command, { shell: true })`，真正由哪个 shell 解释取决于平台，叫 `bash` 就是承诺了没做到的事。这个取舍记在 [ADR-0005](./docs/adr/0005-name-tools-after-the-ecosystem.md)。

路径统一过工作区的路径守卫：`../`、绝对路径、跨盘符都会被拒绝，错误变成 `ERROR: path escapes workspace` 回灌给模型。

已知边界：不处理符号链接指向工作区外的情况；`shell` 超时只杀外层 shell，Windows 上孙进程可能残留。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点 |
| `API_KEY` | — | 必填，或改用 `OPENAI_API_KEY` |
| `MODEL` | `gpt-4o-mini` | 模型名 |
| `WORKDIR` | 当前目录 | 工具能碰的沙箱根目录 |
| `MAX_STEPS` | `30` | 循环上限 |
| `TOOL_TIMEOUT_MS` | `120000` | 单条命令超时 |

## 验证

```bash
npm install
npm run check       # typecheck + 全部测试
```

29 个用例，分四层，都不需要 API Key、不联网：

| 文件 | 打在哪个缝上 |
| --- | --- |
| `test/agent.test.mjs` | `Agent.run`：消息顺序、id 配对、步数上限、错误回灌 |
| `test/tool-registry.test.mjs` | `ToolRegistry.execute`：未知工具、坏 JSON、工具抛错 |
| `test/workspace.test.mjs` | 路径越界、截断、exit code |
| `test/cli.test.mjs` | 端到端：环境变量、退出码、stdout、请求体形状 |

## 刻意没做的事

保持「内核」的边界，下面这些留给上层或后续迭代：

- 流式输出（`stream: true` 与增量渲染）
- 多轮 REPL / 会话持久化（现在一次进程只跑一个任务）
- 工具并发（串行是有意的，见 [ADR-0003](./docs/adr/0003-run-tool-calls-serially.md)）
- 权限审批（写文件、跑命令目前直接执行，靠 `WORKDIR` 划定边界）
- token 预算、上下文压缩、自动重试

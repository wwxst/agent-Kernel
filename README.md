# agent-Kernel

最小 Coding Agent：**一个类、一个循环、四个工具**，运行时零依赖。

> 当前状态：本地草稿，尚未提交到远端。

## 快速开始

需要 Node.js **>= 22.18**（从 22.18 起可以直接 `node xxx.ts`，靠内置的 type stripping，不需要构建）。

```powershell
Copy-Item .env.example .env    # 填入 API_KEY；用什么模型由你决定
npm run agent -- "给这个仓库加一个 /health 接口并写测试"
```

`npm install` 只在跑类型检查时需要；`npm run agent` 本身不需要任何依赖。

## 核心循环

`src/agent.ts` 里的 `Agent.run()`，对应设计稿里的伪代码：

```ts
this.messages.push({ role: "user", content: userMessage });

for (let step = 1; step <= this.maxSteps; step++) {
  const response = await this.llm.chat(this.messages, this.tools);
  this.messages.push(response);

  const calls = response.tool_calls ?? [];
  if (calls.length === 0) return response;

  for (const call of calls) {
    const result = await executeTool(this.tools, call);
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
| `executeTool(call)` | `executeTool(tools, call)`：显式传工具表，不用模块级全局变量 |
| `createToolResult(call, result)` | `{ role: "tool", tool_call_id: call.id, content: result }` |
| `while (true)` | `for` + `maxSteps` |

字段名保留协议原样（`tool_calls`、`tool_call_id`），请求体可以原样序列化，不需要来回翻译。

## 四个工具

| 工具 | 说明 |
| --- | --- |
| `read_file` | 读 UTF-8 文本，超过 8k 字符截断 |
| `write_file` | 创建/覆盖文件，自动建父目录 |
| `list_dir` | 列目录：类型、字节数、名称 |
| `run_command` | 在沙箱根目录跑 shell，超时强杀，输出截断 |

路径统一过 `resolveIn()`：`../`、绝对路径、跨盘符都会被拒绝，错误变成 `ERROR: path escapes workspace` 回灌给模型。

已知边界：不处理符号链接指向工作区外的情况；`run_command` 超时只杀外层 shell，Windows 上孙进程可能残留。

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
npm test            # 5 个端到端用例，mock 模型，无需 API Key
npm run typecheck   # tsc --noEmit，strict
```

测试覆盖：完整循环与消息顺序、越界路径、坏 JSON 参数、未知工具、步数上限。

## 刻意没做的事

保持「内核」的边界，下面这些留给上层或后续迭代：

- 流式输出（`stream: true` 与增量渲染）
- 多轮 REPL / 会话持久化（现在一次进程只跑一个任务）
- 工具并发（串行是有意的：结果顺序与模型给出的顺序一致）
- 权限审批（写文件、跑命令目前直接执行，靠 `WORKDIR` 划定边界）
- token 预算、上下文压缩、自动重试

## 约定

- 源码注释用中文、面向教学；运行时输出与报错用英文；
- 工具失败不抛异常，一律折成 `ERROR: ...` 文本回灌；
- 结束前设置 `process.exitCode` 而不是 `process.exit()`：Windows 上 fetch 的 keep-alive 连接未关时强退会触发 libuv 断言。

# ADR-0020：Hook 挂在 ToolRegistry.execute 上，不挂在 Agent 循环里

- 状态：已采纳（2026-11-13）
- 影响范围：`src/core/tool-hooks.ts`（新增）、`src/core/tool-registry.ts`、`ToolRegistry` 的构造函数

## 背景

日志、监控、调用检查这类需求横跨所有工具。没有统一挂点时，每加一个就要改一遍工具实现或 Core 循环，
加三次之后工具里全是别人的事，循环也会慢慢长出策略。

需要三个事件：执行前（`PreToolUse`）、成功之后（`PostToolUse`）、失败之后（`PostToolUseFailure`）。
前置事件要能阻止一次调用并说明原因。

## 决定

Hook 挂**工具执行的唯一入口** `ToolRegistry.execute()`，围着 `tool.run()` 前后触发：

```
execute(): 找工具 → 解析参数 → 校验参数 → PreToolUse → tool.run() → PostToolUse
                                                        ↘ 抛错 → PostToolUseFailure
```

- `ToolRegistry` 构造函数多一个可选参数 `hooks: ToolHooks`；不传就是空执行器，行为与以前完全一致。
- `ToolHooks`（`src/core/tool-hooks.ts`）自己管登记顺序、执行、故障隔离，不认识任何具体工具。
- `Agent` 主循环一行未改：它调用的仍然是 `this.tools.execute(call)`。

## 为什么不挂在 Agent 循环里

循环里只有「模型要了哪些调用」这一层信息，没有「哪个工具、什么参数、成功还是失败」的判定。
挂在那里就得把工具查找和错误折叠的判断复制一遍，于是同一件事有两个实现。
更关键的是：循环是 Core，Hook 是策略；把策略写进 Core，等于让以后每加一个 Hook 都要改内核。

## 为什么 Hook 拿副本

参数校验发生在 Hook 之前。如果 Hook 拿到的是工具真正会收到的那个对象，它改一下就等于绕过校验改参数 ——
那是 Hook 不该有的权力。所以 `ToolHooks` 给每个事件发一份 `structuredClone`，
并用「先定结果、再通知 Hook」的顺序保证 Hook 改不到已经折好的 `ERROR:` 文本。

## 代价与不变量

- **代价**：每次工具调用多 2 次 `structuredClone`（参数都是小 JSON，代价可忽略）和若干个微任务；
  `execute` 从「同步走到 `tool.run`」变成「先 await 一次前置链」。
- **不变量**：工具结果文本、`ERROR:` 文案、Transcript、模型请求体都不因 Hook 改变；
  `ProcessCleanupError` 照旧抛出（Hook 先收到通知，然后异常原样往上走）；
  未知工具、坏 JSON、参数不合法不触发任何事件 —— 没执行就没有事件，不能假装工具开始过。
- **已知边界**：没有超时。一个永不返回的 Hook 会挡住那次工具调用。
- **不做**：HTTP / MCP Hook、外部脚本加载、Prompt 与 Session 生命周期事件、Hook 优先级、后台调度。
  等真的有第二个调用者再说。

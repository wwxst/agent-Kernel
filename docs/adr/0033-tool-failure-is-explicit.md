# ADR-0033：工具失败是显式宿主事实，不再从结果文本反推

- 状态：已采纳（2026-11-27）
- 影响范围：`src/tools/workspace.ts`（前台 `shell` 返回结构化结果）、`src/core/tool-registry.ts`（`executeWithStatus()` 为权威入口）、`src/core/tool-result-status.ts`、`src/core/tool-log.ts`、评测诊断与相关测试

## 背景

2026-11-20 的 Tool Registry 评审把这条列为 F-002：前台 `shell` 把退出状态写进结果文本第一行，却以纯字符串返回；`ToolRegistry.executeWithStatus()` 遇到字符串一律记 `isError:false`。于是非零退出、超时、取消这些最常见的命令失败，在宿主侧全部显示成成功。

后果分三处：

- `PostToolUseFailure` 收不到前台 `shell` 的失败。Hook 只认注册表的 `isError`，而注册表从没拿到过失败信号。
- CLI、TUI、tool-log 各自嗅探 `shell` 文本第一行，评测分支的诊断代码也有同一套判断；它们与注册表的口径天然不一致，文档里也出现了两套不同的失败契约。
- 模型读到的内容本身没有问题，问题在宿主侧：同一个事实（这次调用成没成）没有唯一来源。

`ToolExecutionResult` 已经存在，注册表也已经支持工具返回 `{ content, isError }`；缺的只是 `shell` 没有把已知的失败事实交出来。

## 决定

1. **`ToolExecutionResult.isError` 是宿主侧唯一权威的失败信号。** `ToolRegistry.executeWithStatus()` 是唯一产出点；`execute()` 保留为只返回内容、丢掉 `isError` 的兼容包装。
2. **前台 `shell` 以非零退出、超时或取消结束时是工具失败。** `shell` 返回 `{ content, isError: true }`，`content` 与改动前逐字节一致（状态行 + 输出 + 同样的截断）。`background:true` 的启动成功仍是 `isError:false`；`ProcessCleanupError` 继续抛出，不折成可恢复失败。
3. **Hook 跟着这个信号走。** `isError:false` 触发 `PostToolUse`；`isError:true` 或工具抛出错误触发 `PostToolUseFailure`。注册表本来就这么分发，这次只是补上了 `shell` 的信号。
4. **显示、日志与评测诊断消费 `isError`。** `isToolResultFailure()` 原有的 `shell` 文本兜底保留，但只作为「调用方只拿得到原始文本」的兼容路径；不新增启发式、不新增模块。

## 为什么

- **一个事实只能有一个来源。** 退出码、超时、取消在 `Workspace.run()` 里已经是一个确定的状态字符串；让 `shell` 顺手把它翻译成 `isError`，比让四个消费者各自从文本里再猜一遍可靠。
- **Hook 要看见最常见的失败。** 命令跑失败是 agent 最常遇到的工具失败。Hook 看不到它，日志和监控就只能记录成功，`PostToolUseFailure` 形同虚设。
- **模型侧零变化。** 结果文本一字不改，模型仍然按原来的方式读状态行；这次改动只影响宿主怎么判断，不影响模型看到什么、怎么行动。
- **不新增抽象。** 现有的 `ToolExecutionResult.isError` 已经够表达成败；`isWaiting` 已经单独表达「有效等待」。再引入状态枚举只是把二值事实包装成更多分支。

## 放弃的方案

- **保持退出码只是数据，改四个消费者和文档。** 这是改动前的事实状态。它会让文本第一行继续充当隐式契约，命令正文里碰巧出现 `exit 0` 就可能误判；更重要的是 Hook 仍然拿不到失败，日志和监控会长期缺一块。改动面看起来小，实际把同一个判断重复维护在四处。
- **新增工具状态枚举（成功 / 失败 / 部分成功 / 等待）。** 当前只有「成没成」这一个宿主侧问题，`isWaiting` 已经负责等待；多一层枚举会让每个消费者都要处理用不到的状态，属于不必要的抽象。真有第三种状态时再讨论。

## 代价与不变量

- **内容逐字节不变**：状态行、命令输出、超长截断和丢弃字符提示都和改动前一致；模型请求体不受影响。
- **后台启动不是失败**：`background:true` 成功返回任务编号即 `isError:false`；后台任务之后怎么结束由 `shell-output` / `shell-kill` 报告。
- **`ProcessCleanupError` 仍然是不可恢复异常**：它继续穿过 `ToolRegistry`，不折成 `ERROR:` 文本，也不因为这次改动被 `isError` 吞掉。
- **`isError` 只活在宿主侧**：不序列化进发给模型的 `Message`，也不进入 Transcript。
- **文本兜底是兼容路径**：`isToolResultFailure()` 对 `shell` 原始文本的判断只为旧调用方保留，新代码必须消费 `executeWithStatus().isError`；它不是第二套契约。
- **Hook 的故障隔离不变**：Hook 自身抛错、返回 rejected Promise 或上下文复制失败（F-001）只增加诊断计数，不改变工具结果，也不改变 Transcript。
- **对应行为由测试固定**：`test/tool-registry.test.mjs` 守住前台 `shell` 的 `isError` 与内容、后台启动不是失败；`test/tool-hooks.test.mjs` 守住失败 / 成功事件各只触发一次且错误消息是未改动的原文；`test/eval-diagnostics.test.mjs` 守住真实 `shell` 失败的 `resultKind` 与错误计数。

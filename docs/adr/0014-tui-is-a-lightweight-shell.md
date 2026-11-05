# TUI v0.1：轻量外壳，不切全屏

CLI 增加 `--tui`：在同一个 Agent / Permission 会话外面套一个轻量终端界面。`--repl` 继续保留，两者互斥；`--tui` 可以带一个初始任务，先跑完再等下一行输入。

## 决定

- **两种布局，按终端能力自动选**：
  - 支持 DECSTBM 滚动区域的终端（Windows Terminal、VS Code 终端、Linux / macOS 的 xterm 类终端）：第 1 行状态栏、第 2 行 Session 统计固定，中间滚动 **Run log**，输入行在底部；不切 alternate screen。
  - 传统 Windows conhost 不实现 DECSTBM：固定栏位会把回复行互相覆盖，因此退化为**行式聊天** —— 启动时打印 model / workspace / permission 头，回复逐行追加，输入提示定位到窗口最后一行。状态头会随历史滚走，这是 v0.1 的明确取舍。
- **非 TTY 退化**：管道、CI、e2e 没有光标控制，退化成逐行输出（状态头、每轮一行 `[stats]`、最后一行 `[session]`），但走同一套日志与审批逻辑。
- **Thinking**：每次模型请求前显示 `thinking...`；第一段正文、第一个工具调用或错误到达时原地清掉/覆盖。它只表示「请求已发出、还没收到第一段输出」，不代表请求成功。Agent 用 `onRequestStart` 在每次 `llm.chat()` 前通知 TUI。
- **Run log 是显示层**：`you:`、`model:`、`→ tool`、`✓/✗ tool [ok|failed|denied]` 只给人看，不进入 Transcript，不影响模型下一轮看到什么。
- **审批**：复用 `formatApproval` 的完整命令与实际 cwd；TUI 先把头部写进 Run log，再用单行 `allow once? [y/N]` 读答案。只有 `y` / `yes` 放行；无 TTY、取消、EOF、已有排队输入都按拒绝处理，和 REPL 共用 `approvalGate` 与 `isApproved`。
- **统计**：固定布局刷新第 2 行，行式布局每轮打 `[stats]`；都按 Session 累计。usage 缺失时写 `at least`，不把已知下限说成精确值。
- **命令**：`/exit`、`/reset`、`/permission [mode]`、`/help` 与 REPL 相同；`/reset` 换 Agent 但不换 Permission。
- **内核改动最小**：Agent 只增加 `onToolCall` 与 `onRequestStart` 两个显示回调；循环、预算、消息顺序、权限检查点都没有变。

## 为什么

TUI v0.1 的目标是**看清 agent 在干什么**，不是做一个终端应用框架。能固定顶部栏和底部输入当然好，但传统 Windows conhost 不支持滚动区域；为了一个 v0.1 去做全屏重绘、输入行编辑器和窗口 resize，复杂度会跳一个量级。行式聊天已经满足「回复在上面、输入在下面、等待时有 thinking」，而且失败得很轻：显示不好看，不影响 Agent 的正确性。

不切 alternate screen 是有意的：退出后原来的 shell 输出还在 scrollback 里，用户不需要「退出 TUI 才看得到历史」。固定布局也只在终端确实支持 DECSTBM 时启用，避免用一个不可靠的 ANSI 序列去假装全屏。

把审批头部写进 Run log、问题单独作为输入行，而不是把多行提示交给 readline 当 prompt：固定布局下多行 prompt 的光标位置很容易算错，而 Run log 本来就需要留下这条记录。

## 代价与边界

- 传统 conhost 没有固定顶部栏：状态头只是启动时打印的一段记录，会随历史滚走；回复期间输入行被 thinking/正文占用，下一轮提示符才回到最后一行。要真正的固定输入框，需要全屏重绘或 Windows Terminal，留给后续。
- 固定布局要求至少 6 行、20 列；终端 resize 后不会重新计算区域。宽度按 JS 字符串长度近似，CJK / emoji 可能提前换行。
- 没有鼠标、彩色主题、面板焦点、输入历史搜索；Run log 也不做持久化，不能当审计日志。
- `--tui` 与 `--repl` 是两个壳，不能同时选；默认无参启动仍是 REPL，TUI 需要显式 `--tui`。
- 审批的「允许一次」仍然只放行当前这一条命令，不缓存；这不是沙箱（[ADR-0013](./0013-permission-is-a-policy-not-a-sandbox.md)）。
- 流式增量只用于显示（[ADR-0012](./0012-streaming-is-display-only.md)）；TUI 的排版不会改变最终 Message。

## 不变量

- **Run log 永远不回灌给模型**：它不是 Transcript，删掉它不会改变任何一轮请求。
- **Thinking 只表示等待**：`onRequestStart` 触发显示，第一段正文、工具调用、错误或取消都会清掉；不能把它当成「请求成功」。
- **审批展示必须完整**：命令逐行展示、cwd 实际展示、控制字符转义；拒绝仍折成同一条 `ERROR: permission denied: …` 文本。
- **无 TTY 不假装有审批通道**：不展示审批界面，不读 stdin，直接按拒绝处理。
- **统计不把未知说成 0**：usage 缺失时写 `at least`。
- **TUI 不改变 Agent 决策**：`onToolCall` / `onRequestStart` 只用于显示；循环、预算、消息配对和权限检查点保持原样。
- **退出必须恢复终端**：固定布局重置滚动区域并把光标放回最后一行下面；不切 alternate screen，因此不需要「退出全屏」。

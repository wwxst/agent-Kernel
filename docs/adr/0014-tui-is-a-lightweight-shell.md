# TUI v0.1：轻量外壳，不切全屏

> **历史决策（2026-11-12 注）**：文中涉及的 Shell 审批、`/permission`、权限面板与 `y/N` 交互已随
> [ADR-0019](./0019-full-access-is-the-only-mode.md) 删除。本文件保留为当时的决策记录，
> 当前界面与行为以 README 为准。


CLI 增加 `--tui`：在同一个 Agent / Permission 会话外面套一个轻量终端界面。`--repl` 继续保留，两者互斥；`--tui` 可以带一个初始任务，先跑完再等下一行输入。

## 决定

- **固定布局用整帧重绘，不依赖 DECSTBM**：第 1 行状态栏、第 2 行 Session 统计固定；中间是 **Run log** 视口；倒数第二行是输入行，最后一行留空作缓冲。每帧用绝对光标定位重画所有行，不靠换行滚屏，所以传统 Windows conhost 也能固定输入。
- **输入始终在底部**：`readLine` 先把当前帧画好，再把光标放到输入行；回车只让 readline 在缓冲行换行，随后下一帧重绘，不会把输入区顶走。固定布局下用户输入的回显会被下一帧清掉，所以 TUI 自己补 `you:`。
- **不切 alternate screen**：不隐藏整个屏幕缓冲区，不用全屏框架，不引 TUI 库。但整帧重绘只保留最后一屏，退出后 TUI 的历史记录不会留在 scrollback 里。
- **非 TTY 退化**：管道、CI、e2e 没有光标控制，退化成逐行输出（状态头、每轮一行 `[stats]`、最后一行 `[session]`），但走同一套日志与审批逻辑。
- **Thinking**：每次模型请求前，日志视口最后一行显示 `thinking...`；第一段正文、第一个工具调用或错误到达时重绘掉。它只表示「请求已发出、还没收到第一段输出」，不代表请求成功。Agent 用 `onRequestStart` 在每次 `llm.chat()` 前通知 TUI。
- **Run log 是显示层**：`you:`、`model:`、`→ tool`、`✓/✗ tool [ok|failed|denied]` 只给人看，不进入 Transcript，不影响模型下一轮看到什么。
- **审批**：复用 `formatApproval` 的完整命令与实际 cwd；TUI 先把头部写进 Run log，再用固定输入行的单行 `allow once? [y/N]` 读答案。只有 `y` / `yes` 放行；无 TTY、取消、EOF、已有排队输入都按拒绝处理，和 REPL 共用 `approvalGate` 与 `isApproved`。
- **统计**：固定布局刷新第 2 行，非 TTY 每轮打一行 `[stats]`；都按 Session 累计。usage 缺失时写 `at least`，不把已知下限说成精确值。
- **命令**：`/exit`、`/reset`、`/permission [mode]`、`/help` 与 REPL 相同；`/reset` 换 Agent 但不换 Permission。
- **内核改动最小**：Agent 只增加 `onToolCall` 与 `onRequestStart` 两个显示回调；循环、预算、消息顺序、权限检查点都没有变。

## 为什么

TUI v0.1 的目标是**看清 agent 在干什么**，而「输入固定在底部、回复在上面」是这个界面的基本形态。传统 Windows conhost 不实现 DECSTBM，只靠滚动区域必然失败；整帧重绘虽然多写几行 ANSI，但换来了一个在 conhost / Windows Terminal / xterm 上都成立的固定布局，而且不需要引入 TUI 框架或输入编辑器。

不切 alternate screen 是有意的：退出时不需要「退出全屏」才能回到 shell。代价是 TUI 不保留可回滚的历史——它只显示最后一屏，真正的 Transcript 在 Agent 里，不在显示层。

把审批头部写进 Run log、问题单独作为输入行，而不是把多行提示交给 readline 当 prompt：固定布局下多行 prompt 的光标位置很容易算错，而 Run log 本来就需要留下这条记录。

## 代价与边界

- 整帧重绘在慢终端上可能闪烁；每帧重画约一屏，流式增量按 40ms 限频。
- 只保留最后一屏，TUI 不提供历史回滚；Transcript 仍由 Agent 完整保存。
- 固定布局要求至少 6 行、20 列；终端 resize 后不会重新计算区域。宽度按近似显示宽度换行（CJK / emoji 按 2 列，组合字符按 0 列），不做完整 Unicode East Asian Width 表；长行硬换行，不做横向滚动。
- 没有鼠标、彩色主题、面板焦点、输入历史搜索；Run log 也不做持久化，不能当审计日志。
- `--tui` 与 `--repl` 是两个壳，不能同时选；默认无参启动仍是 REPL，TUI 需要显式 `--tui`。
- 审批的「允许一次」仍然只放行当前这一条命令，不缓存；这不是沙箱（[ADR-0013](./0013-permission-is-a-policy-not-a-sandbox.md)）。
- 流式增量只用于显示（[ADR-0012](./0012-streaming-is-display-only.md)）；TUI 的排版不会改变最终 Message。

## 不变量

- **输入区必须在底部**：固定布局下输入行是倒数第二行，最后一行只作缓冲；回复只改变它上方的日志视口。
- **Run log 永远不回灌给模型**：它不是 Transcript，删掉它不会改变任何一轮请求。
- **Thinking 只表示等待**：`onRequestStart` 触发显示，第一段正文、工具调用、错误或取消都会清掉；不能把它当成「请求成功」。
- **审批展示必须完整**：命令逐行展示、cwd 实际展示、控制字符转义；拒绝仍折成同一条 `ERROR: permission denied: …` 文本。
- **无 TTY 不假装有审批通道**：不展示审批界面，不读 stdin，直接按拒绝处理。
- **统计不把未知说成 0**：usage 缺失时写 `at least`。
- **TUI 不改变 Agent 决策**：`onToolCall` / `onRequestStart` 只用于显示；循环、预算、消息配对和权限检查点保持原样。
- **退出必须把终端交还 shell**：清掉定时器、关闭 readline，从最后一行下方换行；不切 alternate screen，因此不需要「退出全屏」。

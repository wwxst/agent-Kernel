# Agent 可以连续跑多个 Run

`Agent` 从「一个实例只跑一次」改成「一个实例是一段会话，可以连续跑多个 Run」：`run()` 可以重复调用，Transcript 跨 Run 累积。

## 决定

- `run(task)` 是**一次 Run**（一轮用户任务）；同一个 Agent 按顺序调用多次就是多轮会话。
- 每次 Run 的 Step limit、Tool call budget、Token budget 独立计算：第二轮不会因为第一轮花光了额度而一开始就没工具可用。
- `stats` 描述**本次 Run**（请求数、工具数、usage、tokenBudget）；`sessionStats` 描述整个会话（runs 与累计账单）。
- 同一时刻只允许一个 Run；在 `run()` 还没结束时再调一次，直接抛错。
- 失败的 Run 不销毁 Agent：历史留在 Transcript 里，下一轮还能继续。要干净的上下文，用 CLI 的 `/reset`（换一个新 Agent）。

## 理由

REPL 需要的正是「在同一条 Transcript 上继续问」。把会话状态留在 Agent 里，比在 CLI 层复制 messages 更简单：预算、取消、assistant/tool 配对都只有一个地方管。

预算按 Run 算也是必然的：如果 Tool call budget 是会话级，第二、三轮可能刚开口就没有工具额度；Token budget 同理。账单按会话算则是因为用户最后想知道「这轮对话一共花了多少」。

## 代价

- `stats` 的语义从「实例终身」变成「本次 Run」。要总量必须读 `sessionStats` —— 两个口径分开，读数的人要清楚自己在看哪个。
- 失败的 Run 会在 Transcript 里留下半截历史（空回复、或 `not run` 的 tool 结果）。这是如实记录，但下一轮模型会看到失败现场；`/reset` 是唯一的干净退出。
- 取消仍然是**会话级**：Ctrl-C 停掉整个进程，而不是只停当前这一轮。按轮取消需要每轮换一个 signal，而 Workspace、Llm、Agent 三处都持有它 —— 属于下一阶段，不在这一次里假装做到。

## 不变量

- assistant / tool 的 id 配对不跨 Run 断裂：失败路径仍然补齐 `not run` 结果。
- 并发 Run 被拒绝：两个循环同时往一条 Transcript 里写，消息顺序无法解释。

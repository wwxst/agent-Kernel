# Permission 是工具调用策略，不是沙箱

Permission v0.1 给 agent 三档模式：`read-only` 只放行 `read` / `ls` / `glob` / `grep`；`workspace-write`（默认）再放行 `write` / `edit`，`shell` 每次执行前问人；`full-access` 放行全部工具、不审批。

## 决定

- 检查点在 `ToolRegistry.execute()`：参数校验之后、`tool.run()` 之前。拒绝不执行工具，返回一条 `ERROR: permission denied: …` 的 **Tool result**，模型下一轮可以自己换做法。
- 权限按工具名分档，不看参数。路径是否越界仍由 `Workspace` 的路径守卫判断；两层各管一件事。
- 权限由宿主注入：`ToolRegistry` 不注入时不检查（测试、评测这类宿主自己决定工具集）；CLI 总会注入，所以用户侧默认是 `workspace-write`。
- 审批提示懒创建 readline：没有 `shell` 调用的任务不进入终端 raw mode，Ctrl-C 仍走原取消链；REPL 里如果任务运行时已经排着下一行输入，这次 `shell` 会被拒绝，那一行留给下一轮，避免把任务当成审批答案。
- `shell` 的审批是**逐次**的：允许一次或拒绝，不缓存「上次同意过」。没有 TTY、取消、审批通道异常都按拒绝处理；无 TTY 时不读 stdin，避免把管道里的下一行任务当成审批答案。
- REPL 与审批共用同一个 readline，并按顺序一次只等一行；`/reset` 换 Agent 但不换 Permission 对象。
- CLI 用 `--permission` 选起始模式，REPL 用 `/permission` 查看和切换。

## 为什么

把检查放在 `ToolRegistry`，是因为它是所有 Tool call 的唯一入口：Agent Loop 一行不用改，新增工具也不会绕过去。放在 Agent 里会让内核认识权限概念；放在每个工具里则要把同一条规则抄七遍，迟早漏一个。

默认 `workspace-write` 是可用性与风险的折中：日常改代码不需要每次确认，而唯一能跑任意命令的 `shell` 单独停下来问人。`read-only` 给「先看看」的场景；`full-access` 给用户明确信任的自动化场景。

## 代价与边界

- **这不是沙箱。** Permission 不改变进程的操作系统权限：没有容器、没有用户切换、没有只读挂载。`workspace-write` 的 `shell` 一旦被批准，子进程就和启动它的人同权，可以 `cd ..` 走出工作区；`Workspace` 的路径守卫也只拦模型手滑，不拦恶意代码（[ADR-0008](./0008-trusted-local-agent.md)）。真要隔离，用容器、虚拟机、独立用户或只读挂载，而不是继续往字符串判断上加规则。
- 审批是给人看的：提示里的命令会被压成一行并截断到 160 字符，放行的仍是原始参数。用户看到的不是完整命令时，需要自己判断要不要按 `y`。
- `full-access` 没有二次确认；把它设成默认或写进脚本，等于放弃这层保护。
- 无 TTY 的非交互运行无法批准 `shell`，这是有意的默认拒绝；需要 shell 的自动化应显式使用 `full-access`。

## 不变量

- 权限拒绝永远折成非空 `ERROR` 文本，不抛异常、不终止 Run。
- 权限检查必须发生在参数校验之后：坏参数先按参数错误回灌，不打扰用户审批。
- 被拒绝的工具一行代码都不执行。
- 审批的异常、取消、EOF 都收敛为拒绝，绝不会变成放行。

# Permission 是工具调用策略，不是沙箱

Permission v0.1 给 agent 三档模式：`read-only` 只放行 `read` / `ls` / `glob` / `grep`；`workspace-write`（默认）再放行 `write` / `edit`，`shell` 每次执行前问人；`full-access` 放行全部工具、不审批。

## 决定

- 检查点在 `ToolRegistry.execute()`：参数校验之后、`tool.run()` 之前。拒绝不执行工具，返回一条 `ERROR: permission denied: …` 的 **Tool result**，模型下一轮可以自己换做法。
- 权限按工具名分档，不看参数。路径是否越界仍由 `Workspace` 的路径守卫判断；两层各管一件事。
- 权限由宿主显式注入：`ToolRegistry` 构造时必须传 `permission: Permission | null`；漏传、`undefined`、非法值直接抛错；`null` 只表示宿主主动声明不检查。CLI 传 `workspace-write`，评测传 `full-access`。
- 模型提示由 `permissionPrompt(mode)` 生成，CLI 把它拼进唯一的 system 消息；Agent 每次请求前原地刷新，`/permission` 切换后下一次请求立即生效，不追加新的 system 消息。它只指导模型，放行/拒绝仍由 `ToolRegistry` 强制执行。`read-only` 的提示会明确覆盖基础提示里的工具清单，避免两套规则看起来互相矛盾。
- 审批提示懒创建 readline：没有 `shell` 调用的任务不进入终端 raw mode，Ctrl-C 仍走原取消链；REPL 里如果任务运行时已经排着下一行输入，这次 `shell` 会被拒绝，那一行留给下一轮，避免把任务当成审批答案。
- 审批等待用 `askWithSignal` 把 `AbortSignal`、readline 的 `close` 和正常回答一起收口：Ctrl-C 立即结束等待并走取消链，EOF 明确按拒绝处理，不会停在 `question()` 上。
- `shell` 的审批是**逐次**的：允许一次或拒绝，不缓存「上次同意过」。没有 TTY、取消、审批通道异常都按拒绝处理；无 TTY 时不读 stdin，避免把管道里的下一行任务当成审批答案。
- REPL 与审批共用同一个 readline，并按顺序一次只等一行；`/reset` 换 Agent 但不换 Permission 对象。
- CLI 用 `--permission` 选起始模式，REPL 用 `/permission` 查看和切换。

## 为什么

把检查放在 `ToolRegistry`，是因为它是所有 Tool call 的唯一入口：Agent Loop 一行不用改，新增工具也不会绕过去。放在 Agent 里会让内核认识权限概念；放在每个工具里则要把同一条规则抄七遍，迟早漏一个。

默认 `workspace-write` 是可用性与风险的折中：日常改代码不需要每次确认，而唯一能跑任意命令的 `shell` 单独停下来问人。`read-only` 给「先看看」的场景；`full-access` 给用户明确信任的自动化场景。

## 代价与边界

- **这不是沙箱。** Permission 不改变进程的操作系统权限：没有容器、没有用户切换、没有只读挂载。`workspace-write` 的 `shell` 一旦被批准，子进程就和启动它的人同权，可以 `cd ..` 走出工作区；`Workspace` 的路径守卫也只拦模型手滑，不拦恶意代码（[ADR-0008](./0008-trusted-local-agent.md)）。真要隔离，用容器、虚拟机、独立用户或只读挂载，而不是继续往字符串判断上加规则。
- 审批是给人看的：提示完整展示待执行命令与实际 cwd；多行命令逐行标记，控制字符与 bidi 控制字符转义，不折叠换行、不截断尾部。放行的仍是原始参数，展示层只负责不误导。
- 唯一的 system 消息内容会被原地刷新：Transcript 保留消息顺序与 assistant/tool 配对，但不保留每次请求的历史 Prompt 快照；需要审计每次请求时，应记录请求体，而不是回看 Transcript。
- `full-access` 没有二次确认；把它设成默认或写进脚本，等于放弃这层保护。
- 构造期强制选择把一个装配错误变成启动失败：测试/评测必须显式写 `null` 或传 `Permission`，不能靠漏参数偷懒。这是有意的代价。
- 无 TTY 的非交互运行无法批准 `shell`，这是有意的默认拒绝；需要 shell 的自动化应显式使用 `full-access`。

## 不变量

- 权限拒绝永远折成非空 `ERROR` 文本，不抛异常、不终止 Run。
- Prompt 只指导模型；真正的放行/拒绝始终由 `ToolRegistry` 和 `Permission` 执行，不允许用 Prompt 代替检查。
- 审批展示必须包含完整命令与实际 cwd；控制字符转义，不折叠换行、不截断尾部。
- 权限检查必须发生在参数校验之后：坏参数先按参数错误回灌，不打扰用户审批。
- 被拒绝的工具一行代码都不执行。
- 漏传权限策略不可能静默变成「不检查」：要么显式 `Permission`，要么显式 `null`。
- 审批的异常、取消、EOF 都收敛为拒绝，绝不会变成放行。

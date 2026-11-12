# 权限与访问设计（当前实现）

> 状态：现行实现说明。历史三档权限（`read-only` / `workspace-write` / `full-access`）与 Shell 审批
> 已在 [ADR-0019](./adr/0019-full-access-is-the-only-mode.md) 中删除；本文只描述现在的行为。

## 一句话

agent-Kernel 只有一种运行模式：**完全访问（Full Access）**。没有权限模式、没有审批、没有工作区目录边界。

## 执行链

```
CLI / TUI → Agent.run → ToolRegistry.execute → tool.run → Workspace
```

`ToolRegistry.execute()` 只做四件事：

1. 按名字找工具（未知工具折成 `ERROR` 文本）。
2. 解析 `arguments` JSON（坏 JSON 折成 `ERROR` 文本）。
3. 按工具自己的 JSON Schema 校验必填字段与基础类型（不合法折成 `ERROR` 文本）。
4. 调用 `tool.run(args)`；普通异常折成 `ERROR` 文本，进程树清理未确认时抛 `ProcessCleanupError`。

**没有权限检查点。** `ToolRegistry` 构造时不再接受 `permission` 参数，代码里不存在 `Permission` 类型。

## 路径解析

文件工具（`read` / `write` / `edit` / `ls` / `glob` / `grep`）共用两条规则：

- `Workspace.resolve(requested)` = `path.resolve(root, requested)`。
  - 相对路径以 `WORKDIR`（或 `--cwd`）为基准；
  - 绝对路径直接使用；
  - `../` 可以走出默认目录；
  - 不做「是否在默认目录内」的判断。
- `Workspace.resolveReal(absolute)` = 解析到真实路径。
  - 已存在的路径用 `realpath`，符号链接 / junction 解析到实际目标；
  - 目标不存在时（如 `write` 新文件）沿父目录找到最近存在的祖先，再把剩余部分拼回；
  - 路径存在却无法解析（坏链接）时报 `cannot resolve path: …`，不猜测目标。

`glob` 的搜索根默认是 `WORKDIR`，也可以由 `path` 参数指定任意目录；模式本身允许绝对路径。模式中间的 `..` 会被拒绝（glob 语义下没有唯一解释），开头的 `../` 会把搜索根上移。

结果路径的显示规则：在默认目录内用相对路径，在默认目录外用绝对路径（`glob` 与 `grep` 一致）。

## Shell

`Workspace.run(command)`：

- 以 `WORKDIR` 为默认 cwd 启动；命令内部可以 `cd` 到任意位置，也可以使用绝对路径。
- 不需要任何人工审批。
- 保留：默认 120s 超时（工具参数可到 600s）、输出 8,000 字符上限、`AbortSignal` 取消、stdout/stderr、exit code、整棵进程树清理（Windows `taskkill` 有 2s 等待与 4s close 期限，清理未确认时显式报告）。
- 后台任务（`background:true`）返回 `job-N`，日志写系统临时目录，`shell-output` 增量读取，`shell-kill` 停整棵进程树。

## 网络

- 代码里没有域名白名单 / 黑名单、网络开关或代理逻辑。
- 唯一的主动 HTTP 请求在 `src/llm.ts`，发往配置的 `BASE_URL`；不限制目标域名。
- Shell 能访问的网络与启动它的操作系统账户一致；实际连通性由操作系统、代理和防火墙决定。

## 稳定性保护（与权限无关，全部保留）

- 有界读取：`read` 最多 32 KiB / 8,000 字符；`edit` 最多 2 MB。
- 原子写入：临时文件 + `fsync` + `rename`，保留原权限，提交前复查目标身份与取消信号。
- 扫描预算：`glob` / `grep` / `ls` 最多 20,000 个目录项、200 条结果；`grep` 跳过 >1 MB 文件，正则匹配 2s 预算，超时终止 worker。
- 进程与取消：超时、`AbortSignal`、进程树清理、后台任务增量读取。
- 展示层：控制字符转义，避免工具输出改写终端。

## 明确不做的事

- **不是沙箱**：没有容器、用户切换、只读挂载或系统调用过滤。真正的边界是启动 Agent 的操作系统账户与系统安全策略。
- **不提供审批**：没有人工审批，也没有 AI 审批。
- **不提供模式切换**：`--permission` 与 `AGENT_PERMISSION` 已移除，显式传入会直接报错。
- **不隐藏目录黑名单**：路径解析里没有「某些目录禁止访问」的额外名单。

## 测试对应

| 行为 | 测试 |
| --- | --- |
| 工作区外读 / 写 / 改 / 列目录、绝对路径、`../` | `test/workspace.test.mjs` |
| 符号链接指向默认目录之外 | `test/workspace.test.mjs` |
| `glob` 搜索根、绝对模式、`..` 规则 | `test/workspace.test.mjs` |
| `grep` 搜索默认目录之外，结果用绝对路径 | `test/workspace.test.mjs` |
| 工作区外 Shell 删除文件 | `test/workspace.test.mjs` |
| Shell 无审批、无 TTY 也能执行 | `test/cli.test.mjs`、`test/tui.test.mjs` |
| `--permission` / `AGENT_PERMISSION` 已移除 | `test/cli.test.mjs` |
| `Shift+Tab` 不再是权限快捷键、状态栏固定完全访问 | `test/tui.test.mjs` |
| 超时 / 取消 / 进程树清理 / 输出上限 | `test/workspace.test.mjs`、`test/cli.test.mjs` |

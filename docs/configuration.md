# 配置与启动

> 这里写当前代码真正支持的配置。README 只保留快速开始。

## 1. 模型配置

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `API_KEY` | 无 | 模型 API Key |
| `OPENAI_API_KEY` | 无 | `API_KEY` 没填时的备用 Key |
| `BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容端点 |
| `MODEL` | `gpt-4o-mini` | 模型名称 |

仓库提供 `.env.example`，里面用 DeepSeek 的 OpenAI 兼容端点做示例。

## 2. 工作区

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `WORKDIR` | 当前启动目录 | 相对路径的默认基准 |
| `--cwd <dir>` | 无 | 启动时直接指定工作区 |
| `-C <dir>` | 无 | `--cwd` 的短写法 |

`--cwd` 优先级高于 `WORKDIR`，两者都没设置时使用当前目录。

工作区不是权限边界。当前项目是 Full Access。

## 3. 执行预算

| 配置 | 默认值 | 作用 |
| --- | ---: | --- |
| `MAX_STEPS` | `30` | 一次 Run 的业务 Step 上限，最后一步用于收尾。网络重试、溢出重发与辅助摘要单独计数 |
| `MAX_TOOL_CALLS` | `60` | 一次 Run 最多真正执行多少个 Tool call |
| `MAX_TOTAL_TOKENS` | `500000` | 一次 Run 的 token 软预算；`0` 表示不限制 |
| `MAX_OUTPUT_TOKENS` | `8192` | 单次模型响应的最大输出 token；同时从上下文窗口里预留给模型输出 |
| `CONTEXT_WINDOW_TOKENS` | 未设置（或 `0`） | 模型上下文窗口总量，单位 token；设置后才启用 Token 估算。必须大于 `MAX_OUTPUT_TOKENS`，窗口大小由模型服务决定，内核不按模型名称猜 |
| `TOOL_TIMEOUT_MS` | `120000` | 单条 Shell / 工具操作的默认超时 |

Step 和 Tool call 必须分开看：一次模型回复可以要求多个 Tool。

未配置上下文窗口时，Core 使用默认 120000 字符预算；配置后按窗口扣除输出预留，并用最近一次真实 prompt usage 校准估算。估算不是精确 Tokenizer。

### 上下文原文存档

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `AGENT_CONTEXT_ARCHIVE` | 系统临时目录下的 `agent-kernel-context/` | 有损压缩前保存原文的根目录；每个 Agent 会话单独建子目录 |

存档可能包含密钥、源代码和工具输出，不要指向项目仓库，也不要随意共享。当前不会自动清理，需由宿主或操作系统管理。

## 4. CLI 展示

| 配置 / 参数 | 作用 |
| --- | --- |
| `--tui` | 显式进入 TUI |
| 不带任务 | 进入 TUI；它是当前唯一的交互模式 |
| `--details` | 让一次任务使用 detailed 工具结果展示 |
| `AGENT_VIEW=compact` | 默认，每个 Tool 一行摘要 |
| `AGENT_VIEW=detailed` | 展开 Tool 结果，最多展示 4000 字符 |
| `AGENT_VOICE` | `balanced` / `energetic` / `playful` / `tsundere` / `curious` / `gentle` / `confident` |

角色台词只属于展示层，不进入 Transcript。

## 5. TUI 配置

| 配置 | 作用 |
| --- | --- |
| `AGENT_TUI_COLOR` | `mono` / `full`，控制层次配色 |
| `AGENT_TUI_THEME` | `dark` / `light` / `ansi`，选择颜色方案 |
| `AGENT_TUI_GLYPHS` | `unicode` / `ascii`，强制选择字形方案 |
| `AGENT_EDITOR_FILE` | 指定外部编辑器要使用的文件路径；默认由编辑器流程自行创建 |

如果终端是非 TTY，TUI 会退化为普通文本输出。

## 6. 工具日志

设置：

~~~powershell
$env:AGENT_TOOL_LOG="C:\path\to\tool-log.jsonl"
~~~

之后每次 Tool 调用会追加一行 JSON。

注意：日志可能包含命令、文件正文和其他敏感内容，不做脱敏。不要把它写进 Git 仓库。

## 7. 演示标记

`AGENT_DEMO=1` 只用于界面标记“外部 Mock 演示”。它不会自动启动 Mock 服务，也不会绕过 API Key 检查。

## 8. 命令

~~~powershell
npm run agent -- "任务"
npm run agent --
npm run agent -- --tui "任务"
npm run agent -- --details "任务"
npm run agent -- --cwd "D:\project" "任务"
~~~

安装成全局命令：

~~~powershell
npm link
agent
agent-kernel
~~~

## 9. 多行任务

Windows 下 `npm run` 会经过 `cmd.exe` 转发参数，多行任务可能在第一行就被截断。

多行任务直接走入口：

~~~powershell
node --env-file-if-exists=.env src/cli.ts "<多行任务>"
~~~

## 10. 已删除的配置

以下配置已经不是当前系统的一部分：

- `--permission`。
- `AGENT_PERMISSION`。
- `--repl`。
- 三档权限模式。
- 权限规则文件。

如果显式传这些已删除参数，CLI 会报错，而不是静默忽略。
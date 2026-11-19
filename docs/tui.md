# TUI 使用说明

> TUI 是 Session 的展示外壳，不是另一套 Agent Runtime。

## 1. 怎么进入

~~~powershell
npm run agent --
~~~

也可以：

~~~powershell
npm run agent -- --tui "先看看这个项目的结构"
~~~

不在 TTY 环境时，程序不会强行画终端界面，而是输出普通文本。

## 2. 主屏和 transcript

当前 TUI 不把整个终端切到备用屏。

主屏负责：

- 已经完成的内容直接进入 Shell scrollback。
- 只有底部活动区会刷新。
- 用户可以直接使用终端原生滚动、选择和复制。

需要详细回看时按 `Ctrl+T` 进入 transcript 视图。

transcript 视图会临时使用备用屏，退出后主屏原样恢复。

这个决定来自 [ADR-0017](./adr/0017-tui-renders-on-main-screen.md)。

## 3. 按键

| 按键 | 作用 |
| --- | --- |
| `Enter` | 发送 |
| `Shift+Enter` | 换行 |
| `Ctrl+J` | 换行兜底 |
| `@` | 补全工作区文件路径 |
| `Ctrl+X` → `Ctrl+E` | 用 `$VISUAL` / `$EDITOR` 编辑当前输入 |
| `↑` / `↓` | 翻输入历史 |
| `Ctrl+C` | 取消当前 Run |
| `Ctrl+T` | 进入 / 退出 transcript 视图 |
| `Ctrl+E` | 翻阅 / 展开轮次 |
| `Ctrl+G` | 定位并展开工具详情 |
| `Ctrl+O` | 切换最近工具组的展开状态 |
| `PgUp` | 暂停活动区刷新，方便往上看 |
| `PgDn` / `Esc` | 恢复活动区刷新 |

注意：`Ctrl+E` 单独按是历史展开；编辑器是 `Ctrl+X` 后再按 `Ctrl+E`，两者不是同一个快捷键。

## 4. 展示层到底显示什么

TUI 观察 Agent 事件，不修改 Agent 内部状态。

主要有：

- Thinking：等待模型响应。
- Tool call：模型要求执行什么。
- Tool result：实际执行结果。
- Tool error：工具失败原因。
- 最终回答。
- Session 的 requests / 摘要请求 / tool calls / tokens（摘要请求为 0 时不显示，避免每行都挂一个空字段）。

展示层的角色台词也不写进 Transcript。

## 5. 工具展示

默认是 compact：

~~~text
→ read README.md
✓ read
→ shell npm run check
✗ shell
~~~

需要更详细的 Tool 输出，可以：

~~~powershell
npm run agent -- --details "任务"
~~~

或者设置：

~~~powershell
AGENT_VIEW=detailed
~~~

detailed 视图的单个结果最多展开 4000 字符。

## 6. 颜色和字形

`AGENT_TUI_COLOR`：

- `mono`：默认，尽量少用颜色。
- `full`：显示更多状态层次。

`AGENT_TUI_THEME`：

- `dark`：默认。
- `light`：浅色终端。
- `ansi`：只使用终端自己的 16 色。

`AGENT_TUI_GLYPHS`：

- `unicode`：强制 Unicode 字形。
- `ascii`：强制 ASCII。
- 不设置：自动判断。

`TERM=dumb` 的交互终端不支持当前 TUI 所需的控制序列，会明确报错。

## 7. TUI 不负责什么

TUI 不负责：

- Agent Loop。
- Tool 执行。
- 权限判断。
- Transcript 的业务语义。
- 模型请求。

所以换掉 TUI，不应该改变 Agent 的执行结果。

## 8. 相关设计

- [ADR-0017：TUI 在主屏就地渲染](./adr/0017-tui-renders-on-main-screen.md)
- [ADR-0014～0016：历史 TUI 决策](./adr/)
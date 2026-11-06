# Claude Code CLI 真实界面截图参考

> 用于 agent-Kernel TUI 的**视觉对照**，并非本项目自己的 UI 设计素材。原图和相关权利属于各自发布者。截图来自不同版本的 Claude Code，不能逐字照搬功能和权限模型。
>
> 实施规范：[\`../tui-v0.3-layout-spec.md\`](../tui-v0.3-layout-spec.md)。
>
> 给 Codex：请逐张**查看实际图片**，比较终端中的空间布局、对话缩进、输入框、工具日志、等待状态与审批；只摘取交互设计原则，不要复制品牌标识或把“始终允许”权限加入 agent-Kernel v0.1。

## 01 · 启动与输入框

![Claude Code 启动和底部输入框](https://calv.info/coding-agent-metagame/cleanshot-2025-08-06-at-1222462x-7jrv29.png)

- **对照项**：顶部欢迎框、项目工作目录、输入框边界、快捷键提示。
- **来源**：[The Coding Agent Metagame](https://calv.info/coding-agent-metagame/)
- **原图**：https://calv.info/coding-agent-metagame/cleanshot-2025-08-06-at-1222462x-7jrv29.png

## 02 · 对话与工具调用

![Claude Code 读文件与搜索的工具调用状态](https://storage.googleapis.com/zenn-user-upload/93cee8213ec0-20250530.png)

- **对照项**：每个工具调用的层次、状态标记、文件路径和结果摘要、输入位置。
- **来源**：[Claude Code のスラッシュコマンド](https://zenn.dev/oikon/articles/b14af9c62b4010)
- **原图**：https://storage.googleapis.com/zenn-user-upload/93cee8213ec0-20250530.png

## 03 · Thinking / 等待模型

![Anthropic 官方文章中的 Claude Code 等待状态](https://cdn.sanity.io/images/4zrzovbb/website/a08ea13c2359aac0eceacebf2e15f81e8e8ec8d2-1600x1278.png)

- **对照项**：运行中的工具列表、动态等待文案、token/时间小字、底部输入框。
- **来源**：[Anthropic Engineering: Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- **原图**：https://cdn.sanity.io/images/4zrzovbb/website/a08ea13c2359aac0eceacebf2e15f81e8e8ec8d2-1600x1278.png

## 04 · Shell 命令审批

![Claude Code 的 Shell 命令审批界面](https://storage.ghost.io/c/57/9b/579b6dca-f48a-4307-844f-f0533595d058/content/images/2025/11/Claude-asking-for-permission-to-touch-a-file.png)

- **对照项**：待执行命令与用户确认选项之间的明显分隔。
- **来源**：[How to Use Claude Code Safely](https://www.producttalk.org/how-to-use-claude-code-safely/)
- **原图**：https://storage.ghost.io/c/57/9b/579b6dca-f48a-4307-844f-f0533595d058/content/images/2025/11/Claude-asking-for-permission-to-touch-a-file.png
- **agent-Kernel 注意**：始终完整展示命令和 cwd，只支持允许一次/拒绝，不能照搬永久授权选项。

## 05 · 错误状态与文件访问审批

![Claude Code 工具读取报错及访问权限对话框](https://www.producttalk.org/content/images/2025/11/Asking-to-read-files-in-other-directories.png)

- **对照项**：工具成功/错误差异、失败原因、需要审批时的上下文。
- **来源**：[How to Use Claude Code Safely](https://www.producttalk.org/how-to-use-claude-code-safely/)
- **原图**：https://www.producttalk.org/content/images/2025/11/Asking-to-read-files-in-other-directories.png

## 06 · 权限管理菜单

![Claude Code Permission rules 列表与键盘操作提示](https://apifox.com/apiskills/content/images/2025/12/image-51.png)

- **对照项**：规则列表、选中态、方向键/Enter/Esc 提示。
- **来源**：[Apifox: Claude Code Introduction](https://apifox.com/apiskills/what-is-claude-code-introduction/)
- **原图**：https://apifox.com/apiskills/content/images/2025/12/image-51.png
- **agent-Kernel 注意**：本期只有三个权限模式，不照搬细粒度持久规则。

## 07 · Slash 命令菜单

![Claude Code 输入斜杠后的命令和说明列表](https://storage.googleapis.com/zenn-user-upload/a1a1bd9205b5-20250530.png)

- **对照项**：输入斜杠后就近展示命令、选中高亮、简短说明、键盘操作。
- **来源**：[Claude Code のスラッシュコマンド](https://zenn.dev/oikon/articles/b14af9c62b4010)
- **原图**：https://storage.googleapis.com/zenn-user-upload/a1a1bd9205b5-20250530.png

## 对照改造优先级

1. 首先实现 **对话从顶部往下排列、输入框固定底部**，避免短回复沉在屏幕底端。
2. 调整用户、模型与工具的缩进、留白、图标与配色；等待状态不进入最终历史。
3. 审批界面必须完整显示原始命令、工作目录和明确的「允许一次 / 拒绝」。
4. 兼容 Windows Terminal 和传统 PowerShell，实际终端截图验收，不能只看字符串测试。

> 图片采用来源网站的原图地址，避免未经许可把第三方图片二次分发为仓库资产。如需离线比对，可在确认转载许可后保存到本目录并改为相对路径。

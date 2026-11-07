# TUI 参考截图对照与补完计划

2026-11-06。逐张打开 [参考目录](./claude-code-ui-references/README.md) 的 7 张原始 PNG 后记录；原图只在临时目录中查看，不作为仓库资产重新分发。实现仍以 [v0.3 布局规范](./tui-v0.3-layout-spec.md) 为准。

| 图 | 实际观察 | 本次采用 |
| --- | --- | --- |
| 01 启动 | 欢迎框只占顶部局部；输入横跨底部，有上下边界和框下快捷键小字 | 保留简洁两行 Header 与底部框；不搬入更新日志或欢迎 banner |
| 02 工具 | 绿点旁工具名称粗体中性白；下一行用分支符缩进显示行数/匹配数；等待提示在工具组下方 | 工具只强调状态符，名称中性粗体；结果另起缩进行，不把全文刷入对话 |
| 03 等待 | 工具组带树形缩进；Mulling 后有耗时和中断提示；底部输入仍存在 | 只显示真实请求等待的 Thinking、实际等待秒数和 Ctrl-C 提示，不展示内部思考或伪造 token |
| 04 Shell 审批 | 工具调用与审批区间有横线；命令、说明与选项之间有留白；当前选择清晰 | 命令中性高对比，面板边界/授权提示强调色；y/N 输入明确，标注默认拒绝 |
| 05 工具失败 | 失败工具和原因粉红，成功工具为绿点；长路径自然换行；审批独立成块 | 失败原因单独缩进并完整保留；拒绝、失败、未执行继续使用不同符号和文案 |
| 06 权限菜单 | 列表装在独立面板，标题/选中态突出，键盘帮助在面板下方 | 采用清楚的当前上下文与键盘提示，不引入持久权限规则或方向键菜单 |
| 07 Slash 菜单 | 命令列表紧邻输入框，命令与解释分层，高亮只表示当前选择 | 保留 `/help` 入口，不扩展复杂补全菜单；输入、状态与操作提示保持就近 |

## 实施步骤

- [x] `test/tui.test.mjs` 先红后绿：工具名称与状态色分离、结果子行、Thinking 秒数与清除、Shell 默认拒绝/y-N 输入。
- [x] `src/tui.ts` 只改显示层：工具行语义样式、结果层次、暂态等待计时、审批上下文；readline、Permission、Session、Agent loop 不变。
- [x] 使用微软官方签名的 Windows Terminal ZIP 的 portable 模式进行真实窗口验收；独立临时配置，保存空会话、短回答、Thinking、工具状态与审批截图。
- [x] 运行 check / eval:check，独立评审，准备提交和推送原 PR；不合并。远端 Linux/Windows CI 以 PR 当前 head 为准。

结果见 [Windows Terminal 实际截图](./verification/tui-v0.3-windows-terminal/README.md)。

Windows Terminal 的 portable 模式遵循 [微软说明](https://learn.microsoft.com/en-us/windows/terminal/distributions#enabling-portable-mode)，配置与程序均在临时目录；不更改系统默认终端。

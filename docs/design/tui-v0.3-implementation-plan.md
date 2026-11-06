# TUI v0.3 布局补完计划

按 [字符布局与视觉验收规范](./tui-v0.3-layout-spec.md) 在 PR #9 原分支迭代。范围仅为 TUI 显示和相关测试，运行时零依赖。

- [x] 在 `test/tui.test.mjs` 增加回归：长输入和光标不越框，滚动保留编辑，新输出仍可渲染；运行测试确认旧实现失败。
- [x] 在 `src/tui.ts` 保留 readline 编辑，拦截其终端回显，由统一渲染器绘制有界输入行；正文续行缩进，工具与回复留白，输入边框强调。
- [x] 审批独立保留原始 request，按当前宽度生成完整面板，避免日志裁剪；补充超长、多行、控制字符和 resize 测试。
- [x] 窗口缩至最小尺寸以下时降级逐行输出，恢复尺寸后重新绘制；`TERM=dumb` 不发送光标定位序列。
- [x] 运行 `npm run check`、`npm run eval:check`，用真实 Windows 终端运行空会话、短回复和审批并保存截图；记录终端、主题和未验证环境。
- [x] 独立代码评审，修复有效问题，准备提交和推送原 PR；不合并。

远程提交与 Linux/Windows CI 结果以 [PR #9](https://github.com/wwxst/agent-Kernel/pull/9) 当前 head 的 checks 为准；截图及本地验证见 [验收记录](./verification/tui-v0.3/README.md)。

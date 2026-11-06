# Claude 截图反馈后的实机迭代

2026-11-06，Asia/Shanghai；继续 [PR #9](https://github.com/wwxst/agent-Kernel/pull/9)。本记录接续[上一轮报告](../tui-live-comparison-2026-11-06.md)，不将上一轮截图当作当前实现。

## 同步与范围

先保存本地修改，再从 `2ddea6c` fast-forward 同步远端 9 个提交到 `566866cf4e6881592b01d89beb2a0054808c7948`，恢复本地修改并解决冲突。保留远端的 `flowInput`、CLI 默认启用自适应输入、浅色主题下可读的用户消息配色与就近审批布局。原始 stash 作为备份保留，没有覆盖远端提交，也没有强制推送。

本轮显示层提交为 `eaa374838720d8102e24365f2b7fca92d5ec2685`、注释补齐 `291f6efbadb01fcd7e4a36cbd6b09d25f99f915a`、审查修复 `4fbbba80839b9fdfe0557aa8fbc8d16c478348fc`，以及跨平台测试修正 `bf5f5ea67f8795bef2edd122608e478c5a5964ed`，只涉及 `src/tui.ts`、`test/tui.test.mjs` 与 UI 文档。没有修改 Agent Loop、LLM 请求、Prompt、Permission、ToolRegistry、工具执行、Session / Transcript 语义或 token 统计，没有新增运行时依赖。

## 对照发现与修改

| 真实界面的差距 | 修改与再次运行结果 |
| --- | --- |
| 原输入区仍有四角、左右竖线和额外横向缩进；Claude 是两条水平线与裸提示符 | 改成灰色上下水平分隔线，标题、正文、输入共用左边缘；只预留最右一列，避免终端自动换行。现代终端使用稳定块光标，退出恢复默认样式 |
| 对话后仍重复展示占位符 | 仅空会话显示占位符，已有对话后保留提示符、草稿和光标 |
| 远端短会话流式布局已有改善，但完成状态与输入间有两行空白 | 收紧为一行；长会话、翻阅历史仍底部停靠，审批决定紧挨完整面板 |
| 等待只有一条静态文字，缺少主次层次 | 200ms 动画符号；主状态用强调色，实际经过秒数用灰色，取消提示放次行；正文或工具开始后停止等待计时 |
| 工具执行只有标题、缺少明确的中间状态 | 执行时派生 `Running...` 子行，结果到达原地替换且移除子行；实机发现它误出现在待审批界面后立即修复，待审批仅展示面板并保留工具标题 |
| 一轮完成后没有独立的耗时小字 | 使用 UI 实际计时显示 `Worked for Ns` / `Stopped after Ns`，工具调用数直接沿用已传入的 Run 统计；后续模型等待只显示实际收到的工具结果数，不模拟 token 或思考内容 |

## 真实环境与截图

- 工作区为 `C:\Users\Administrator\Desktop\测试`，源码在 `E:\JavaProjects\web-project\agent-Kernel`。测试目录仍只有原有 `你好世界.txt`，13 字节，没有破坏性操作。
- Windows Terminal portable `1.25.2733.0`；两边实际使用 PowerShell 5.1、One Half Dark、Consolas 12pt、padding 12，主要尺寸 120×35，另验 80×24。临时终端尺寸设置在验收后从备份恢复。
- Claude Code `2.1.318` 与 agent-Kernel 均使用实际 `hy3` 端点。Claude 请求已成功；截图中的自定义模型名提示仍保留。没有修改 Claude 安装文件、配置或内部实现。
- 传统 PowerShell 为独立原生 console，80×24、ASCII、`NO_COLOR`、本轮默认黑色背景；并非仅在 Windows Terminal 中模拟旧终端。
- 下列 PNG 是实际窗口原图，包含窗口标题栏，使用 Win32 PrintWindow 获取；没有把 HTML / ANSI 测试输出画成截图。输入区和中间状态的叠加对照另以用户原图和本轮原图做等比例、透明度可调的裁切展示，不改写原图像素。

| 场景 | Claude Code | agent-Kernel |
| --- | --- | --- |
| 启动 | [上一轮真实启动](../tui-live-20261106/claude-start.png) | [本轮启动](./agent-start-final.png) |
| 相同的不存在文件任务 | [完成回复](./claude-complete.png) | [错误、回复与完成耗时](./agent-complete-final.png) |
| 等待与中间详情 | [处理中](./claude-thinking.png)、[真实展开详情](./claude-detail.png) | [两层等待状态](./agent-thinking-final.png) |
| Shell 审批与运行 | [上一轮真实审批](../tui-live-20261106/claude-approval.png) | [审查修复后待审批](./agent-approval-review-final.png)、[允许后执行中](./agent-running-final.png)、[拒绝后等待模型](./agent-denied-review-final.png) |
| 长回复与窗口调整 | [上一轮长回复](../tui-live-20261106/claude-long.png) | [45 行中英混排与底部停靠](./agent-long-final.png)、[翻阅历史、草稿与 80×24 resize](./agent-resize-history-final.png) |
| 取消与兼容性 | 见上一轮报告 | [Ctrl-C 返回 PowerShell](./agent-cancel-final.png)、[传统终端启动](./classic-start-final.png)、[中文短回复](./classic-chinese-final.png)、[EOF 退出](./classic-eof-final.png) |

`input-first-pass.png`、`agent-thinking.png`、`agent-thinking-synced.png` 和 `agent-complete-before-gap.png` 是本轮迭代过程截图，保留以说明变化，不是最终效果。`agent-running-final.png` 捕获于待审批子行修复前；该修复仅隐藏待审批时的子行，实际允许后的运行显示不变。

## 验证与已知边界

- `npm run check`：strict typecheck 通过，267 tests / 260 pass / 7 platform skips / 0 fail。
- `node --test test/tui.test.mjs`：55/55；新增 8 项 UI 行为测试，并增强现有审批、配色、光标与布局断言。审批误显示运行状态、拒绝后微任务间隙误报、窄窗口首次进入布局光标缺失的回归均先确认失败，再修复通过。
- `npm run eval:check`：20/20；`git diff --check` 通过。
- 本机默认 ASCII 与显式 Windows Terminal Unicode 路径的 TUI 测试分别为 55/55。
- 真实运行验证：空会话、同一不存在文件任务、中文短回复、Thinking、实际流式长回复、无害 Shell 允许与拒绝、运行状态、长会话停靠、PageUp/PageDown、带中文草稿的 resize、Ctrl-C 与传统终端 EOF。上一轮多行长命令、审批 EOF / Ctrl-C 等结果保留在历史报告；本轮没有把未重复的场景称为重新实测。
- Standards / Spec 独立审查见下文；不以自动测试代替视觉验收。

## Standards

首次发现 1 项低严重度规范问题：新增终端英文文案的逐行中文对照不全，违反 `CODING_STANDARDS.md` §2.9。已在 `291f6ef` 补齐并复核通过。后续 `4fbbba8` 的私有显示状态、首次布局光标初始化与公共接口回归测试复审无新增问题；未发现需要抽象处理的 Fowler smell。

## Spec

首次发现 2 项显示问题：拒绝审批后、工具结果回传前会短暂重现 `Running...`；窄窗口启动再放大没有应用块状光标。已在 `4fbbba8` 修复并复核通过，未改变授权判断或返回值；重新启动实机截图确认待审批与拒绝不显示执行中。窄窗口首次进入布局的光标分支由自动回归验证，本轮没有将其称为单独的实机验收。

两轴最终无未解决发现；Standards 原 1 项、Spec 原 2 项均已处理。

## GitHub CI

`4fbbba8` 的 [run 42180532312](https://github.com/wwxst/agent-Kernel/actions/runs/42180532312)：Windows 通过；Linux 有 3 项新增 UI 测试失败，原因是断言写死了 ASCII 字形，实际 Linux 正确输出 Unicode 分隔线与提示符。`bf5f5ea` 仅修正这些断言，使两套字形均可验证，线宽、上下线一致性、光标与输入原文断言保留；没有为通过 CI 改动运行时行为。

修正后的代码 head `bf5f5ea67f8795bef2edd122608e478c5a5964ed`：[run 42180770694](https://github.com/wwxst/agent-Kernel/actions/runs/42180770694)，Linux 与 Windows 均 success，两边的 `Run checks` 和 `Self-check the evaluation set` 都通过。随后仅补充本报告与 21 张原图；文档提交的最终 head 检查结果同步到 PR 正文。

仍存在的差异：Claude 能展示折叠/展开的模型思考正文，当前 UI 回调没有该数据，本轮未越过显示层修改接口；Markdown 仍按纯文本展示，工具详情展开、原生多行输入和 Claude 的额外功能没有实现。用户消息色块、输入两条横线和过程信息层级已接近参考，但不能据此宣称所有场景完全一致。

未验证：原生中文 IME 候选框及组合态、复杂 emoji / ZWJ；控制字符与超长审批有自动回归，但本轮没有生成对应的真实模型截图。宽度仍使用现有近似 CJK 算法，慢终端的重绘闪烁仍需持续观察。

## 补充：Thinking 动画出现绿色方块

用户指出 Thinking 前的符号偶尔变成绿色方块。已在同一 Windows Terminal / Consolas 配置中复现：原第二帧 U+2733 带 Unicode Emoji 属性，被字体回退画成绿色 emoji，同时影响列宽。不是 ANSI 底色残留，也不是标题图标。此前截图只捕获了其他帧，漏掉了这一处。

动画改为 `✻`、`✶`、`✢`、`✦` 四个文本符号，传统终端的 ASCII 帧不变。新增公共 Tui 接口回归逐帧检查，确认旧版在 U+2733 失败，修复后全部通过。`npm run check`：268 tests / 261 pass / 7 platform skips / 0 fail；TUI 56 项通过，`npm run eval:check` 20/20。

[修复前原图](./spinner-emoji-before.png)与[修复后原图](./spinner-text-after.png)来自真实终端中运行的 Tui 模块。为稳定复现第二帧，临时字形探针冻结显示计时，没有发出模型请求；截图明确标注 `UI glyph probe`，不作为实际模型响应截图。源码只替换动画帧并补注释，未修改其他显示或执行逻辑。后续提交的 CI 结果记录在 PR 正文。

## 补充：耗时与下一轮消息之间的留白

用户实测发现 `Worked for 2s` 紧贴下一条用户消息。原因是用户消息只在末尾留空行，完成耗时写入后，下一次 Run 没有补上前置间距。现复用已有的空行去重逻辑，在追加用户消息前留一行；首条消息仍贴顶，不累计多余空行。

新增公共 Tui 接口回归，旧版明确在预期空行处出现 `second` 用户消息而失败，修复后通过。实际重启 CLI，在独立测试目录先请求只回复 OK，再询问能力，两次均不调用工具；[真实第二轮等待截图](./turn-gap-live-after.png)确认耗时和下一条用户消息间有一行空白。`npm run check`：269 tests / 262 pass / 7 platform skips / 0 fail，含 TUI 57 项；`npm run eval:check` 20/20。源码只增加消息前的显示空行，不改变 Run / Session 语义。

## 补充：Thinking 的点逐个出现

用户要求 Thinking 后的三个点逐个出现。固定布局现在按 `Thinking` → `Thinking.` → `Thinking..` → `Thinking...` 循环，每阶段 400ms。点的位置预留三列，避免耗时信息左右跳动；正文、工具或错误到达时依然清除等待状态并停止动画。

新增回归先确认旧版恒定三个点失败，再验证完整点数循环、固定耗时列及重置；现有等待清理与真实秒数断言同步调整。`npm run check`：270 tests / 263 pass / 7 platform skips / 0 fail，含 TUI 58 项；`npm run eval:check` 20/20。实际重启 CLI 请求无工具的中文短回复，连续原图捕获[一个点](./thinking-dots-live-a.png)、[两个点](./thinking-dots-live-b.png)与[循环清空](./thinking-dots-live-c.png)；没有模拟模型响应。新窗口 `agent-Kernel TUI dots` 保留供继续体验。

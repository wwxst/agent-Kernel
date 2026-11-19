# ADR-0032　提示词按 Claude Code 资料复用，不自己另写一套

- 状态：已采纳（2026-11-18）
- 影响范围：`src/core/agent.ts`、`src/tools/subagent.ts`、`src/tools/todo.ts`、`src/tools/workspace.ts`、`src/cli.ts`、`src/core/context-compact.ts`、`src/model/skills.ts`，以及相关测试与文档

## 背景

之前的提示词是随手写的短句：默认系统提示 11 条、子 Agent 各 6 条、工具说明各一两句。它们没错，但缺了成熟编码 Agent 已经验证过的一批规则 —— 改之前先看、不做任务之外的抽象、危险动作先确认、只改已有文件、先裁剪再总结、摘要要保留安全约束等等。

手上正好有一份 Claude Code 2.1.304 的提示词提取资料（主 Agent、内置 Agent、工具说明书、压缩摘要、Skill 目录机制，中英对照）。既然规则已经有人写得更完整，就不该再自己发明一套措辞。

## 决定

- **母本是那份资料，逐句复用英文。** 能直接用的句子照搬，不重写成自己的话；只改三类事实：
  1. 身份不是 Claude Code；
  2. 工具名换成本仓库的真名（`Bash` → `shell`，`Read` → `read`，依此类推）；
  3. 本仓库没有的能力整句删掉（审批弹窗、权限模式、并行工具调用、`Monitor`、`WebFetch`、MCP、Plan 模式）。
- **中文对照保留。** 每行英文上方仍有中文注释；资料里大部分中文只是「内容提示·非逐字翻译」，所以中文是重新写的，不从资料里粘。
- **主提示改成分节结构**：`# Tone and style`、`# Doing tasks`、`# Delivering work`、`# Executing actions with care`、`# Using your tools`，句子与顺序沿用资料；事实句（完全访问、路径规则、工具清单）用本仓库自己的。
- **三种角色提示**：Explorer 整份按资料里的 Explore agent 重写（身份、只读红线、禁止动作、交付要求）；Worker 按 General-purpose + Coordinator Worker；主 Agent 的委派规矩按 Subagent 工具说明与 Coordinator 规则。计划指导用资料里「Using your tools」关于 task 工具的那几句（资料没有 TodoWrite 的独立提示词）。
- **工具说明书**按资料的 Read / Write / Edit / Glob / Grep / Bash 文案重写，但只保留与实现一致的部分：`grep` 是 JavaScript 正则而不是 ripgrep；`read` 接受相对路径并支持字节游标；`write` 不要求先读；`glob` 不按修改时间排序；`shell` 每次调用都是新进程、状态不跨调用保留。
- **压缩摘要改成资料的九节**：Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step。`{limit}` 契约、最小结构长度和候选提交验证都不动；命中门槛从「八节里至少四节」改成「九节按顺序出现且每节都有正文」，新增顺序与空节检查。
- **技能目录段**用资料里对 Skill 的定义与加载方式（「读文件代替默认做法」「只读这个任务需要的」「标了 user-invoked only 的只在点名时读」），机制不变：仍然只给目录、正文由模型自己 `read`。
- **测试口径跟着改**：摘要请求用首句前缀识别（不带句末标点）；压缩与预算用例固定一份 1086 字符的基线系统提示，让它们继续测压缩策略而不是默认提示的长度。

## 取舍与边界

- **体积涨了**：默认系统提示从 1086 字符涨到 7753 字符（约 2.6k token）。默认 `maxTranscriptChars` 是 120000，够用；但把字符预算设得很小的宿主（例如只给几千的测试）需要自己调大预算，否则会在一开始就判超窗。压缩测试就是这么处理的：固定基线提示，而不是放宽断言。
- **不照搬能力**：资料里的审批、权限模式、并行调用、Monitor、WebFetch、MCP 在本仓库都不存在，写进提示会让模型去调不存在的工具或等一个不会来的批准。这类句子一律删除，不是改写。
- **ADR-0025 的措辞部分让位**：0025 说子 Agent 提示「只给方向，不写步骤」。现在 Explorer 带上了资料的禁止清单与身份句，Worker 带上了「完整做完、只做分配的事」这类检查项。硬保证仍在内核里：工具表、预算、取消、进程树清理，提示词不承担这些。
- **资料的中文不可直接用**：8716 行仍是「内容提示」，所以中文对照是逐条重写的；资料只对英文原文负责。
- **没有移植的部分**：`AGENTS.md` 注入段（资料里没有对应文本）、`SKILL.md` 正文（26 份 CLI Skill 多为 Claude 专用，6 份 Desktop Skill 带大量脚本）。这两块保持原样，另作决定。
- **只改文字，不改行为**：循环、工具语义、权限、统计都没动；改的只是发给模型的文本和钉住这些文本的测试。

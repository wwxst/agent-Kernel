# 当前仓库系统性审查与优化交付

本次以磁盘实际状态和基线 `bacb4a498f45e76d79b7f04bee347d446723b746` 为准。初始工作区干净，未覆盖其他开发中的改动；未提交、推送、发布或合并。完整阅读 92 个代码文件（20303 行）及4个主要配置文件，修改处重新逐行复核。四个分工的阅读和定位证据都保留在下述报告中。

## 评分与覆盖

统一100分：正确性C30、健壮稳定R25、安全资源S15、性能P10、结构维护M20。所有文件从同一向量起扣，每项扣分都要对应代码事实、位置、影响和建议。分数是证据关联的审查量表，扣几分仍包含审查者判断，不能称为机器测量的绝对质量。100只表示本次未发现扣分项，不是无缺陷或全部验证通过的证明。未修风险在前后评分中均保留；故意有缺陷的评测输入按题目用途评价。

| 口径（文件等权，固定分母） | 文件数 | 修改前 | 修改后 |
| --- | ---: | ---: | ---: |
| 仓库代码与4个主要配置 | 96 | 98.24 | 99.58 |
| 全部代码（含评测题和上游模板） | 92 | 98.18 | 99.57 |
| 第一方维护代码（src/bin/test/eval入口） | 47 | 96.96 | 99.66 |
| 运行代码（src/bin） | 21 | 95.62 | 99.57 |

整体均值会受大量小文件影响，所以单列运行代码，并保留低分文件与全部扣分。主要低分部分：Workspace 79→100、TUI 74→97、ToolRegistry 90→100、项目指令91→99、评测汇总92→100。未做无证据的拆文件、引入框架或批量重命名。

逐行静态阅读覆盖：本清单代码92/92、主要配置4/4；修改hunk全部重读。此百分比只用于清单中的本次代码快照。依赖目录、Git内部数据、密钥、自动生成lockfile、历史评测JSON、图片和技能说明/元数据不在代码评分分母内；相关规范/ADR另按审查需要读取，没有声称其余全部文档也完成逐行审查。[机器清单](./2026-11-14-audit-inventory.json)保存每文件基线/最终Git blob、行数、维度分与证据报告。

## 问题与修改证据

- [Core/Todo报告](./2026-11-14-audit-core.md)：Schema副本、Hook测试假通过；含独立复核Workspace/评测/UI的记录。
- [模型/协议/CLI报告](./2026-11-14-audit-model-cli.md)：6个行为修复、2项注释规范修复、HTTP/SSE/AGENTS/终端错误边界。
- [UI报告](./2026-11-14-audit-ui.md)：15项初始问题、复核补充修正、输入/详情/编辑器/PNG/控制字符与仍保留的风险。
- [Workspace/评测报告](./2026-11-14-audit-workspace-eval.md)：glob/后台输出/任务池/汇总/成绩保存/快照；5个检查器漏检及1个上游模板缺陷的反例。
- [防复发记录](../notes/2026-11-14-audit-fixes.md)：现象、根因、解法和回归落点；读取与粘贴上限的可见变化同步到README和ADR-0022/0023。

新增32条回归，另加强既有断言。行为修复均记录先失败再通过；单纯注释和诊断I/O资源重构另作静态复核，未把正常大文件降级用例冒充并发OOM复现。

## 验证分层

| 层次 | 证据与结果 | 能证明/不能证明 |
| --- | --- | --- |
| 静态审查 | 92代码+4配置完整阅读；修改hunk重读；两个独立分工复核重点diff | 检查状态、分支、资源和设计；不能证明所有运行输入 |
| 基线自动检查 | npm run check：类型检查通过，433项中427通过/6跳过 | 原有测试基线；并未阻止此次新发现的问题 |
| 最终自动检查 | npm run check：exit0；类型检查通过；465项中459通过/6跳过/0失败，约15.88秒 | 包含公开接口单元测试、本地HTTP、真实子进程/文件系统和模拟终端集成；不等于真终端兼容性认证 |
| 评测自检 | npm run eval:check：20/20初始断言按预期失败，无模型请求 | 只能排除题目一开始就通过；5个已确认漏检仍存在 |
| 真实模型冒烟 | 标准.env加载器运行配置好的hy3；新临时工作区read→edit→最终答复，文件before换成after；exit0、3请求、2工具调用、5787tokens、约6秒 | 一条真实读写调用链可用；没有跑20题付费评测，也没有据此得出成功率 |
| 真实环境缺口 | 当前Windows；本轮未运行Linux/macOS实机、真实交互TTY/IME、跨天切版本实验 | 跳过项、平台语义、输入法与原生编辑器视觉接管均不作已验证声明 |

6个跳过项：POSIX权限保留、不可读文件chmod、POSIX后台后代清理、跨进程SIGINT，以及2个Linux PTY用例。真实模型只用标准启动器加载配置，没有显示凭据或改写用户.env；冒烟目录在系统临时目录，未触碰仓库任务文件。

本次运行环境为 Windows x64、Node v24.13.1；没有在本地验证项目最低支持的 Node 22.18，也没有触发远程 CI。`git diff --check` 通过。汇总证据见 [验证记录](./2026-11-14-audit-verification.json)；新增测试全部位于 package.json 原有测试清单中的文件，没有漏挂新的测试文件。最后一轮源码修改后重新执行了完整 check；之后只更新交付文档。

## 遗留缺陷与风险

已确认未修：5个评测检查器接受不完整解法，保留现有题目版本以维持历史可比性；上游wizard模板不能正确往返含单引号的dotenv值，仓库规范要求上游保持原样。各文件保留扣分，改进建议与反例见Workspace/评测报告。

静态确认、未做极端压力验证：文件补全索引和诊断快照的单目录枚举仍可一次分配很多条目；外部编辑器回读仍是同步全量读取。协议/平台潜在风险：多行SSE事件、POSIX特殊文件打开、非UTF-8后台日志、父目录TOCTOU、ACL/hardlink语义。UI模拟器不具备完整终端列宽/自动折行语义；既有部分测试仍依赖绝对布局行。这些项已在对应报告标识、评分或界限说明中保留。

没有声称所有风险消除，也没有把阅读完成或测试通过等同于全环境验证完成。

## 逐文件审查与维度前后分

向量顺序C/R/S/P/M，括号内总分。全文区间为1至该文件基线行数，具体长文件分块见模块报告；所有改变的hunk已二次阅读。“无额外扣分”表示未发现可证实的新问题，不能推导为无未知缺陷。

| 文件 | 基线→最终行数 | 修改前向量（总分） | 修改后向量（总分） | 依据 |
| --- | ---: | --- | --- | --- |
| [.agents/skills/diagnosing-bugs/scripts/hitl-loop.template.sh](../../.agents/skills/diagnosing-bugs/scripts/hitl-loop.template.sh) | 44→44 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [.agents/skills/wizard/template.sh](../../.agents/skills/wizard/template.sh) | 223→223 | 26/25/15/10/20（96） | 26/25/15/10/20（96） | [上游 dotenv 单引号往返缺陷；按规范不就地修改](2026-11-14-audit-workspace-eval.md) |
| [.env.example](../../.env.example) | 37→37 | 30/25/15/10/18（98） | 30/25/15/10/20（100） | [M2](2026-11-14-audit-workspace-eval.md) |
| [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | 87→87 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [bin/agent.mjs](../../bin/agent.mjs) | 32→32 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [eval/cross-day.mjs](../../eval/cross-day.mjs) | 404→404 | 30/25/15/10/19（99） | 30/25/15/10/20（100） | [M1](2026-11-14-audit-workspace-eval.md) |
| [eval/diagnostics.mjs](../../eval/diagnostics.mjs) | 351→371 | 26/25/11/9/19（90） | 30/25/13/9/20（97） | [D1/D2/M1；D-R1 前后保留](2026-11-14-audit-workspace-eval.md) |
| [eval/run.mjs](../../eval/run.mjs) | 346→352 | 28/20/15/10/20（93） | 30/25/15/10/20（100） | [E1/E2](2026-11-14-audit-workspace-eval.md) |
| [eval/selfcheck.mjs](../../eval/selfcheck.mjs) | 124→124 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/summary.mjs](../../eval/summary.mjs) | 128→137 | 25/22/15/10/20（92） | 30/25/15/10/20（100） | [E3/E4/E5](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/01-add-health-route/check.mjs](../../eval/tasks/01-add-health-route/check.mjs) | 12→12 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/01-add-health-route/files/server.mjs](../../eval/tasks/01-add-health-route/files/server.mjs) | 6→6 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/02-fix-failing-test/check.mjs](../../eval/tasks/02-fix-failing-test/check.mjs) | 16→16 | 26/25/15/10/20（96） | 26/25/15/10/20（96） | [已确认漏检，保留现有评测题版本；见反例表](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/02-fix-failing-test/files/sum.mjs](../../eval/tasks/02-fix-failing-test/files/sum.mjs) | 8→8 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/02-fix-failing-test/files/sum.test.mjs](../../eval/tasks/02-fix-failing-test/files/sum.test.mjs) | 15→15 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/03-rename-function/check.mjs](../../eval/tasks/03-rename-function/check.mjs) | 18→18 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/03-rename-function/files/api.mjs](../../eval/tasks/03-rename-function/files/api.mjs) | 3→3 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/03-rename-function/files/page.mjs](../../eval/tasks/03-rename-function/files/page.mjs) | 6→6 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/04-create-doc/check.mjs](../../eval/tasks/04-create-doc/check.mjs) | 23→23 | 26/25/15/10/20（96） | 26/25/15/10/20（96） | [已确认漏检，保留现有评测题版本；见反例表](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/05-extract-constant/check.mjs](../../eval/tasks/05-extract-constant/check.mjs) | 15→15 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/05-extract-constant/files/calc.mjs](../../eval/tasks/05-extract-constant/files/calc.mjs) | 14→14 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/06-guard-missing-file/check.mjs](../../eval/tasks/06-guard-missing-file/check.mjs) | 21→21 | 26/25/15/10/20（96） | 26/25/15/10/20（96） | [已确认漏检，保留现有评测题版本；见反例表](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/06-guard-missing-file/files/load.mjs](../../eval/tasks/06-guard-missing-file/files/load.mjs) | 6→6 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/07-add-quiet-flag/check.mjs](../../eval/tasks/07-add-quiet-flag/check.mjs) | 17→17 | 26/25/15/10/20（96） | 26/25/15/10/20（96） | [已确认漏检，保留现有评测题版本；见反例表](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/07-add-quiet-flag/files/cli.mjs](../../eval/tasks/07-add-quiet-flag/files/cli.mjs) | 5→5 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/08-extract-duplication/check.mjs](../../eval/tasks/08-extract-duplication/check.mjs) | 22→22 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/08-extract-duplication/files/validate.mjs](../../eval/tasks/08-extract-duplication/files/validate.mjs) | 13→13 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/09-update-readme/check.mjs](../../eval/tasks/09-update-readme/check.mjs) | 22→22 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/10-delete-dead-code/check.mjs](../../eval/tasks/10-delete-dead-code/check.mjs) | 17→17 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/10-delete-dead-code/files/app.mjs](../../eval/tasks/10-delete-dead-code/files/app.mjs) | 5→5 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/10-delete-dead-code/files/format.mjs](../../eval/tasks/10-delete-dead-code/files/format.mjs) | 4→4 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/10-delete-dead-code/files/legacy.mjs](../../eval/tasks/10-delete-dead-code/files/legacy.mjs) | 4→4 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/11-fix-slice-boundary/check.mjs](../../eval/tasks/11-fix-slice-boundary/check.mjs) | 12→12 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/11-fix-slice-boundary/files/list.mjs](../../eval/tasks/11-fix-slice-boundary/files/list.mjs) | 4→4 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/12-add-input-validation/check.mjs](../../eval/tasks/12-add-input-validation/check.mjs) | 19→19 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/12-add-input-validation/files/user.mjs](../../eval/tasks/12-add-input-validation/files/user.mjs) | 5→5 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/13-callback-to-promise/check.mjs](../../eval/tasks/13-callback-to-promise/check.mjs) | 33→33 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/13-callback-to-promise/files/app.mjs](../../eval/tasks/13-callback-to-promise/files/app.mjs) | 10→10 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/13-callback-to-promise/files/config.mjs](../../eval/tasks/13-callback-to-promise/files/config.mjs) | 8→8 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/14-fix-sort-order/check.mjs](../../eval/tasks/14-fix-sort-order/check.mjs) | 13→13 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/14-fix-sort-order/files/rank.mjs](../../eval/tasks/14-fix-sort-order/files/rank.mjs) | 4→4 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/15-merge-defaults/check.mjs](../../eval/tasks/15-merge-defaults/check.mjs) | 20→20 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/15-merge-defaults/files/config.mjs](../../eval/tasks/15-merge-defaults/files/config.mjs) | 5→5 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/16-handle-bad-json/check.mjs](../../eval/tasks/16-handle-bad-json/check.mjs) | 20→20 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/16-handle-bad-json/files/handler.mjs](../../eval/tasks/16-handle-bad-json/files/handler.mjs) | 5→5 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/17-write-missing-test/check.mjs](../../eval/tasks/17-write-missing-test/check.mjs) | 32→32 | 26/25/15/10/20（96） | 26/25/15/10/20（96） | [已确认漏检，保留现有评测题版本；见反例表](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/17-write-missing-test/files/slug.mjs](../../eval/tasks/17-write-missing-test/files/slug.mjs) | 8→8 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/18-remove-debug-logs/check.mjs](../../eval/tasks/18-remove-debug-logs/check.mjs) | 15→15 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/18-remove-debug-logs/files/app.mjs](../../eval/tasks/18-remove-debug-logs/files/app.mjs) | 10→10 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/19-banned-admin-bug/check.mjs](../../eval/tasks/19-banned-admin-bug/check.mjs) | 20→20 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/19-banned-admin-bug/files/access.mjs](../../eval/tasks/19-banned-admin-bug/files/access.mjs) | 15→15 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/20-fix-email-regex/check.mjs](../../eval/tasks/20-fix-email-regex/check.mjs) | 14→14 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [eval/tasks/20-fix-email-regex/files/validate.mjs](../../eval/tasks/20-fix-email-regex/files/validate.mjs) | 4→4 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [package.json](../../package.json) | 28→28 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [src/cli.ts](../../src/cli.ts) | 668→669 | 26/25/11/10/19（91） | 30/25/15/10/20（100） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [src/core/agent.ts](../../src/core/agent.ts) | 583→583 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [src/core/tool-hooks.ts](../../src/core/tool-hooks.ts) | 185→185 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [src/core/tool-log.ts](../../src/core/tool-log.ts) | 103→103 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [src/core/tool-registry.ts](../../src/core/tool-registry.ts) | 248→249 | 26/22/13/10/19（90） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [src/core/tool-result-status.ts](../../src/core/tool-result-status.ts) | 33→33 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [src/model/llm.ts](../../src/model/llm.ts) | 531→542 | 25/22/15/10/20（92） | 30/24/15/10/20（99） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [src/model/project-instructions.ts](../../src/model/project-instructions.ts) | 69→93 | 30/24/10/8/19（91） | 30/24/15/10/20（99） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [src/protocol/errors.ts](../../src/protocol/errors.ts) | 180→180 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [src/protocol/types.ts](../../src/protocol/types.ts) | 141→141 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [src/tools/grep-worker.ts](../../src/tools/grep-worker.ts) | 64→64 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [src/tools/todo.ts](../../src/tools/todo.ts) | 117→117 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [src/tools/workspace.ts](../../src/tools/workspace.ts) | 1749→1765 | 30/14/10/5/20（79） | 30/25/15/10/20（100） | [W1/W2/W3](2026-11-14-audit-workspace-eval.md) |
| [src/ui/cli-presenter.ts](../../src/ui/cli-presenter.ts) | 280→280 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [src/ui/file-index.ts](../../src/ui/file-index.ts) | 107→107 | 30/23/15/8/20（96） | 30/23/15/8/20（96） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [src/ui/prompt-history.ts](../../src/ui/prompt-history.ts) | 116→116 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [src/ui/text.ts](../../src/ui/text.ts) | 28→28 | 30/25/12/10/20（97） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [src/ui/tui-image.ts](../../src/ui/tui-image.ts) | 254→255 | 28/25/15/10/20（98） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [src/ui/tui-mood.ts](../../src/ui/tui-mood.ts) | 208→208 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [src/ui/tui.ts](../../src/ui/tui.ts) | 3598→3678 | 16/20/10/8/20（74） | 30/23/15/9/20（97） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [test/agent.test.mjs](../../test/agent.test.mjs) | 899→899 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [test/cli-presenter.test.mjs](../../test/cli-presenter.test.mjs) | 45→62 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [test/cli-pty.test.mjs](../../test/cli-pty.test.mjs) | 172→172 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [test/cli.test.mjs](../../test/cli.test.mjs) | 1062→1096 | 30/23/15/10/20（98） | 30/25/15/10/20（100） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [test/eval-diagnostics.test.mjs](../../test/eval-diagnostics.test.mjs) | 181→215 | 30/24/15/10/20（99） | 30/25/15/10/20（100） | [D1 的具体回归缺口](2026-11-14-audit-workspace-eval.md) |
| [test/eval.test.mjs](../../test/eval.test.mjs) | 138→238 | 30/21/15/10/20（96） | 30/25/15/10/20（100） | [E1/E2/E3/E4 的具体回归缺口](2026-11-14-audit-workspace-eval.md) |
| [test/file-index.test.mjs](../../test/file-index.test.mjs) | 74→74 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [test/llm.test.mjs](../../test/llm.test.mjs) | 590→620 | 30/22/15/10/20（97） | 30/25/15/10/20（100） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [test/model-errors.test.mjs](../../test/model-errors.test.mjs) | 67→67 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [test/project-instructions.test.mjs](../../test/project-instructions.test.mjs) | 76→87 | 30/24/15/10/20（99） | 30/25/15/10/20（100） | [见 model-cli 报告对应文件与问题编号](2026-11-14-audit-model-cli.md) |
| [test/prompt-history.test.mjs](../../test/prompt-history.test.mjs) | 84→84 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [test/selfcheck.test.mjs](../../test/selfcheck.test.mjs) | 116→116 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [test/support/eval-floating-check.mjs](../../test/support/eval-floating-check.mjs) | 76→76 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |
| [test/support/harness.mjs](../../test/support/harness.mjs) | 87→87 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [test/todo.test.mjs](../../test/todo.test.mjs) | 117→117 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [test/tool-hooks.test.mjs](../../test/tool-hooks.test.mjs) | 385→388 | 26/23/15/10/19（93） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [test/tool-log.test.mjs](../../test/tool-log.test.mjs) | 174→174 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [test/tool-registry.test.mjs](../../test/tool-registry.test.mjs) | 410→425 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 core 报告对应文件与问题编号](2026-11-14-audit-core.md) |
| [test/tui-image.test.mjs](../../test/tui-image.test.mjs) | 220→233 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [test/tui.test.mjs](../../test/tui.test.mjs) | 2534→2767 | 28/25/15/10/18（96） | 28/25/15/10/18（96） | [见 ui 报告对应文件与问题编号](2026-11-14-audit-ui.md) |
| [test/workspace.test.mjs](../../test/workspace.test.mjs) | 1334→1389 | 30/22/15/10/20（97） | 30/25/15/10/20（100） | [W1/W2/W3 的具体回归缺口](2026-11-14-audit-workspace-eval.md) |
| [tsconfig.json](../../tsconfig.json) | 16→16 | 30/25/15/10/20（100） | 30/25/15/10/20（100） | [本次完整阅读未发现额外可扣分项](2026-11-14-audit-workspace-eval.md) |

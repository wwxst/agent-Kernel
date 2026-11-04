# Issue tracker：本地 markdown

本仓库没有远端，issue 与 spec 以 markdown 文件的形式放在 `.scratch/` 里。

## 约定

- 一个特性一个目录：`.scratch/<feature-slug>/`
- spec：`.scratch/<feature-slug>/spec.md`
- 实现工单：每个一行文件，`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，绝不写成一个大文件
- 分诊状态写在文件顶部附近的 `Status:` 行，取值见 `triage-labels.md`
- 讨论追加到文件末尾的 `## Comments` 标题下

## 技能说「发布到 issue tracker」

在 `.scratch/<feature-slug>/` 下建文件（目录不存在就建）。

## 技能说「取出相关工单」

读它引用的那个文件路径。用户通常会直接给出路径或编号。

## Wayfinding 操作

由 `wayfinder` 使用。**map** 是一个文件，每个工单一个**子文件**。

- **Map**：`.scratch/<effort>/map.md`（Notes / 已定决策 / 迷雾 正文）。
- **子工单**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题。`Type:` 行记录工单类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**：顶部附近的 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 时，工单才算解除阻塞。
- **前沿**：扫 `.scratch/<effort>/issues/`，取未关闭、未阻塞、未认领的工单，编号最小的优先。
- **认领**：开工前写 `Status: claimed` 并保存。
- **解决**：在 `## Answer` 标题下追加答案，写 `Status: resolved`，再把一条线索（要点加链接）追到 `map.md` 的「已定决策」里。

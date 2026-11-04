# 已安装的 agent skills

这些目录原样复制自 [mattpocock/skills](https://github.com/mattpocock/skills)（MIT，Copyright (c) 2026 Matt Pocock）的
`skills/engineering` 与 `skills/productivity` 两组，每个子目录一个 `SKILL.md`。

- 安装时的提交：`4ae2317`
- 更新：重新 clone 上游仓库，覆盖对应目录；或用 `npx skills@latest update`
- 只装了一组：两组的技能有重叠（`grill-me` / `grilling`），全装会让同一件事出现两次

DSH 在会话开始时扫描 `<projectRoot>/.agents/skills`，所以增删技能后需要新开一个会话。

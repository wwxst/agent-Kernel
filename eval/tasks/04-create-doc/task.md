新建 `docs/usage.md`：

- 第一行是一级标题 `# 用法`；
- 正文用 Markdown 表格列出 `package.json` 里的每个 npm script：
  - 表格至少要有 `命令` 列和说明列（例如 `说明`）；
  - `命令` 列必须写完整的 npm 命令：`npm test` 或 `npm run <script>`，不能只写 script 名；
  - 说明列用一句话解释这条命令做什么；
  - 可以额外加一列 `脚本`，只写 script 名；
- 在 `README.md` 末尾加一行链接，指向这个新文件。

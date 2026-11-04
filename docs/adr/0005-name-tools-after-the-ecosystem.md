# 工具名沿用 agent 生态的通用叫法

工具叫 `read`、`write`、`ls`、`shell`，而不是按本仓库的模块或方法命名（`read_file`、`list_dir`、`run_command`）。

理由：工具名是模型看到的接口。`read` / `write` / `ls` / `shell` 在 Claude Code、Codex 这类 agent 里反复出现过，模型对它们有先验，选错工具、传错参数的概率更低；自造的名字则要为每个 token 额外解释。叫 `shell` 而不是 `bash`，是因为实现用的是 `spawn(command, { shell: true })`，真正由哪个 shell 解释取决于平台。将来增加精确编辑工具时，沿用生态里的 `edit`。

这条规则不限于工具名：类型名、函数名、文件名同理，通用版见 [CODING_STANDARDS.md](../../CODING_STANDARDS.md) 第 4 节（含 `ToolSpec` → `ToolDefinition`、`Toolbelt` → `ToolRegistry` 等判例）。

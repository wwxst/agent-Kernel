import assert from "node:assert/strict";
import path from "node:path";
import { readTaskFile, readTaskJson } from "../../checker-helpers.mjs";

export default async function check(root) {
  const usage = await readTaskFile(path.join(root, "docs", "usage.md"), "docs/usage.md");
  assert.equal(usage.split(/\r?\n/, 1)[0], "# 用法", "docs/usage.md 的第一行必须是 # 用法");

  const pkg = await readTaskJson(path.join(root, "package.json"), "package.json");
  const scripts = pkg.scripts ?? {};
  assert.match(usage, /^\|\s*命令\s*\|\s*(?:用途|说明)\s*\|/m, "正文必须有「命令 / 用途」表头");

  const rows = [...usage.matchAll(/^\|\s*([^|]+)\|\s*([^|]+)\|\s*$/gm)];
  const documented = new Map();
  for (const [, rawCommand, rawDescription] of rows) {
    const command = rawCommand.trim().replace(/^\x60|\x60$/g, "");
    const match = /^npm (?:run )?([a-zA-Z0-9:_-]+)$/.exec(command);
    if (!match) continue;
    assert.ok(Object.hasOwn(scripts, match[1]), `文档列出了不存在的 npm script: ${match[1]}`);
    assert.ok(!documented.has(match[1]), `npm script 重复列出: ${match[1]}`);
    assert.ok(rawDescription.trim().length > 0, `npm script ${match[1]} 缺少说明`);
    documented.set(match[1], command);
  }
  assert.deepEqual([...documented.keys()].sort(), Object.keys(scripts).sort(),
    "文档表格必须逐项列出 package.json 的全部 npm scripts");

  const readme = (await readTaskFile(path.join(root, "README.md"), "README.md")).replace(/\r\n/g, "\n");
  assert.ok(
    readme.startsWith("# fixture\n\n一个用来练手的小仓库。"),
    "README 原有标题和介绍必须保留，不能只留下新链接",
  );
  assert.match(readme.trimEnd(), /\[[^\]]+\]\(docs\/usage\.md\)\s*$/, "README 末尾必须有指向 docs/usage.md 的链接");
}

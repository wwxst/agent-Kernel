import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function check(root) {
  let usage;
  try {
    usage = await readFile(path.join(root, "docs", "usage.md"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") assert.fail("docs/usage.md 不存在");
    throw error;
  }
  assert.equal(usage.split(/\r?\n/, 1)[0], "# 用法", "docs/usage.md 的第一行必须是 # 用法");

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const rows = [...usage.matchAll(/^\\|\\s*([^|]+)\\|\\s*([^|]+)\\|\\s*$/gm)];
  const documented = new Map();
  for (const [, rawCommand, rawDescription] of rows) {
    const command = rawCommand.trim().replace(/^`|`$/g, "");
    const match = /^npm (?:run )?([a-zA-Z0-9:_-]+)$/.exec(command);
    if (!match) continue;
    assert.ok(Object.hasOwn(scripts, match[1]), `文档列出了不存在的 npm script: ${match[1]}`);
    assert.ok(!documented.has(match[1]), `npm script 重复列出: ${match[1]}`);
    assert.ok(rawDescription.trim().length > 0, `npm script ${match[1]} 缺少说明`);
    documented.set(match[1], command);
  }
  assert.deepEqual([...documented.keys()].sort(), Object.keys(scripts).sort(),
    "文档表格必须逐项列出 package.json 的全部 npm scripts");


  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme.trimEnd(), /\[[^\]]+\]\(docs\/usage\.md\)\s*$/, "README 末尾必须有指向 docs/usage.md 的链接");
}

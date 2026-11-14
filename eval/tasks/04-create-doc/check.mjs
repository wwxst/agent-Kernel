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
  const rows = [...usage.matchAll(/^\|\s*`([^\`]+)`\s*\|\s*([^|]+)\|\s*$/gm)];
  const documented = new Map(rows.map(([, command, description]) => [command.trim(), description.trim()]));
  for (const [name, command] of Object.entries(scripts)) {
    assert.ok(documented.has(name), `文档表格缺少 npm script: ${name}`);
    assert.ok(documented.get(name).length > 0, `npm script ${name} 缺少说明`);
    assert.ok(documented.get(name).includes(command), `npm script ${name} 的命令与 package.json 不一致`);
  }
  assert.equal(documented.size, Object.keys(scripts).length, "文档表格包含不存在或重复的 npm script");

  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme.trimEnd(), /\[[^\]]+\]\(docs\/usage\.md\)\s*$/, "README 末尾必须有指向 docs/usage.md 的链接");
}

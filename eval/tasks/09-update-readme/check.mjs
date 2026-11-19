import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function check(root) {
  const readme = (await readFile(path.join(root, "README.md"), "utf8")).replace(/\r\n/g, "\n");
  const originalIntro = "# fixture\n\n一个用来练手的小仓库。";
  assert.ok(readme.startsWith(originalIntro), "README 原有标题和介绍必须保留，不能只留下命令表格");

  const sectionMatch = /^## 命令\s*$/m.exec(readme);
  assert.ok(sectionMatch, "缺少「命令」一节");
  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextSection = readme.slice(sectionStart).search(/^##\s+/m);
  const section = readme.slice(sectionStart, nextSection < 0 ? undefined : sectionStart + nextSection);
  assert.match(section, /^\|\s*[^|]+\|\s*[^|]+\|\s*$/m, "「命令」一节必须包含 Markdown 表格");

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const rows = [...section.matchAll(/^\|\s*([^|]+)\|\s*([^|]+)\|\s*$/gm)];
  const documented = new Map();

  for (const [, rawCommand, rawDescription] of rows) {
    const command = rawCommand.trim().replace(/^\x60|\x60$/g, "");
    const match = /^(?:npm (?:run )?)?([a-zA-Z0-9:_-]+)$/.exec(command);
    if (!match || !Object.hasOwn(scripts, match[1])) continue;
    assert.ok(!documented.has(match[1]), `npm script 重复列出: ${match[1]}`);
    assert.ok(rawDescription.trim().length > 0, `npm script ${match[1]} 缺少用途说明`);
    documented.set(match[1], command);
  }

  assert.deepEqual([...documented.keys()].sort(), Object.keys(scripts).sort(),
    "「命令」表格必须逐项列出 package.json 的全部 npm scripts，不能漏项或重复");
}

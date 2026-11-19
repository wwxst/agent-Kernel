import assert from "node:assert/strict";
import path from "node:path";
import { readTaskFile, readTaskJson } from "../../checker-helpers.mjs";

export default async function check(root) {
  const readme = (await readTaskFile(path.join(root, "README.md"), "README.md")).replace(/\r\n/g, "\n");
  const originalIntro = "# fixture\n\n一个用来练手的小仓库。";
  assert.ok(readme.startsWith(originalIntro), "README 原有标题和介绍必须保留，不能只留下命令表格");

  const sectionMatch = /^## 命令\s*$/m.exec(readme);
  assert.ok(sectionMatch, "缺少「命令」一节");
  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextSection = readme.slice(sectionStart).search(/^##\s+/m);
  const section = readme.slice(sectionStart, nextSection < 0 ? undefined : sectionStart + nextSection);
  assert.match(section, /^\|\s*命令\s*\|\s*[^|]+\s*\|/m, "「命令」一节必须有命令列和说明列");
  assert.match(section, /^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*$/m, "「命令」一节必须有 Markdown 表格分隔线");

  const pkg = await readTaskJson(path.join(root, "package.json"), "package.json");
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

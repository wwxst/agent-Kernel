import assert from "node:assert/strict";
import path from "node:path";
import { readTaskFile, readTaskJson } from "../../checker-helpers.mjs";

/** 读取简单 Markdown 表格行；不对列数做固定假设。 */
function cells(line) {
  const text = line.trim();
  if (!text.startsWith("|") || !text.endsWith("|")) return undefined;
  return text.slice(1, -1).split("|").map((value) => value.trim());
}

export default async function check(root) {
  const usage = await readTaskFile(path.join(root, "docs", "usage.md"), "docs/usage.md");
  assert.equal(usage.split(/\r?\n/, 1)[0], "# 用法", "docs/usage.md 的第一行必须是 # 用法");

  const pkg = await readTaskJson(path.join(root, "package.json"), "package.json");
  const scripts = pkg.scripts ?? {};
  const lines = usage.replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex((line) => cells(line)?.includes("命令"));
  assert.notEqual(headerIndex, -1, "正文表格必须有命令列和说明列");
  const header = cells(lines[headerIndex]) ?? [];
  const commandIndex = header.indexOf("命令");
  const scriptIndex = header.findIndex((name) => /(?:script|脚本)/i.test(name));
  const descriptionIndex = header.findIndex(
    (name, index) => index !== commandIndex && index !== scriptIndex &&
      /(?:说明|描述|用途|description|purpose)/i.test(name),
  );
  const fallbackDescriptionIndex = header.findIndex(
    (_name, index) => index !== commandIndex && index !== scriptIndex,
  );
  const descIndex = descriptionIndex >= 0 ? descriptionIndex : fallbackDescriptionIndex;
  assert.ok(commandIndex >= 0 && descIndex >= 0, "正文表格必须有命令列和说明列");
  const delimiter = cells(lines[headerIndex + 1] ?? "");
  assert.ok(delimiter && delimiter.length === header.length &&
    delimiter.every((cell) => /^:?-{3,}:?$/.test(cell)), "正文必须有 Markdown 表格分隔线");

  const documented = new Map();
  for (const line of lines.slice(headerIndex + 2)) {
    const row = cells(line);
    if (!row) break;
    assert.equal(row.length, header.length, "Markdown 表格数据行列数必须与表头一致");
    const command = row[commandIndex].replace(/^\x60|\x60$/g, "");
    const match = /^npm (?:run )?([a-zA-Z0-9:_-]+)$/.exec(command);
    assert.ok(match, "命令列必须写完整 npm 命令，例如 npm test 或 npm run lint");
    const name = match[1];
    assert.ok(Object.hasOwn(scripts, name), `文档列出了不存在的 npm script: ${name}`);
    assert.ok(!documented.has(name), `npm script 重复列出: ${name}`);
    assert.ok(row[descIndex].length > 0, `npm script ${name} 缺少说明`);
    if (scriptIndex >= 0) {
      assert.equal(row[scriptIndex].replace(/^\x60|\x60$/g, ""), name,
        `npm script 列与命令列不一致: ${name}`);
    }
    documented.set(name, command);
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

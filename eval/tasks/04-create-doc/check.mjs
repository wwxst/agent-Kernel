import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function check(root) {
  let usage;
  try {
    usage = await readFile(path.join(root, "docs", "usage.md"), "utf8");
  } catch {
    // 任务要求新建这个文件：文件不存在是「还没做」，用断言表达。
    // 直接让 ENOENT 漏出去，会让 selfcheck 把它当成检查器的基础设施错误。
    assert.fail("docs/usage.md 不存在");
  }
  assert.match(usage, /^# 用法/, "docs/usage.md 的第一行必须是 # 用法");

  // `npm test` / `npm run test` / 表格里单独的 `test` 都算列出来了。
  for (const script of ["test", "lint"]) {
    assert.match(usage, new RegExp("npm (run )?" + script + "|`" + script + "`"), `文档里缺少 ${script} 脚本`);
  }

  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /docs\/usage\.md/, "README 末尾没有指向用法文档的链接");
}

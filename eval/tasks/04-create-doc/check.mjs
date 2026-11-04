import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function check(root) {
  const usage = await readFile(path.join(root, "docs", "usage.md"), "utf8");
  assert.match(usage, /^# 用法/, "docs/usage.md 的第一行必须是 # 用法");

  // `npm test` / `npm run test` / 表格里单独的 `test` 都算列出来了。
  for (const script of ["test", "lint"]) {
    assert.match(usage, new RegExp("npm (run )?" + script + "|`" + script + "`"), `文档里缺少 ${script} 脚本`);
  }

  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /docs\/usage\.md/, "README 末尾没有指向用法文档的链接");
}

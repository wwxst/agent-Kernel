import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function check(root) {
  const usage = await readFile(path.join(root, "docs", "usage.md"), "utf8");
  assert.match(usage, /^# 用法/, "docs/usage.md 的第一行必须是 # 用法");
  assert.match(usage, /npm run test/, "表格里缺少 test 脚本");
  assert.match(usage, /npm run lint/, "表格里缺少 lint 脚本");

  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /docs\/usage\.md/, "README 末尾没有指向用法文档的链接");
}

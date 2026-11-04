import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function check(root) {
  const readme = await readFile(path.join(root, "README.md"), "utf8");

  assert.match(readme, /## 命令/, "缺少「命令」一节");
  assert.match(readme, /\|\s*-+\s*\|/, "命令一节不是表格");

  // 单元格里写 `test`、`npm test` 还是 `npm run test` 都算对——
  // 检查的是「每个 script 都被列出来了」，不是「按我的写法列」。
  for (const script of ["test", "lint", "build"]) {
    assert.match(
      readme,
      new RegExp("\\|\\s*`?(npm (run )?" + script + "|" + script + ")`?\\s*\\|"),
      `表格里缺少 ${script}`,
    );
  }

  assert.match(readme, /fixture/, "原有内容被删了");
}

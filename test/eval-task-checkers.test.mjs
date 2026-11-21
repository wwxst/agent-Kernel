/**
 * 文件目的：验证评测检查器既接受符合题意的正确答案，也能拒绝看似通过但实际漏做要求的答案。
 *
 * 文件职责：覆盖检查器本身的误判边界，不运行真实模型、不联系网络。
 *
 * 内容目录：
 *   - Task 02 / 04 / 05 / 08 / 09：保护测试、文档、常量和共享校验的真实要求。
 *   - Task 03 / 10：确认递归目录里的旧引用和死代码也会被发现。
 *   - Task 17：允许额外测试，同时用变异实现验证测试确实能抓住回归。
 *   - Task 19：验证 guard clause 结构和权限判断行为。
 *
 * 模块关系：依赖 eval/tasks/<task>/check.mjs、TypeScript AST 与 Node 内置模块；由 npm test 启动。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import checkFixFailingTest from "../eval/tasks/02-fix-failing-test/check.mjs";
import checkRenameFunction from "../eval/tasks/03-rename-function/check.mjs";
import checkCreateDoc from "../eval/tasks/04-create-doc/check.mjs";
import checkExtractConstant from "../eval/tasks/05-extract-constant/check.mjs";
import checkExtractDuplication from "../eval/tasks/08-extract-duplication/check.mjs";
import checkUpdateReadme from "../eval/tasks/09-update-readme/check.mjs";
import checkDeleteDeadCode from "../eval/tasks/10-delete-dead-code/check.mjs";
import checkWriteMissingTest from "../eval/tasks/17-write-missing-test/check.mjs";
import checkBannedAdminBug from "../eval/tasks/19-banned-admin-bug/check.mjs";
import checkLongContextCompaction from "../eval/tasks/21-long-context-compaction/check.mjs";
import checkMultiToolRefactor from "../eval/tasks/22-multi-tool-refactor/check.mjs";
import { importTaskModule, readTaskFile, readTaskJson } from "../eval/checker-helpers.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function withTempRoot(prefix, run) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withTaskFiles(name, run) {
  return withTempRoot(`agent-${name}-checker-`, async (root) => {
    await cp(path.join(projectRoot, "eval", "tasks", name, "files"), root, { recursive: true });
    return run(root);
  });
}

test("评测题 21：逐条保留 16 份记录、按日期排序且不能修改原始资料", async () => {
  await withTaskFiles("21-long-context-compaction", async (root) => {
    const notesDir = path.join(root, "notes");
    const names = (await readdir(notesDir)).filter((name) => name.endsWith(".md")).sort();
    const records = [];
    for (const name of names) {
      const content = await readFile(path.join(notesDir, name), "utf8");
      records.push({
        id: /^id: (.+)$/m.exec(content)?.[1],
        date: /^date: (.+)$/m.exec(content)?.[1],
        decision: /^decision: (.+)$/m.exec(content)?.[1],
      });
    }
    records.sort((a, b) => a.date.localeCompare(b.date));
    const rows = records.map((item) => "| " + item.id + " | " + item.date + " | " + item.decision + " |");
    const output = [
      "# Migration summary", "",
      "| id | date | decision |",
      "| --- | --- | --- |",
      ...rows, "",
      "Final release gate: GO_WITH_CANARY", "",
    ].join("\n");
    await writeFile(path.join(root, "migration-summary.md"), output, "utf8");
    const compactedContext = { compactionStats: { compactions: 1, summaryRequests: 1 } };
    await assert.doesNotReject(() => checkLongContextCompaction(root, compactedContext));
    await assert.rejects(
      () => checkLongContextCompaction(root, { compactionStats: { compactions: 0, summaryRequests: 0 } }),
      /must trigger at least one committed context compaction/,
    );

    await writeFile(path.join(root, "migration-summary.md"), [
      "# Migration summary", "",
      "| id | date | decision |",
      "| --- | --- | --- |",
      ...[...rows].reverse(), "",
      "Final release gate: GO_WITH_CANARY", "",
    ].join("\n"), "utf8");
    await assert.rejects(() => checkLongContextCompaction(root, compactedContext), /exact and sorted by date/);

    await writeFile(path.join(root, "migration-summary.md"), output, "utf8");
    await writeFile(path.join(notesDir, names[0]), "changed source note");
    await assert.rejects(() => checkLongContextCompaction(root, compactedContext), /source note must not be modified/);
  });
});

test("评测题 22：多文件格式化修复必须保留旧测试并新增边界测试", async () => {
  await withTaskFiles("22-multi-tool-refactor", async (root) => {
    await writeFile(path.join(root, "src", "format.mjs"), [
      "export function formatUser({ name, email } = {}) {",
      '  if (typeof name !== "string" || typeof email !== "string" || !name.trim() || !email.trim()) {',
      '    throw new Error("name and email are required");',
      "  }",
      "  const cleanName = name.trim();",
      "  const cleanEmail = email.trim();",
      '  if (!cleanEmail.includes("@")) throw new Error("email must contain @");',
      "  return cleanName + ` <${cleanEmail}>`;",
      "}",
      "",
    ].join("\n"), "utf8");
    const originalTests = await readFile(
      path.join(projectRoot, "eval", "tasks", "22-multi-tool-refactor", "files", "test", "format.test.mjs"),
      "utf8",
    );
    await writeFile(path.join(root, "test", "format.test.mjs"), originalTests + [
      'test("trims surrounding whitespace", () => assert.equal(formatUser({ name: " Ada ", email: " ada@example.com " }), "Ada <ada@example.com>"));',
      'test("rejects missing fields", () => assert.throws(() => formatUser({ name: "Ada", email: " " }), /name and email are required/));',
      'test("rejects an invalid email", () => assert.throws(() => formatUser({ name: "Ada", email: "invalid" }), /email must contain @/));',
      "",
    ].join("\n"), "utf8");
    const validToolUse = {
      successfulToolCallNames: ["read", "edit", "shell"],
      successfulShellCommands: ["node --test test/format.test.mjs"],
    };
    await assert.doesNotReject(() => checkMultiToolRefactor(root, validToolUse));
    await assert.rejects(
      () => checkMultiToolRefactor(root, { successfulToolCallNames: ["read", "write"] }),
      /must successfully run the requested test command with the shell tool/,
    );
    await assert.rejects(
      () => checkMultiToolRefactor(root, {
        ...validToolUse,
        successfulShellCommands: ["echo tests"],
      }),
      /must successfully execute node --test test\/format\.test\.mjs/,
    );
    await assert.rejects(
      () => checkMultiToolRefactor(root, {
        toolCallNames: ["read", "edit", "shell"],
        shellCommands: ["node --test test/format.test.mjs"],
      }),
      /must successfully inspect source files/,
    );
    await assert.rejects(
      () => checkMultiToolRefactor(root, {
        ...validToolUse,
        successfulShellCommands: ["echo node --test test/format.test.mjs"],
      }),
      /must successfully execute node --test test\/format\.test\.mjs/,
    );
  });
});

test("评测辅助函数：缺失文件、坏 JSON 和模块加载错误都归为任务断言失败", async () => {
  await withTempRoot("agent-checker-helper-", async (root) => {
    await assert.rejects(
      () => readTaskFile(path.join(root, "missing.txt")),
      (error) => error?.name === "AssertionError" && error?.code === "ERR_ASSERTION",
    );

    const invalidJson = path.join(root, "bad.json");
    await writeFile(invalidJson, "{bad json", "utf8");
    await assert.rejects(() => readTaskJson(invalidJson), /不是有效 JSON/);

    await assert.rejects(
      () => importTaskModule(pathToFileURL(path.join(root, "missing.mjs")).href, "missing.mjs"),
      /无法加载/,
    );
  });
});

test("评测题 02：正确修复通过，但改动原始测试文件会被拒绝", async () => {
  await withTaskFiles("02-fix-failing-test", async (root) => {
    await writeFile(path.join(root, "sum.mjs"), [
      "export function sum(values) {",
      "  return values.reduce((total, value) => total + value, 0);",
      "}",
      "",
    ].join("\n"));

    await assert.doesNotReject(() => checkFixFailingTest(root));
    const originalTests = await readFile(path.join(root, "sum.test.mjs"), "utf8");
    await writeFile(path.join(root, "sum.test.mjs"), originalTests + "\n// test changed\n");
    await assert.rejects(() => checkFixFailingTest(root), /不要修改测试文件/);
  });
});

test("评测题 03：根目录改名正确，但子目录残留旧名字仍然失败", async () => {
  await withTaskFiles("03-rename-function", async (root) => {
    await writeFile(path.join(root, "api.mjs"), 'export function getUser(id) { return { id, name: `user ${id}` }; }\n');
    await writeFile(path.join(root, "page.mjs"), [
      'import { getUser } from "./api.mjs";',
      "export function render(id) { return `<span>${getUser(id).name}</span>`; }",
      "",
    ].join("\n"));
    await writeFile(path.join(root, "README.md"), '# demo\n\nimport { getUser } from "./api.mjs";\n');
    await assert.doesNotReject(() => checkRenameFunction(root));

    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "old-api.md"), "旧示例还写着 fetchUser\n");
    await assert.rejects(() => checkRenameFunction(root), /fetchUser/);
  });
});

test("评测题 04：文档表格完整且保留 README 原内容才通过", async () => {
  await withTaskFiles("04-create-doc", async (root) => {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "usage.md"), [
      "# 用法",
      "",
      "| 命令 | 描述 |",
      "| --- | --- |",
      "| `npm test` | 运行测试 |",
      "| `npm run lint` | 检查代码 |",
      "",
    ].join("\n"));
    await writeFile(path.join(root, "README.md"), "# fixture\n\n一个用来练手的小仓库。\n\n[用法](docs/usage.md)\n");
    await assert.doesNotReject(() => checkCreateDoc(root));

    const noUsageDelimiter = (await readFile(path.join(root, "docs", "usage.md"), "utf8"))
      .replace("| --- | --- |", "");
    await writeFile(path.join(root, "docs", "usage.md"), noUsageDelimiter);
    await assert.rejects(() => checkCreateDoc(root), /Markdown 表格分隔线/);
    await writeFile(path.join(root, "docs", "usage.md"), [
      "# 用法",
      "",
      "| 命令 | 描述 |",
      "| --- | --- |",
      "| `npm test` | 运行测试 |",
      "| `npm run lint` | 检查代码 |",
      "",
    ].join("\n"));

    await writeFile(path.join(root, "README.md"), "[用法](docs/usage.md)\n");
    await assert.rejects(() => checkCreateDoc(root), /README 原有标题和介绍/);
  });
});

test("评测题 05：TAX_RATE 必须是真正使用的 const，不能只放一个摆设", async () => {
  await withTaskFiles("05-extract-constant", async (root) => {
    const good = [
      "const TAX_RATE = 0.2;",
      "export function withTax(price) { return Math.round(price * (1 + TAX_RATE) * 100) / 100; }",
      "export function taxOf(price) { return Math.round(price * TAX_RATE * 100) / 100; }",
      "export function discounted(price) { return Math.round(price * 0.9 * (1 + TAX_RATE) * 100) / 100; }",
      "",
    ].join("\n");
    await writeFile(path.join(root, "calc.mjs"), good);
    await assert.doesNotReject(() => checkExtractConstant(root));

    // 0.20 与 0.2 数值相同，不应因为小数写法不同而误判。
    await writeFile(path.join(root, "calc.mjs"), good.replace("TAX_RATE = 0.2", "TAX_RATE = 0.20"));
    await assert.doesNotReject(() => checkExtractConstant(root));

    const unused = [
      "const TAX_RATE = 0.2;",
      "export function withTax(price) { return Math.round(price * 1.2 * 100) / 100; }",
      "export function taxOf(price) { return Math.round(price / 5 * 100) / 100; }",
      "export function discounted(price) { return Math.round(price * 0.9 * 1.2 * 100) / 100; }",
      "",
    ].join("\n");
    await writeFile(path.join(root, "calc.mjs"), unused);
    await assert.rejects(() => checkExtractConstant(root), /真正使用 TAX_RATE/);
  });
});

test("评测题 08：两个导出校验必须委托给同一个共享函数", async () => {
  await withTaskFiles("08-extract-duplication", async (root) => {
    await writeFile(path.join(root, "validate.mjs"), [
      "function validateText(value, label) {",
      '  if (typeof value !== "string") return `${label} must be a string`;',
      '  if (value.trim() === "") return `${label} must not be empty`;',
      '  if (value.length > 40) return `${label} must be at most 40 chars`;',
      "  return null;",
      "}",
      'export function validateName(name) { return validateText(name, "name"); }',
      'export function validateTitle(title) { return validateText(title, "title"); }',
      "",
    ].join("\n"));
    await assert.doesNotReject(() => checkExtractDuplication(root));

    await writeFile(path.join(root, "validate.mjs"), [
      'function validateText(label, value) {',
      '  if (typeof value !== "string") return `${label} must be a string`;',
      '  if (value.trim() === "") return `${label} must not be empty`;',
      '  if (value.length > 40) return `${label} must be at most 40 chars`;',
      "  return null;",
      "}",
      'export function validateName(name) { return validateText("name", name); }',
      'export function validateTitle(title) { return validateText("title", title); }',
      "",
    ].join("\n"));
    await assert.doesNotReject(() => checkExtractDuplication(root));

    // 合法写法：helper 结果先保存到局部变量，再返回该结果。
    await writeFile(path.join(root, "validate.mjs"), [
      "function validateText(value, label) {",
      '  if (typeof value !== "string") return `${label} must be a string`;',
      '  if (value.trim() === "") return `${label} must not be empty`;',
      '  if (value.length > 40) return `${label} must be at most 40 chars`;',
      "  return null;",
      "}",
      'export function validateName(name) { const result = validateText(name, "name"); return result; }',
      'export function validateTitle(title) { const result = validateText(title, "title"); return result; }',
      "",
    ].join("\n"));
    await assert.doesNotReject(() => checkExtractDuplication(root));

    // 合法写法：先定义本地函数，再通过 export list 保留原来的公开名称。
    await writeFile(path.join(root, "validate.mjs"), [
      "function validateText(label, value) {",
      '  if (typeof value !== "string") return `${label} must be a string`;',
      '  if (value.trim() === "") return `${label} must not be empty`;',
      '  if (value.length > 40) return `${label} must be at most 40 chars`;',
      "  return null;",
      "}",
      'function checkName(name) { return validateText("name", name); }',
      'function checkTitle(title) { return validateText("title", title); }',
      "export { checkName as validateName, checkTitle as validateTitle };",
      "",
    ].join("\n"));
    await assert.doesNotReject(() => checkExtractDuplication(root));

    // 反例：虽然两个导出函数调用了同一个 helper，但 helper 内部仍按 name/title 复制了两套校验。
    await writeFile(path.join(root, "validate.mjs"), [
      "function validateText(value, label) {",
      '  if (label === "name") {',
      '    if (typeof value !== "string") return "name must be a string";',
      '    if (value.trim() === "") return "name must not be empty";',
      '    if (value.length > 40) return "name must be at most 40 chars";',
      "  }",
      '  if (typeof value !== "string") return "title must be a string";',
      '  if (value.trim() === "") return "title must not be empty";',
      '  if (value.length > 40) return "title must be at most 40 chars";',
      "  return null;",
      "}",
      'export function validateName(name) { return validateText(name, "name"); }',
      'export function validateTitle(title) { return validateText(title, "title"); }',
      "",
    ].join("\n"));
    await assert.rejects(() => checkExtractDuplication(root), /三种规则都必须只实现一次/);

    await writeFile(path.join(root, "validate.mjs"), [
      "function validateText() { return null; }",
      'export function validateName(name) { if (typeof name !== "string") return "name must be a string"; if (name.trim() === "") return "name must not be empty"; if (name.length > 40) return "name must be at most 40 chars"; return null; }',
      'export function validateTitle(title) { if (typeof title !== "string") return "title must be a string"; if (title.trim() === "") return "title must not be empty"; if (title.length > 40) return "title must be at most 40 chars"; return null; }',
      "",
    ].join("\n"));
    await assert.rejects(() => checkExtractDuplication(root), /直接把校验交给共享函数/);
  });
});

test("评测题 09：命令表必须在命令章节内，并保留 README 原有介绍", async () => {
  await withTaskFiles("09-update-readme", async (root) => {
    const good = [
      "# fixture",
      "",
      "一个用来练手的小仓库。",
      "",
      "## 命令",
      "",
      "| 命令 | 用途 |",
      "| --- | --- |",
      "| `npm test` | 运行测试 |",
      "| `npm run lint` | 检查代码 |",
      "| `npm run build` | 构建项目 |",
      "",
    ].join("\n");
    await writeFile(path.join(root, "README.md"), good);
    await assert.doesNotReject(() => checkUpdateReadme(root));

    // 反例：不能通过删掉 package.json 里的脚本，再同步删掉 README 表格行来缩小任务。
    const packagePath = path.join(root, "package.json");
    const originalPackage = await readFile(packagePath, "utf8");
    const reducedPackage = JSON.parse(originalPackage);
    delete reducedPackage.scripts.lint;
    delete reducedPackage.scripts.build;
    await writeFile(packagePath, JSON.stringify(reducedPackage, null, 2));
    await writeFile(path.join(root, "README.md"), good
      .replace("| `npm run lint` | 检查代码 |\n", "")
      .replace("| `npm run build` | 构建项目 |\n", ""));
    await assert.rejects(() => checkUpdateReadme(root), /原有 npm script 被删除/);
    await writeFile(packagePath, originalPackage);
    await writeFile(path.join(root, "README.md"), good);

    await writeFile(path.join(root, "README.md"), good.replace("一个用来练手的小仓库。", "fixture"));
    await assert.rejects(() => checkUpdateReadme(root), /README 原有标题和介绍/);

    await writeFile(path.join(root, "README.md"), [
      "# fixture",
      "",
      "一个用来练手的小仓库。",
      "",
      "## 命令",
      "",
      "这里没有表格。",
      "",
      "## 其他",
      "",
      "| 命令 | 用途 |",
      "| --- | --- |",
      "| `npm test` | 运行测试 |",
      "| `npm run lint` | 检查代码 |",
      "| `npm run build` | 构建项目 |",
      "",
    ].join("\n"));
    await assert.rejects(() => checkUpdateReadme(root), /命令列和说明列/);

    const noDelimiter = good.replace("| --- | --- |", "");
    await writeFile(path.join(root, "README.md"), noDelimiter);
    await assert.rejects(() => checkUpdateReadme(root), /Markdown 表格分隔线/);
  });
});

test("评测题 10：子目录里残留 dead code 文件或引用也必须失败", async () => {
  await withTaskFiles("10-delete-dead-code", async (root) => {
    await rm(path.join(root, "legacy.mjs"));
    await assert.doesNotReject(() => checkDeleteDeadCode(root));

    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "migration.md"), "legacy 已经删除，但引用还在。\n");
    await assert.rejects(() => checkDeleteDeadCode(root), /legacy/);
  });
});

test("评测题 17：满足三种要求的同时允许额外测试用例", async () => {
  await withTempRoot("agent-task-17-check-", async (root) => {
    await writeFile(path.join(root, "slug.mjs"), [
      "export function slugify(text) {",
      "  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
      "}",
      "",
    ].join("\n"));
    await writeFile(path.join(root, "slug.test.mjs"), [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { slugify } from './slug.mjs';",
      "test('普通句子', () => assert.equal(slugify('Hello World'), 'hello-world'));",
      "test('首尾空格', () => assert.equal(slugify('  Hello World  '), 'hello-world'));",
      "test('空字符串', () => assert.equal(slugify(''), ''));",
      "test('连续标点', () => assert.equal(slugify('Hello,  World!'), 'hello-world'));",
      "",
    ].join("\n"));

    const checkerUrl = new URL("../eval/tasks/17-write-missing-test/check.mjs", import.meta.url).href;
    const script = `import check from ${JSON.stringify(checkerUrl)}; await check(${JSON.stringify(root)});`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("评测题 19：行为正确之外，还必须把嵌套 if 改成 guard clause", async () => {
  await withTaskFiles("19-banned-admin-bug", async (root) => {
    await writeFile(path.join(root, "access.mjs"), [
      "export function canEdit(user, doc) {",
      "  if (!user || !doc || user.banned === true) return false;",
      '  if (user.role === "admin") return true;',
      "  if (doc.ownerId === user.id) return true;",
      "  return false;",
      "}",
      "",
    ].join("\n"));
    await assert.doesNotReject(() => checkBannedAdminBug(root));

    // 合法写法：公开 API 是 const + arrow function，而不是 function declaration。
    await writeFile(path.join(root, "access.mjs"), [
      "export const canEdit = (user, doc) => {",
      "  if (!user || !doc || user.banned === true) return false;",
      '  if (user.role === "admin") return true;',
      "  return doc.ownerId === user.id;",
      "};",
      "",
    ].join("\n"));
    await assert.doesNotReject(() => checkBannedAdminBug(root));

    // 也允许先定义实现，再通过 export list 保留 canEdit 这个公开名字。
    await writeFile(path.join(root, "access.mjs"), [
      "const canEditImpl = (user, doc) => {",
      "  if (!user || !doc || user.banned === true) return false;",
      '  if (user.role === "admin") return true;',
      "  return doc.ownerId === user.id;",
      "};",
      "export { canEditImpl as canEdit };",
      "",
    ].join("\n"));
    await assert.doesNotReject(() => checkBannedAdminBug(root));

    // 只把嵌套 if 摊平、但没有提前 return，不算完成 guard clause 重构。
    await writeFile(path.join(root, "access.mjs"), [
      "export function canEdit(user, doc) {",
      "  if (user && user.banned === true) user = null;",
      "  if (!user || !doc) return false;",
      '  if (user.role === "admin") return true;',
      "  return doc.ownerId === user.id;",
      "}",
      "",
    ].join("\n"));
    await assert.rejects(() => checkBannedAdminBug(root), /每个 if 都必须提前 return/);

    await writeFile(path.join(root, "access.mjs"), [
      "export function canEdit(user, doc) {",
      "  if (user) {",
      "    if (doc) {",
      '      if (user.role === "admin") return user.banned !== true;',
      "      return user.banned !== true && doc.ownerId === user.id;",
      "    }",
      "  }",
      "  return false;",
      "}",
      "",
    ].join("\n"));
    await assert.rejects(() => checkBannedAdminBug(root), /嵌套 if/);
  });
});

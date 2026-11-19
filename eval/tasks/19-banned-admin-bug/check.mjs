import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export default async function check(root) {
  const source = await readFile(path.join(root, "access.mjs"), "utf8");
  const parsed = ts.createSourceFile("access.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = parsed.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "canEdit",
  );
  assert.ok(declaration?.body, "canEdit 必须继续作为函数实现");

  let ifCount = 0;
  let nestedIf = false;
  let hasElse = false;
  function visit(node, ifDepth = 0) {
    if (ts.isIfStatement(node)) {
      ifCount++;
      if (ifDepth > 0) nestedIf = true;
      if (node.elseStatement) hasElse = true;
      ts.forEachChild(node, (child) => visit(child, ifDepth + 1));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, ifDepth));
  }
  visit(declaration.body);

  assert.ok(ifCount > 0, "canEdit 应使用明确的 guard clause");
  assert.equal(nestedIf, false, "canEdit 不能再有嵌套 if");
  assert.equal(hasElse, false, "guard clause 应提前返回，不应保留 else 分支");

  const { canEdit } = await import(pathToFileURL(path.join(root, "access.mjs")).href);

  const doc = { id: 1, ownerId: 1 };
  const owner = { id: 1, role: "member" };
  const admin = { id: 2, role: "admin" };
  const bannedAdmin = { id: 2, role: "admin", banned: true };
  const stranger = { id: 3, role: "member" };

  assert.equal(canEdit(owner, doc), true, "作者能编辑");
  assert.equal(canEdit(admin, doc), true, "管理员能编辑");
  assert.equal(canEdit(stranger, doc), false, "无关用户不能编辑");
  assert.equal(canEdit(bannedAdmin, doc), false, "被 ban 的管理员不能编辑");
  assert.equal(canEdit(owner, null), false, "没有文档时不能编辑");
  assert.equal(canEdit(null, doc), false, "没有用户时不能编辑");
}

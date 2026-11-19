import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { importTaskModule, readTaskFile } from "../../checker-helpers.mjs";

function isCallable(node) {
  return ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node);
}

function findLocalCallable(sourceFile, localName) {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === localName) {
      return statement;
    }
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === localName,
      );
      if (declaration?.initializer && isCallable(declaration.initializer)) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function findExportedCallable(sourceFile, exportedName) {
  // 形式一：export function canEdit() {} / export const canEdit = () => {}
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === exportedName &&
        hasExportModifier(statement)) {
      return statement;
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === exportedName,
      );
      if (declaration?.initializer && isCallable(declaration.initializer)) {
        return declaration.initializer;
      }
    }
  }

  // 形式二：先定义本地函数，再通过 export list 导出 canEdit。
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause) || statement.moduleSpecifier) {
      continue;
    }
    const specifier = statement.exportClause.elements.find((item) => item.name.text === exportedName);
    if (specifier) {
      const localName = specifier.propertyName?.text ?? specifier.name.text;
      return findLocalCallable(sourceFile, localName);
    }
  }
  return undefined;
}

export default async function check(root) {
  const source = await readTaskFile(path.join(root, "access.mjs"), "access.mjs");
  const parsed = ts.createSourceFile("access.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0, "access.mjs 必须是有效的 JavaScript");

  const callable = findExportedCallable(parsed, "canEdit");
  const body = callable?.body;
  assert.ok(body && ts.isBlock(body), "canEdit 必须继续作为带函数体的函数实现");

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
  visit(body);

  assert.ok(ifCount > 0, "canEdit 应使用明确的 guard clause");
  assert.equal(nestedIf, false, "canEdit 不能再有嵌套 if");
  assert.equal(hasElse, false, "guard clause 应提前返回，不应保留 else 分支");

  const { canEdit } = await importTaskModule(pathToFileURL(path.join(root, "access.mjs")).href, "access.mjs");

  const doc = { id: 1, ownerId: 1 };
  const owner = { id: 1, role: "member" };
  const admin = { id: 2, role: "admin" };
  const bannedAdmin = { id: 2, role: "admin", banned: true };
  const bannedOwner = { id: 1, role: "member", banned: true };
  const stranger = { id: 3, role: "member" };

  assert.equal(canEdit(owner, doc), true, "作者能编辑");
  assert.equal(canEdit(admin, doc), true, "管理员能编辑");
  assert.equal(canEdit(stranger, doc), false, "无关用户不能编辑");
  assert.equal(canEdit(bannedAdmin, doc), false, "被 ban 的管理员不能编辑");
  assert.equal(canEdit(bannedOwner, doc), false, "被 ban 的普通用户也不能编辑");
  assert.equal(canEdit(owner, null), false, "没有文档时不能编辑");
  assert.equal(canEdit(null, doc), false, "没有用户时不能编辑");
}

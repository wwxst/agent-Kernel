import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { importTaskModule, readTaskFile } from "../../checker-helpers.mjs";

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function findExportedCallable(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && hasExportModifier(statement)) {
      return statement;
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === name,
      );
      if (declaration?.initializer &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function returnedHelperCall(callable) {
  if (ts.isArrowFunction(callable) && ts.isCallExpression(callable.body)) return callable.body;
  const body = callable.body;
  if (!body || !ts.isBlock(body) || body.statements.length !== 1) return undefined;
  const [statement] = body.statements;
  if (!ts.isReturnStatement(statement) || !statement.expression || !ts.isCallExpression(statement.expression)) {
    return undefined;
  }
  return statement.expression;
}

function hasLocalHelper(sourceFile, name) {
  return sourceFile.statements.some((statement) => {
    if (ts.isFunctionDeclaration(statement)) return statement.name?.text === name;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (item) => ts.isIdentifier(item.name) && item.name.text === name &&
          item.initializer && (ts.isArrowFunction(item.initializer) || ts.isFunctionExpression(item.initializer)),
      );
    }
    return false;
  });
}

export default async function check(root) {
  const source = await readTaskFile(path.join(root, "validate.mjs"), "validate.mjs");
  const parsed = ts.createSourceFile("validate.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0, "validate.mjs 必须是有效的 JavaScript");

  const validateName = findExportedCallable(parsed, "validateName");
  const validateTitle = findExportedCallable(parsed, "validateTitle");
  assert.ok(validateName, "validateName 必须继续导出");
  assert.ok(validateTitle, "validateTitle 必须继续导出");

  const nameCall = returnedHelperCall(validateName);
  const titleCall = returnedHelperCall(validateTitle);
  assert.ok(nameCall && titleCall, "两个导出函数都应该直接把校验交给共享函数");
  assert.ok(ts.isIdentifier(nameCall.expression) && ts.isIdentifier(titleCall.expression),
    "共享校验必须通过同一个本地函数调用");
  const helperName = nameCall.expression.text;
  assert.equal(titleCall.expression.text, helperName, "两个导出函数必须调用同一个共享校验函数");
  assert.notEqual(helperName, "validateName");
  assert.notEqual(helperName, "validateTitle");
  assert.ok(hasLocalHelper(parsed, helperName), "共享校验函数必须在 validate.mjs 中真实定义");
  assert.ok(nameCall.arguments.length >= 2 && ts.isStringLiteral(nameCall.arguments[1]) &&
    nameCall.arguments[1].text === "name", "validateName 必须把 name 标签交给共享函数");
  assert.ok(titleCall.arguments.length >= 2 && ts.isStringLiteral(titleCall.arguments[1]) &&
    titleCall.arguments[1].text === "title", "validateTitle 必须把 title 标签交给共享函数");

  const { validateName: checkName, validateTitle: checkTitle } =
    await importTaskModule(pathToFileURL(path.join(root, "validate.mjs")).href, "validate.mjs");

  assert.equal(checkName("ok"), null);
  assert.match(checkName(""), /name/);
  assert.match(checkName(1), /name/);
  assert.match(checkName("x".repeat(41)), /name/);

  assert.equal(checkTitle("ok"), null);
  assert.match(checkTitle(""), /title/);
  assert.match(checkTitle(null), /title/);
  assert.match(checkTitle("x".repeat(41)), /title/);
}

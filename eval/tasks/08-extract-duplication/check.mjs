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

function findExportedCallable(sourceFile, exportedName) {
  // 形式一：export function validateName() {} / export const validateName = () => {}
  const inline = findLocalCallable(sourceFile, exportedName);
  if (inline) {
    const declaration = sourceFile.statements.find((statement) =>
      (ts.isFunctionDeclaration(statement) && statement.name?.text === exportedName) ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (item) => ts.isIdentifier(item.name) && item.name.text === exportedName,
        )),
    );
    if (declaration?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      return inline;
    }
  }

  // 形式二：function validateName() {} ; export { validateName }
  // 同时支持 export { localName as validateName }，但最终导出的名字必须保持不变。
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause) || statement.moduleSpecifier) {
      continue;
    }
    const specifier = statement.exportClause.elements.find(
      (item) => item.name.text === exportedName,
    );
    if (!specifier) continue;
    const localName = specifier.propertyName?.text ?? specifier.name.text;
    return findLocalCallable(sourceFile, localName);
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

function firstParameterName(callable) {
  const parameter = callable.parameters?.[0];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function hasLocalHelper(sourceFile, name) {
  return Boolean(findLocalCallable(sourceFile, name));
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
  const nameParameter = firstParameterName(validateName);
  const titleParameter = firstParameterName(validateTitle);
  assert.ok(nameParameter && titleParameter, "两个导出函数都必须接收待校验的值");
  assert.ok(nameCall.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === nameParameter),
    "共享函数必须收到 validateName 的原始参数");
  assert.ok(nameCall.arguments.some((argument) => ts.isStringLiteralLike(argument) && argument.text === "name"),
    "validateName 必须把 name 标签交给共享函数");
  assert.ok(titleCall.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === titleParameter),
    "共享函数必须收到 validateTitle 的原始参数");
  assert.ok(titleCall.arguments.some((argument) => ts.isStringLiteralLike(argument) && argument.text === "title"),
    "validateTitle 必须把 title 标签交给共享函数");

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

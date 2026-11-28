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
  if (!body || !ts.isBlock(body)) return undefined;

  if (body.statements.length === 1) {
    const [statement] = body.statements;
    if (ts.isReturnStatement(statement) && statement.expression && ts.isCallExpression(statement.expression)) {
      return statement.expression;
    }
    return undefined;
  }

  // 也接受 const result = sharedValidator(...); return result;
  // 不能只因为实现把 helper 结果存入局部变量，就把正确重构误判为失败。
  if (body.statements.length === 2) {
    const [declaration, returnStatement] = body.statements;
    if (!ts.isVariableStatement(declaration) || !ts.isReturnStatement(returnStatement) ||
        !returnStatement.expression || !ts.isIdentifier(returnStatement.expression) ||
        declaration.declarationList.declarations.length !== 1) {
      return undefined;
    }
    const [item] = declaration.declarationList.declarations;
    if (!ts.isIdentifier(item.name) || !item.initializer || !ts.isCallExpression(item.initializer) ||
        item.name.text !== returnStatement.expression.text) {
      return undefined;
    }
    return item.initializer;
  }

  return undefined;
}

function firstParameterName(callable) {
  const parameter = callable.parameters?.[0];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function hasLocalHelper(sourceFile, name) {
  return Boolean(findLocalCallable(sourceFile, name));
}

/** 取表达式里的根标识符：只穿过属性访问、调用、括号和可选链，其它形式一律不推导。 */
function expressionRoots(node) {
  if (ts.isIdentifier(node)) return new Set([node.text]);
  if (ts.isPropertyAccessExpression(node)) return expressionRoots(node.expression);
  if (ts.isCallExpression(node)) return expressionRoots(node.expression);
  if (ts.isParenthesizedExpression(node)) return expressionRoots(node.expression);
  if (ts.isNonNullExpression(node)) return expressionRoots(node.expression);
  if (ts.isElementAccessExpression(node)) return expressionRoots(node.expression);
  return new Set();
}

/**
 * 有界、简单的数据流：把局部变量归到它派生自的参数，支持多级局部变量
 * （`const trimmed = value.trim(); const clean = trimmed;`）。
 * 只读声明里的简单表达式，最多迭代「声明数 + 1」轮；推不出来就不算派生，
 * 宁可漏认（仍按规则没实现报错），也不把无关变量算成参数。
 */
function derivedParameterBindings(callable, parameterNames) {
  const declarations = [];
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push({ name: node.name.text, initializer: node.initializer });
    }
    ts.forEachChild(node, collect);
  }
  collect(callable.body);

  const bindings = new Map([...parameterNames].map((name) => [name, new Set([name])]));
  for (let pass = 0; pass <= declarations.length; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      const parameters = new Set();
      for (const root of expressionRoots(declaration.initializer)) {
        for (const parameter of bindings.get(root) ?? []) parameters.add(parameter);
      }
      if (parameters.size === 0) continue;
      const existing = bindings.get(declaration.name);
      if (existing === undefined) {
        bindings.set(declaration.name, parameters);
        changed = true;
        continue;
      }
      for (const parameter of parameters) {
        if (!existing.has(parameter)) {
          existing.add(parameter);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return bindings;
}

/** 规则作用在哪个标识符上：直接是标识符，或 `.trim()` 返回值的来源。 */
function ruleReceiverNames(expression) {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "trim" &&
      ts.isIdentifier(expression.expression.expression)) {
    return [expression.expression.expression.text];
  }
  return [];
}

/** `.length` 与 0/1 比较是在判空，不是「最大长度」规则；其余 `.length` 用法都算长度规则。 */
function isEmptinessLengthAccess(node) {
  const comparison = node.parent;
  if (!comparison || !ts.isBinaryExpression(comparison)) return false;
  const other = comparison.left === node ? comparison.right : comparison.left;
  return ts.isNumericLiteral(other) && Number(other.text) <= 1;
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

  // 不能只把原来的两套校验搬进一个 helper 的 name/title 分支；
  // 类型、空字符串、最大长度这三条规则都必须只实现一次。
  const helper = findLocalCallable(parsed, helperName);
  const parameterChecks = new Map(
    (helper?.parameters ?? [])
      .filter((parameter) => ts.isIdentifier(parameter.name))
      .map((parameter) => [parameter.name.text, { type: 0, trim: 0, length: 0 }]),
  );
  assert.ok(helper && parameterChecks.size > 0, "共享校验函数必须接收待校验的值");
  const bindings = derivedParameterBindings(helper, parameterChecks.keys());

  // 一条规则可以写在参数上，也可以写在由参数派生的局部变量上；都记到派生来源参数头上。
  function countRule(identifier, rule) {
    for (const parameter of bindings.get(identifier) ?? []) {
      const counts = parameterChecks.get(parameter);
      if (counts) counts[rule] += 1;
    }
  }

  function countValidationRules(node) {
    if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression)) {
      countRule(node.expression.text, "type");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "trim") {
      for (const receiver of ruleReceiverNames(node.expression.expression)) countRule(receiver, "trim");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "length" &&
        !isEmptinessLengthAccess(node)) {
      for (const receiver of ruleReceiverNames(node.expression)) countRule(receiver, "length");
    }
    ts.forEachChild(node, countValidationRules);
  }
  countValidationRules(helper.body);
  const validatedParameters = [...parameterChecks.values()].filter(
    (counts) => counts.type === 1 && counts.trim === 1 && counts.length === 1,
  );
  assert.equal(validatedParameters.length, 1,
    "共享校验中的类型、空字符串、最大长度三种规则都必须只实现一次");

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

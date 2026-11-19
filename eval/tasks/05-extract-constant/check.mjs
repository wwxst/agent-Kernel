import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { importTaskModule, readTaskFile } from "../../checker-helpers.mjs";

export default async function check(root) {
  const source = await readTaskFile(path.join(root, "calc.mjs"), "calc.mjs");
  const parsed = ts.createSourceFile("calc.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let declarationFound = false;
  let referenceCount = 0;

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "TAX_RATE") {
      const isConst = ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0;
      const isExpectedValue = node.initializer && ts.isNumericLiteral(node.initializer) &&
        Number(node.initializer.text) === 0.2;
      declarationFound ||= isConst && isExpectedValue;
    } else if (ts.isIdentifier(node) && node.text === "TAX_RATE" &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
      referenceCount++;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);

  assert.equal(declarationFound, true, "必须声明 const TAX_RATE = 0.2");
  assert.ok(referenceCount > 0, "计算逻辑必须真正使用 TAX_RATE，不能只声明一个没用的常量");
  assert.equal((source.match(/\b0\.2\b/g) ?? []).length, 1, "0.2 还散落在多处");

  const { withTax, taxOf, discounted } = await importTaskModule(pathToFileURL(path.join(root, "calc.mjs")).href, "calc.mjs");
  assert.equal(withTax(100), 120, "含税价变了");
  assert.equal(taxOf(100), 20, "税额变了");
  assert.equal(discounted(100), 108, "折后含税价变了");
}

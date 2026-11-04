import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const source = await readFile(path.join(root, "calc.mjs"), "utf8");
  assert.match(source, /TAX_RATE/, "没有提取出 TAX_RATE 常量");
  assert.equal((source.match(/0\.2/g) ?? []).length, 1, "0.2 还散落在多处");

  const { withTax, taxOf, discounted } = await import(pathToFileURL(path.join(root, "calc.mjs")).href);
  assert.equal(withTax(100), 120, "含税价变了");
  assert.equal(taxOf(100), 20, "税额变了");
  assert.equal(discounted(100), 108, "折后含税价变了");
}

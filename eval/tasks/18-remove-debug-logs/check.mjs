import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const file = path.join(root, "app.mjs");
  const source = await readFile(file, "utf8");

  assert.equal(source.includes("console.log"), false, "还有没删掉的 console.log");

  const { total } = await import(pathToFileURL(file).href);
  assert.equal(total([{ price: 2 }, { price: 3 }]), 5, "计算逻辑被改坏了");
  assert.equal(total([]), 0, "空数组应该是 0");
}

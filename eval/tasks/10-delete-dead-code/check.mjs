import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const files = await readdir(root);
  assert.equal(files.includes("legacy.mjs"), false, "legacy.mjs 还在");

  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.equal(text.includes("legacy"), false, `${file} 里还引用了 legacy`);
  }

  const { render } = await import(pathToFileURL(path.join(root, "app.mjs")).href);
  assert.equal(render("Ada"), "Hello, Ada", "app 的行为被改坏了");
}

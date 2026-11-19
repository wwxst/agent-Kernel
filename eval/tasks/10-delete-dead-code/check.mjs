import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importTaskModule, readTaskFile } from "../../checker-helpers.mjs";

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export default async function check(root) {
  const files = await listFiles(root);
  assert.equal(files.some((file) => path.basename(file) === "legacy.mjs"), false,
    "legacy.mjs 还在（包括子目录）");

  for (const file of files) {
    const text = await readTaskFile(file, path.relative(root, file));
    assert.equal(text.toLowerCase().includes("legacy"), false,
      `${path.relative(root, file)} 里还引用了 legacy`);
  }

  const { render } = await importTaskModule(pathToFileURL(path.join(root, "app.mjs")).href, "app.mjs");
  assert.equal(render("Ada"), "Hello, Ada", "app 的行为被改坏了");
}

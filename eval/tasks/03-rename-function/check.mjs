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
  // 旧名字必须从整个仓库消失，不能只检查根目录而把旧引用藏进子目录。
  for (const file of await listFiles(root)) {
    const text = await readTaskFile(file, path.relative(root, file));
    assert.equal(text.toLowerCase().includes("fetchuser"), false,
      `${path.relative(root, file)} 里还留着 fetchUser`);
  }

  const { getUser } = await importTaskModule(pathToFileURL(path.join(root, "api.mjs")).href, "api.mjs");
  assert.equal(getUser(1).id, 1, "getUser 的行为变了");

  const page = await importTaskModule(pathToFileURL(path.join(root, "page.mjs")).href, "page.mjs");
  assert.match(page.render(1), /user 1/i, "page 没有正确调用 getUser");
}

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  // 旧名字必须彻底消失（大小写无关，防止残留注释/示例）。
  for (const file of await readdir(root)) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.equal(text.toLowerCase().includes("fetchuser"), false, `${file} 里还留着 fetchUser`);
  }

  const { getUser } = await import(pathToFileURL(path.join(root, "api.mjs")).href);
  assert.equal(getUser(1).id, 1, "getUser 的行为变了");

  const page = await import(pathToFileURL(path.join(root, "page.mjs")).href);
  assert.match(page.render(1), /user 1/i, "page 没有正确调用 getUser");
}

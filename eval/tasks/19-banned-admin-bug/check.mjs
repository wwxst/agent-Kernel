import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { canEdit } = await import(pathToFileURL(path.join(root, "access.mjs")).href);

  const doc = { id: 1, ownerId: 1 };
  const owner = { id: 1, role: "member" };
  const admin = { id: 2, role: "admin" };
  const bannedAdmin = { id: 2, role: "admin", banned: true };
  const stranger = { id: 3, role: "member" };

  assert.equal(canEdit(owner, doc), true, "作者能编辑");
  assert.equal(canEdit(admin, doc), true, "管理员能编辑");
  assert.equal(canEdit(stranger, doc), false, "无关用户不能编辑");
  assert.equal(canEdit(bannedAdmin, doc), false, "被 ban 的管理员不能编辑");
  assert.equal(canEdit(owner, null), false, "没有文档时不能编辑");
  assert.equal(canEdit(null, doc), false, "没有用户时不能编辑");
}

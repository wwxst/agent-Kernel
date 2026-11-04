import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function check(root) {
  const { isEmail } = await import(pathToFileURL(path.join(root, "validate.mjs")).href);

  for (const valid of ["first.last@example.com", "a@b.co", "user+tag@my-site.io"]) {
    assert.equal(isEmail(valid), true, `${valid} 应该被接受`);
  }
  for (const invalid of ["no-at-sign", "a b@c.com", "@example.com", "user@"]) {
    assert.equal(isEmail(invalid), false, `${invalid} 应该被拒绝`);
  }
}

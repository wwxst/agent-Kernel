import assert from "node:assert/strict";
import test from "node:test";
import { formatUser } from "../src/format.mjs";

test("formats a user", () => {
  assert.equal(formatUser({ name: "Ada", email: "ada@example.com" }), "Ada <ada@example.com>");
});

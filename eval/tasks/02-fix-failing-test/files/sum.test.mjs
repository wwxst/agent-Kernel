import assert from "node:assert/strict";
import { test } from "node:test";
import { sum } from "./sum.mjs";

test("空数组是 0", () => {
  assert.equal(sum([]), 0);
});

test("多个数字相加", () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test("单个元素原样返回", () => {
  assert.equal(sum([5]), 5);
});

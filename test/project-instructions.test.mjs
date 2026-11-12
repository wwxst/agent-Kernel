/**
 * 项目指令（AGENTS.md）读取：存在就读、为空或不存在就当没有、超长就截断。
 *
 * 这几条边界比功能本身重要：读不到不能让任务失败，太长不能把对话预算挤掉。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_INSTRUCTIONS_CHARS,
  PROJECT_INSTRUCTIONS_FILE,
  projectInstructionsPrompt,
  readProjectInstructions,
} from "../src/project-instructions.ts";

async function withDir(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-instructions-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("项目指令：没有 AGENTS.md 时返回 undefined，不是错误", async () => {
  await withDir(async (root) => {
    assert.equal(readProjectInstructions(root), undefined);
  });
});

test("项目指令：空白文件等同于没有", async () => {
  await withDir(async (root) => {
    await writeFile(path.join(root, PROJECT_INSTRUCTIONS_FILE), "   \n\n\t\n");
    assert.equal(readProjectInstructions(root), undefined);
  });
});

test("项目指令：读到正文并保留原样", async () => {
  await withDir(async (root) => {
    await writeFile(path.join(root, PROJECT_INSTRUCTIONS_FILE), "# 规范\n\n- 先跑测试\n");
    const instructions = readProjectInstructions(root);
    assert.ok(instructions !== undefined);
    assert.equal(instructions.truncated, false);
    assert.match(instructions.text, /先跑测试/);
    assert.match(projectInstructionsPrompt(instructions), /# Project instructions \(AGENTS\.md\)/);
  });
});

test("项目指令：超长时截断并标注，避免挤掉对话预算", async () => {
  await withDir(async (root) => {
    await writeFile(path.join(root, PROJECT_INSTRUCTIONS_FILE), "a".repeat(MAX_INSTRUCTIONS_CHARS + 100));
    const instructions = readProjectInstructions(root);
    assert.ok(instructions !== undefined);
    assert.equal(instructions.truncated, true);
    assert.ok(instructions.text.length < MAX_INSTRUCTIONS_CHARS + 200, "截断后不应继续膨胀");
    assert.match(instructions.text, /truncated/);
  });
});

test("项目指令：AGENTS.md 是目录时不抛错，当作没有", async () => {
  await withDir(async (root) => {
    await mkdir(path.join(root, PROJECT_INSTRUCTIONS_FILE));
    assert.equal(readProjectInstructions(root), undefined);
  });
});

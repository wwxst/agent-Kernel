/**
 * 文件目的：守住 src/ 模块之间的依赖方向，防止后续重构悄悄破坏架构边界。
 *
 * 文件职责：用临时 TypeScript 项目验证架构检查器能识别允许的依赖、违规依赖、
 * 不同导入语法、无法静态判断的动态路径和未归类模块。不启动真实 Agent、不联网。
 *
 * 内容目录：
 *   - 合法依赖：覆盖各层允许的方向和同层内部依赖。
 *   - 非法依赖：覆盖 core → tools、core → ui、protocol → model。
 *   - 导入语法：覆盖 export from、动态 import、import type 和 require。
 *   - 无法检查的路径：覆盖变量动态导入、无法解析的相对路径和未知模块目录。
 *
 * 模块关系：依赖 scripts/check-architecture.mjs 与 Node 内置模块；由 npm test 启动。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkArchitecture } from "../scripts/check-architecture.mjs";

async function withProject(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-architecture-test-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2023",
        noEmit: true,
        allowImportingTsExtensions: true,
      },
    }));
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("架构检查：允许各模块依赖 protocol、模块内部依赖和 UI 依赖 Core", async () => {
  await withProject({
    "src/protocol/types.ts": "export interface Message { content: string }\n",
    "src/core/helpers.ts": "export const helper = true;\n",
    "src/core/agent.ts": [
      'import type { Message } from "../protocol/types.ts";',
      'import { helper } from "./helpers.ts";',
      "export const agent = (message: Message) => helper && message.content;",
    ].join("\n"),
    "src/tools/workspace.ts": 'import type { Message } from "../protocol/types.ts";\nexport const workspace = (message: Message) => message.content;\n',
    "src/model/llm.ts": 'import type { Message } from "../protocol/types.ts";\nexport const request = (message: Message) => message.content;\n',
    "src/ui/tui.ts": [
      'import { agent } from "../core/agent.ts";',
      'import type { Message } from "../protocol/types.ts";',
      "export const render = (message: Message) => agent(message);",
    ].join("\n"),
    "src/cli.ts": [
      'import "../core/agent.ts";',
      'import "../tools/workspace.ts";',
      'import "../model/llm.ts";',
      'import "../ui/tui.ts";',
      'import "../protocol/types.ts";',
    ].join("\n"),
  }, async (root) => {
    const result = await checkArchitecture(root);
    assert.deepEqual(result.violations, []);
    assert.equal(result.checkedFiles, 7);
    assert.ok(result.checkedImports >= 10);
  });
});

test("架构检查：拒绝跨越模块边界的依赖", async () => {
  await withProject({
    "src/protocol/types.ts": 'import "../model/llm.ts";\nexport const protocol = true;\n',
    "src/core/agent.ts": 'import "../tools/workspace.ts";\nimport "../ui/tui.ts";\n',
    "src/tools/workspace.ts": "export const workspace = true;\n",
    "src/model/llm.ts": "export const model = true;\n",
    "src/ui/tui.ts": "export const ui = true;\n",
  }, async (root) => {
    const result = await checkArchitecture(root);
    const edges = result.violations.map(({ sourceLayer, targetLayer }) => `${sourceLayer} -> ${targetLayer}`);
    assert.deepEqual(edges.sort(), ["core -> tools", "core -> ui", "protocol -> model"]);
  });
});

test("架构检查：同时检查 export from、动态 import、import type 和 require", async () => {
  await withProject({
    "src/protocol/types.ts": "export interface ProtocolType {}\n",
    "src/tools/workspace.ts": "export interface ToolType {}\n",
    "src/core/agent.ts": [
      'export * from "../tools/workspace.ts";',
      'const loaded = import("../tools/workspace.ts");',
      'type Imported = import("../tools/workspace.ts").ToolType;',
      'const required = require("../tools/workspace.ts");',
      "export type { Imported };",
    ].join("\n"),
  }, async (root) => {
    const result = await checkArchitecture(root);
    assert.equal(result.violations.filter((item) => item.sourceLayer === "core" && item.targetLayer === "tools").length, 4);
  });
});

test("架构检查：无法静态判断的动态路径必须失败", async () => {
  await withProject({
    "src/core/agent.ts": [
      'const target = "../tools/workspace.ts";',
      "const loaded = import(target);",
    ].join("\n"),
  }, async (root) => {
    const result = await checkArchitecture(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0].message, /非字符串路径/);
  });
});

test("架构检查：相对路径无法解析时不能静默跳过", async () => {
  await withProject({
    "src/core/agent.ts": 'import "../tools/missing.ts";\n',
  }, async (root) => {
    const result = await checkArchitecture(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0].message, /无法解析/);
  });
});

test("架构检查：新增 src 模块必须先明确它的依赖边界", async () => {
  await withProject({
    "src/new-layer/feature.ts": "export const feature = true;\n",
  }, async (root) => {
    const result = await checkArchitecture(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0].message, /没有归入已定义模块/);
  });
});

/**
 * 文件目的：保护 TodoWrite 的任务状态，不让模型的一次错误清单把已有进度清空。
 *
 * 文件职责：从 TodoManager 和公开工具接口检查状态转换、完整替换、非法输入、展示结果。
 * 不测试工具注册表的通用 Schema 校验和 Agent 循环（分别在对应测试文件里）。
 *
 * 内容目录：
 *   - 正常写入：计划能创建、更新和清空，返回可读的进度清单。
 *   - 错误写入：状态、并发活动任务、重复项、空内容、长度、控制字符和总数限制。
 *   - 说明书：工具名与嵌套 Schema 是模型可消费的形状。
 *   - 会话生命周期：同一管理器跨工具调用接续计划，不同实例互不影响。
 *
 * 模块关系：只依赖 `src/tools/todo.ts` 与 Node 内置测试；由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TodoManager, createTodoTool } from "../src/tools/todo.ts";

const entry = (content, status) => ({ content, status });

test("写入计划和逐步更新：按完整清单替换，并准确计算完成数", async () => {
  const manager = new TodoManager();
  const tool = createTodoTool(manager);
  const start = await tool.run({ todos: [entry("检查现状", "in_progress"), entry("增加测试", "pending")] });
  assert.equal(start, "Todo list (0/2 done):\n1. [~] 检查现状 (in_progress)\n2. [ ] 增加测试 (pending)");
  const updated = await tool.run({ todos: [entry("检查现状", "done"), entry("增加测试", "in_progress")] });
  assert.equal(updated, "Todo list (1/2 done):\n1. [x] 检查现状 (done)\n2. [~] 增加测试 (in_progress)");
  assert.equal(manager.render(), updated);
  assert.equal(await tool.run({ todos: [] }), "Todo list cleared (0 tasks).");
});

test("错误更新原子拒绝：上一份有效计划保持不变", () => {
  const manager = new TodoManager();
  manager.update([entry("已验证", "done")]);
  const expected = manager.render();
  const bad = [
    null,
    {},
    [entry("a", "unknown")],
    [entry("a", "in_progress"), entry("b", "in_progress")],
    [entry("a", "pending"), entry("a", "done")],
    [entry("  ", "pending")],
    [entry("a\nb", "pending")],
    [entry("a".repeat(201), "pending")],
    Array.from({ length: 21 }, (_, i) => entry(`task-${i}`, "pending")),
  ];
  for (const invalid of bad) {
    assert.throws(() => manager.update(invalid), /todos|only one|duplicate/i);
    assert.equal(manager.render(), expected);
  }
});

test("合法更新不持有调用者传入对象的引用", () => {
  const manager = new TodoManager();
  const input = [entry("原任务", "pending")];
  manager.update(input);
  input[0].content = "被外部改写";
  input.push(entry("额外任务", "done"));
  assert.equal(manager.render(), "Todo list (0/1 done):\n1. [ ] 原任务 (pending)");
});

test("同一个 TodoManager 跨工具实例共享计划，可以接续更新", async () => {
  const manager = new TodoManager();
  const firstRunTool = createTodoTool(manager);
  await firstRunTool.run({ todos: [entry("检查代码", "in_progress"), entry("运行测试", "pending")] });
  assert.equal(manager.render(),
    "Todo list (0/2 done):\n1. [~] 检查代码 (in_progress)\n2. [ ] 运行测试 (pending)");

  // 第二轮重新获取工具包装对象，仍然操作同一份会话计划。
  const nextRunTool = createTodoTool(manager);
  await nextRunTool.run({ todos: [entry("检查代码", "done"), entry("运行测试", "in_progress")] });
  assert.equal(manager.render(),
    "Todo list (1/2 done):\n1. [x] 检查代码 (done)\n2. [~] 运行测试 (in_progress)");
});

test("不同 TodoManager 会话彼此隔离，清空旧会话不影响新会话", () => {
  const oldSession = new TodoManager();
  const newSession = new TodoManager();
  oldSession.update([entry("旧会话任务", "in_progress")]);
  assert.equal(newSession.render(), "Todo list cleared (0 tasks).");

  newSession.update([entry("新会话任务", "pending")]);
  oldSession.update([]);
  assert.equal(oldSession.render(), "Todo list cleared (0 tasks).");
  assert.equal(newSession.render(), "Todo list (0/1 done):\n1. [ ] 新会话任务 (pending)");
});

test("tool 定义保留嵌套数组和对象的结构化 JSON Schema", () => {
  const tool = createTodoTool(new TodoManager());
  assert.equal(tool.name, "todo_write");
  assert.deepEqual(tool.parameters.required, ["todos"]);
  const schema = tool.parameters.properties.todos;
  assert.equal(schema.type, "array");
  assert.equal(schema.items.type, "object");
  assert.deepEqual(schema.items.required, ["content", "status"]);
});

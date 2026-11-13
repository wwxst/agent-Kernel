/**
 * 文件目的：让编码 Agent 用可更新的任务清单跟踪复杂工作的进度，而不是只靠模型临时记忆。
 *
 * 文件职责：校验完整的 TodoWrite 清单、原子替换当前计划、把进度渲染成工具结果；
 * 不负责调度任务、自动认定任务完成、跨进程持久化或终端界面（分别由模型、后续课程与 UI 负责）。
 *
 * 内容目录：
 *   - `TodoManager`：在同一个 Agent 会话中保留并更新计划，拒绝不合法的整体替换。
 *   - `createTodoTool()`：为现有 ToolRegistry 暴露 `todo_write` 的结构化工具说明书。
 *   - `TODO_PLANNING_GUIDANCE`：告诉模型复杂任务何时写计划、何时更新，简单任务无需硬套。
 *
 * 模块关系：只依赖 `protocol/types.ts` 的 Tool 类型；由 `cli.ts` 每次创建 Agent 时装配，
 * `ToolRegistry.execute()` 负责参数校验、Hooks 和错误折文本，模型通过工具结果获知最新计划。
 */
import type { Tool } from "../protocol/types.ts";

const MAX_TODOS = 20;
const MAX_CONTENT_CHARS = 200;
const VALID_STATUSES = new Set(["pending", "in_progress", "done"]);

type TodoStatus = "pending" | "in_progress" | "done";
interface Todo { content: string; status: TodoStatus }

/** 对模型输入进行原子校验；拒绝后保留上一份有效计划。 */
export class TodoManager {
  private todos: Todo[] = [];

  update(input: unknown): string {
    if (!Array.isArray(input)) throw new Error('todos must be an array');
    if (input.length > MAX_TODOS) throw new Error(`todos must contain at most ${MAX_TODOS} items`);

    const next: Todo[] = [];
    const seen = new Set<string>();
    let active = 0;
    for (const [index, raw] of input.entries()) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`todos[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      if (typeof item.content !== "string") throw new Error(`todos[${index}].content must be a string`);
      const content = item.content.trim();
      if (content === "") throw new Error(`todos[${index}].content must not be blank`);
      if (content.length > MAX_CONTENT_CHARS) {
        throw new Error(`todos[${index}].content must be at most ${MAX_CONTENT_CHARS} characters`);
      }
      if (/[\x00-\x1f\x7f]/u.test(content)) {
        throw new Error(`todos[${index}].content must be a single line without control characters`);
      }
      if (seen.has(content)) throw new Error(`duplicate todo: ${content}`);
      seen.add(content);
      if (typeof item.status !== "string" || !VALID_STATUSES.has(item.status)) {
        throw new Error(`todos[${index}].status must be pending, in_progress, or done`);
      }
      const status = item.status as TodoStatus;
      if (status === "in_progress") active++;
      next.push({ content, status });
    }
    if (active > 1) throw new Error("only one todo may be in_progress");

    this.todos = next;
    return this.render();
  }

  /** 返回当前计划的只读文本快照；供模型获得状态，不能通过引用改写内部数组。 */
  render(): string {
    if (this.todos.length === 0) return "Todo list cleared (0 tasks).";
    const done = this.todos.filter((todo) => todo.status === "done").length;
    const symbols: Record<TodoStatus, string> = { pending: " ", in_progress: "~", done: "x" };
    return `Todo list (${done}/${this.todos.length} done):\n` +
      this.todos.map((todo, index) => `${index + 1}. [${symbols[todo.status]}] ${todo.content} (${todo.status})`).join("\n");
  }
}

/** 只暴露一个完整清单写入工具；没有独立的任务调度或持久存储。 */
export function createTodoTool(manager: TodoManager): Tool {
  return {
    name: "todo_write",
    // 写入当前任务计划的完整列表；用 pending、in_progress、done 表示进度。
    // 最多 20 项，同一时刻只能有一项处于 in_progress。每次调用替换整个列表。
    description: "Write the full task plan with pending, in_progress, or done statuses. " +
      "At most 20 tasks and at most one in_progress. Each call replaces the whole list.",
    parameters: {
      type: "object",
      properties: {
        // 当前计划的完整清单；传空数组会清除计划。
        todos: {
          type: "array", description: "Complete task list; an empty array clears it.",
          items: {
            type: "object",
            properties: {
              // 一个具体、可验证的任务步骤，200 字符以内，单行。
              content: { type: "string", description: "Concrete, verifiable step (max 200 characters; single line)." },
              // 任务的三个状态之一：待执行、进行中或已完成。
              status: { type: "string", description: "One of: pending, in_progress, done." },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    run: async (args) => manager.update(args.todos),
  };
}

/** 只装进实际提供了 todo_write 的 CLI Agent 提示词，避免影响独立的 Agent 单元测试。 */
export const TODO_PLANNING_GUIDANCE = [
  // 对于有多个步骤的任务，开始操作前使用 todo_write 列出简明且可验证的计划。
  "For multi-step tasks, call todo_write to create a concise, verifiable plan before doing the work.",
  // 每完成一个步骤，就更新完整列表中的状态；同一时刻最多只有一个正在进行。
  "Update the full plan as steps finish; keep no more than one item in_progress.",
  // 不要未经验证就把步骤标为完成；简单的单步任务不需要计划。
  "Mark a step done only after verifying it; skip the plan for simple single-step requests.",
].join("\n");

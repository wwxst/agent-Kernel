/**
 * 文件目的：测命令行界面的显示 —— 模型说到一半又改口时，界面必须明确纠正，
 * 不能让前面那段错的草稿冒充最终答案。
 *
 * 文件职责：只覆盖「流式草稿与权威消息不一致」这一条展示规矩，以及同一批工具不重复提示。
 * 不负责测 Agent 循环、不负责测 TUI。
 *
 * 内容目录：
 *   - 一个用例：把 `process.stdout.write` 与 `console.log` 换成收集器，驱动
 *     `RunPresenter` 走一遍 start → thinking → delta → confirmAssistant → toolStart，
 *     断言更正提示只出现一次。
 *
 * 模块关系：依赖 `src/ui/cli-presenter.ts` 与 `node:test`，由 `npm test` 启动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RunPresenter } from "../src/ui/cli-presenter.ts";

test("CLI：流式草稿与权威消息不同会追加更正，同一工具批次不重复显示", () => {
  const output = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
  console.log = (...args) => { output.push(args.join(" ") + "\n"); };
  try {
    const presenter = new RunPresenter("compact", "balanced");
    presenter.start();
    presenter.thinking(1);
    presenter.delta("draft");
    presenter.confirmAssistant("confirmed");
    const call = { id: "1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } };
    presenter.toolStart(call);
    presenter.confirmAssistant("confirmed");
    presenter.toolStart({ ...call, id: "2" });

    const text = output.join("");
    assert.match(text, /draft/);
    assert.match(text, /\[stream corrected: confirmed message follows\]/);
    assert.match(text, /confirmed/);
    assert.equal((text.match(/\[stream corrected:/g) ?? []).length, 1);
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
});

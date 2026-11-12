/** CLI 流式输出只能追加字节：最终确认不一致时须明显纠正，而不是让错误草稿冒充答案。 */
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

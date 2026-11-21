import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function check(root, context = {}) {
  const taskDir = path.dirname(fileURLToPath(import.meta.url));
  const initialNotesDir = path.join(taskDir, "files", "notes");
  const notesDir = path.join(root, "notes");
  const initialNames = (await readdir(initialNotesDir)).filter((name) => name.endsWith(".md")).sort();
  const names = (await readdir(notesDir)).filter((name) => name.endsWith(".md")).sort();
  assert.equal(initialNames.length, 16, "the fixture must contain exactly 16 source notes");
  assert.deepEqual(names, initialNames, "all original source notes must remain available");

  const expected = [];
  for (const name of initialNames) {
    const [initial, current] = await Promise.all([
      readFile(path.join(initialNotesDir, name), "utf8"),
      readFile(path.join(notesDir, name), "utf8"),
    ]);
    assert.equal(current, initial, "source note must not be modified: " + name);
    const id = /^id: (.+)$/m.exec(initial)?.[1];
    const date = /^date: (.+)$/m.exec(initial)?.[1];
    const decision = /^decision: (.+)$/m.exec(initial)?.[1];
    assert.ok(id && date && decision, "each source note must have id, date, and decision");
    expected.push({ id, date, decision });
  }

  expected.sort((a, b) => a.date.localeCompare(b.date));
  const outputPath = path.join(root, "migration-summary.md");
  assert.ok(existsSync(outputPath), "migration-summary.md must be created");
  const output = await readFile(outputPath, "utf8");
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\|\s*id\s*\|\s*date\s*\|\s*decision\s*\|$/i.test(line));
  assert.notEqual(headerIndex, -1, "summary must contain the id/date/decision table header");
  const delimiter = (lines[headerIndex + 1] ?? "").trim();
  const delimiterCells = delimiter.startsWith("|") && delimiter.endsWith("|")
    ? delimiter.slice(1, -1).split("|").map((cell) => cell.trim())
    : [];
  assert.equal(delimiterCells.length, 3, "table must have three Markdown delimiter cells");
  assert.ok(delimiterCells.every((cell) => /^:?-{3,}:?$/.test(cell)),
    "table must contain a valid Markdown delimiter");

  // Markdown 表格中的空格与对齐冒号不属于字段值，不能因排版不同误判任务失败。
  // 仍然逐项核对 id/date/decision 原值、日期排序、恰好 16 行。
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    const text = line.trim();
    if (!text.startsWith("|")) break;
    assert.ok(text.endsWith("|"), "table data row must end with a pipe");
    const cells = text.slice(1, -1).split("|").map((cell) => cell.trim());
    assert.equal(cells.length, 3, "table data row must have three columns");
    rows.push({ id: cells[0], date: cells[1], decision: cells[2] });
  }
  assert.deepEqual(rows, expected, "all records must be exact and sorted by date");
  assert.equal(rows.length, 16, "summary must contain exactly 16 migration rows");
  assert.match(output, /^Final release gate: GO_WITH_CANARY$/m);
  assert.ok(context.compactionStats?.compactions >= 1, "the long-context task must trigger at least one committed context compaction");
  assert.ok(context.compactionStats?.summaryRequests >= 1, "the long-context task must issue a real summary request");
}

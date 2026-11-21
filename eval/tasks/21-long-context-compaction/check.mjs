import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function check(root) {
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
  assert.match(lines[headerIndex + 1] ?? "", /^\|\s*:?-{3,}\s*\|\s*:?-{3,}\s*\|\s*:?-{3,}\s*\|$/);
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) break;
    if (/^\| MIG-\d+ \|/.test(line)) rows.push(line);
  }
  const expectedRows = expected.map((item) =>
    "| " + item.id + " | " + item.date + " | " + item.decision + " |");
  assert.deepEqual(rows, expectedRows, "all records must be exact and sorted by date");
  assert.equal(rows.length, 16, "summary must contain exactly 16 migration rows");
  assert.match(output, /^Final release gate: GO_WITH_CANARY$/m);
}

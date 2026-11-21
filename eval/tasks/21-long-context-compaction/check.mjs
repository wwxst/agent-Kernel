import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function check(root) {
  const notesDir = path.join(root, "notes");
  const names = (await readdir(notesDir)).filter((name) => name.endsWith(".md")).sort();
  assert.equal(names.length, 16, "all 16 source notes must remain available");
  const expected = [];
  for (const name of names) {
    const content = await readFile(path.join(notesDir, name), "utf8");
    const id = /^id: (.+)$/m.exec(content)?.[1];
    const date = /^date: (.+)$/m.exec(content)?.[1];
    const decision = /^decision: (.+)$/m.exec(content)?.[1];
    assert.ok(id && date && decision, "each source note must have id, date, and decision");
    expected.push({ id, date, decision });
  }
  expected.sort((a, b) => a.date.localeCompare(b.date));
  const outputPath = path.join(root, "migration-summary.md");
  assert.ok(existsSync(outputPath), "migration-summary.md must be created");
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /\|\s*id\s*\|\s*date\s*\|\s*decision\s*\|/i);
  for (const item of expected) {
    const row = "| " + item.id + " | " + item.date + " | " + item.decision + " |";
    assert.ok(output.includes(row), "missing or altered migration record: " + item.id);
  }
  const rows = output.split(/\r?\n/).filter((line) => /^\| MIG-\d+ \|/.test(line));
  assert.equal(rows.length, 16, "summary must contain exactly 16 migration rows");
  assert.match(output, /^Final release gate: GO_WITH_CANARY$/m);
}

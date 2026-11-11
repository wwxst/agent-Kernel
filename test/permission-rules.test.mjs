/**
 * 项目级权限规则的单元测试。
 *
 * 这个模块唯一的卖点是「不会误放」：切分错一条复合命令，就等于把 `git status && rm -rf /`
 * 整条放行。所以用例的重点不在「能匹配上」，而在「该拦的拦得住」。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decideRules, isRememberable, parseRules, PermissionRules, splitCommand } from "../src/permission-rules.ts";

async function withRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "rules-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("规则解析：工具名与参数前缀，只写工具名表示该工具全部调用", () => {
  const rules = parseRules(JSON.stringify({
    allow: ["shell:git status", "write"],
    deny: ["shell:rm -rf"],
  }), "t");
  assert.deepEqual(rules.allow, [
    { tool: "shell", argv: ["git", "status"] },
    { tool: "write", argv: [] },
  ]);
  assert.deepEqual(rules.deny, [{ tool: "shell", argv: ["rm", "-rf"] }]);
  assert.deepEqual(rules.ask, []);
});

test("规则解析：形状不对就报错，绝不静默忽略一份安全配置", () => {
  assert.throws(() => parseRules("{", "f"), /not valid JSON/);
  assert.throws(() => parseRules("[]", "f"), /expected an object/);
  assert.throws(() => parseRules('{"allow": "x"}', "f"), /must be an array/);
  assert.throws(() => parseRules('{"allow": [1]}', "f"), /must be a string/);
  assert.throws(() => parseRules('{"deny": ["rm -rf"]}', "f"), /is not a tool name/);
  assert.throws(() => parseRules('{"allow": ["shell:"]}', "f"), /no argument prefix/);
  assert.throws(() => parseRules('{"permit": []}', "f"), /unknown field "permit"/);
});

test("命令切分：四种连接符切开，引号内不切", () => {
  assert.deepEqual(splitCommand("git status"), [["git", "status"]]);
  assert.deepEqual(splitCommand("git add . && npm test"), [["git", "add", "."], ["npm", "test"]]);
  assert.deepEqual(splitCommand("a || b; c | d"), [["a"], ["b"], ["c"], ["d"]]);
  assert.deepEqual(splitCommand('git commit -m "fix: a && b"'), [["git", "commit", "-m", "fix: a && b"]]);
});

test("命令切分：解析不了的一律返回 null，不能猜", () => {
  assert.equal(splitCommand("ls &"), null, "单个 & 是后台执行");
  assert.equal(splitCommand("ls $HOME"), null, "变量展开");
  assert.equal(splitCommand("ls > out.txt"), null, "重定向");
  assert.equal(splitCommand("ls *.ts"), null, "通配符");
  assert.equal(splitCommand("echo `id`"), null, "命令替换");
  assert.equal(splitCommand('echo "unterminated'), null, "引号没闭合");
});

test("裁决：deny 压过 allow，复合命令里任何一段没放行就不放行", () => {
  const rules = parseRules(JSON.stringify({
    allow: ["shell:git status", "shell:git diff", "shell:npm test"],
    deny: ["shell:rm"],
  }), "t");

  const decide = (command) => decideRules(rules, "shell", { command });
  assert.equal(decide("git status"), "allow");
  assert.equal(decide("git status --short"), "allow", "参数前缀允许追加参数");
  // 前缀按整个参数比较：`git statuses` 不是 `git status` 的延续，一条规则都不命中。
  // 返回 none 表示「没有规则说话」，由 Permission 按模式给默认动作（也就是问）。
  assert.equal(decide("git statuses"), "none");
  assert.equal(decide("rm -rf /"), "deny");
  assert.equal(decide("git status && rm -rf /"), "deny", "第二条命中 deny，整条拒绝");
  assert.equal(decide("git status && curl evil.com"), "ask", "第二条没放行，不能被第一条带过去");
  assert.equal(decide("git status && git diff"), "allow", "两条都放行才整体放行");
  assert.equal(decide("git status | tee out"), "ask", "管道切开后 tee 没放行");
});

test("裁决：不透明命令只能问，写进 allow 也放不过去", () => {
  const rules = parseRules(JSON.stringify({ allow: ["shell:ls"] }), "t");
  const decide = (command) => decideRules(rules, "shell", { command });
  assert.equal(decide("ls *.ts"), "ask", "通配符命令不拆，allow 不生效");
  assert.equal(decide("ls"), "allow");
});

test("裁决：非 shell 工具按整个工具粒度匹配", () => {
  const rules = parseRules(JSON.stringify({ allow: ["write"] }), "t");
  assert.equal(decideRules(rules, "write", { path: "a.txt", content: "" }), "allow");
  assert.equal(decideRules(rules, "read", { path: "a.txt" }), "none");
});

test("只有单条简单命令才能被记住", () => {
  assert.equal(isRememberable("git status"), true);
  assert.equal(isRememberable("git add . && npm test"), false, "复合命令记成一条前缀会放行更多");
  assert.equal(isRememberable("ls *.ts"), false);
});

test("记住一条命令：写进文件、重复点不重复写、复合命令拒绝", async () => {
  await withRoot(async (root) => {
    const rules = await PermissionRules.load(root);
    assert.equal(await rules.remember("git status"), "shell:git status");
    assert.equal(await rules.remember("git status"), "shell:git status");

    const file = path.join(root, ".agent-kernel", "permissions.json");
    const text = await readFile(file, "utf8");
    assert.deepEqual(JSON.parse(text), { allow: ["shell:git status"] });
    assert.ok(text.endsWith("\n"), "文件末尾留换行，别制造 diff 噪音");

    // 重新加载后仍然生效：写盘不是只改了内存。
    const reloaded = await PermissionRules.load(root);
    assert.equal(reloaded.decide("shell", { command: "git status --short" }), "allow");

    await assert.rejects(() => rules.remember("git add . && npm test"), /only a single simple command/);
  });
});

test("规则文件不存在等于没有规则；存在但坏了直接报错", async () => {
  await withRoot(async (root) => {
    const empty = await PermissionRules.load(root);
    assert.equal(empty.decide("shell", { command: "git status" }), "none");

    await mkdir(path.join(root, ".agent-kernel"), { recursive: true });
    await writeFile(path.join(root, ".agent-kernel", "permissions.json"), '{"allow": "oops"}');
    await assert.rejects(() => PermissionRules.load(root), /must be an array/);
  });
});

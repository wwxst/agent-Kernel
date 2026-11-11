/**
 * 权限规则的单元测试。
 *
 * 这个模块唯一的卖点是「不会误放」：切分错一条复合命令，就等于把 `git status && rm -rf /`
 * 整条放行。所以用例的重点不在「能匹配上」，而在「该拦的拦得住」。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decideRules, isRememberable, parseRules, PermissionRules, splitCommand } from "../src/permission-rules.ts";

/**
 * 每个用例一个临时工作区。
 *
 * 用户层规则从 home 读，所以必须把 `AGENT_KERNEL_HOME` 指到临时目录——
 * 否则测试会读到这台机器上真实的 `~/.agent-kernel/permissions.json`，结果随环境漂移。
 */
async function withRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "rules-"));
  const previous = process.env.AGENT_KERNEL_HOME;
  process.env.AGENT_KERNEL_HOME = path.join(root, "home");
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.AGENT_KERNEL_HOME;
    else process.env.AGENT_KERNEL_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

/** 把一份规则当成单独一层，省掉文件读写的噪声。 */
const layers = (rules) => [{ file: "test", rules }];
const decide = (rules, command) => decideRules(layers(rules), "shell", { command });

/** 在临时工作区里写一份规则文件。 */
async function writeRuleFile(root, relative, body) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(body));
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

  assert.equal(decide(rules, "git status"), "allow");
  assert.equal(decide(rules, "git status --short"), "allow", "参数前缀允许追加参数");
  // 前缀按整个参数比较：`git statuses` 不是 `git status` 的延续，一条规则都不命中。
  // 返回 none 表示「没有规则说话」，由 Permission 按模式给默认动作（也就是问）。
  assert.equal(decide(rules, "git statuses"), "none");
  assert.equal(decide(rules, "rm -rf /"), "deny");
  assert.equal(decide(rules, "git status && rm -rf /"), "deny", "第二条命中 deny，整条拒绝");
  assert.equal(decide(rules, "git status && curl evil.com"), "ask", "第二条没放行，不能被第一条带过去");
  assert.equal(decide(rules, "git status && git diff"), "allow", "两条都放行才整体放行");
  assert.equal(decide(rules, "git status | tee out"), "ask", "管道切开后 tee 没放行");
});

test("裁决：不透明命令只能问，写进 allow 也放不过去", () => {
  const rules = parseRules(JSON.stringify({ allow: ["shell:ls"] }), "t");
  assert.equal(decide(rules, "ls *.ts"), "ask", "通配符命令不拆，allow 不生效");
  assert.equal(decide(rules, "ls"), "allow");
});

test("裁决：非 shell 工具按整个工具粒度匹配", () => {
  const rules = parseRules(JSON.stringify({ allow: ["write"] }), "t");
  assert.equal(decideRules(layers(rules), "write", { path: "a.txt", content: "" }), "allow");
  assert.equal(decideRules(layers(rules), "read", { path: "a.txt" }), "none");
});

test("三层优先级：本地压过项目，项目压过用户", async () => {
  await withRoot(async (root) => {
    await writeRuleFile(root, "home/.agent-kernel/permissions.json", { allow: ["shell:git status"] });
    await writeRuleFile(root, ".agent-kernel/permissions.json", { ask: ["shell:git status"] });

    const projectWins = await PermissionRules.load(root);
    assert.equal(projectWins.decide("shell", { command: "git status" }), "ask", "项目层压过用户层");

    await writeRuleFile(root, ".agent-kernel/permissions.local.json", { allow: ["shell:git status"] });
    const localWins = await PermissionRules.load(root);
    assert.equal(localWins.decide("shell", { command: "git status" }), "allow", "本地层压过项目层");
  });
});

test("deny 跨层最强：项目写了 deny，本地 allow 也压不住", async () => {
  await withRoot(async (root) => {
    await writeRuleFile(root, ".agent-kernel/permissions.json", { deny: ["shell:rm -rf"] });
    await writeRuleFile(root, ".agent-kernel/permissions.local.json", { allow: ["shell:rm -rf"] });
    const rules = await PermissionRules.load(root);
    assert.equal(
      rules.decide("shell", { command: "rm -rf build" }),
      "deny",
      "安全方向的例外：禁止比允许更有分量",
    );
  });
});

test("只有单条简单命令才能被记住", () => {
  assert.equal(isRememberable("git status"), true);
  assert.equal(isRememberable("git add . && npm test"), false, "复合命令记成一条前缀会放行更多");
  assert.equal(isRememberable("ls *.ts"), false);
});

test("记住一条命令：写进本地层，不动项目层，并把自己加进 .gitignore", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".gitignore"), "node_modules\n");
    const rules = await PermissionRules.load(root);

    assert.equal(await rules.remember("git status"), "shell:git status");
    assert.equal(await rules.remember("git status"), "shell:git status");

    const local = await readFile(path.join(root, ".agent-kernel", "permissions.local.json"), "utf8");
    assert.deepEqual(JSON.parse(local), { allow: ["shell:git status"] });
    assert.ok(local.endsWith("\n"), "文件末尾留换行，别制造 diff 噪音");

    // 个人点的一下不能写进团队文件。
    await assert.rejects(
      () => readFile(path.join(root, ".agent-kernel", "permissions.json"), "utf8"),
      /ENOENT/,
      "项目层不该被写",
    );

    const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
    assert.equal(ignore, "node_modules\n.agent-kernel/permissions.local.json\n", "重复点不重复写");

    // 重新加载后仍然生效：写盘不是只改了内存。
    const reloaded = await PermissionRules.load(root);
    assert.equal(reloaded.decide("shell", { command: "git status --short" }), "allow");

    await assert.rejects(() => rules.remember("git add . && npm test"), /only a single simple command/);
  });
});

test(".gitignore 末尾没有换行时补一个，不能把两行粘在一起", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".gitignore"), "node_modules");
    const rules = await PermissionRules.load(root);
    await rules.remember("git status");
    assert.equal(
      await readFile(path.join(root, ".gitignore"), "utf8"),
      "node_modules\n.agent-kernel/permissions.local.json\n",
    );
  });
});

test("不是 git 仓库就不去动 .gitignore", async () => {
  await withRoot(async (root) => {
    const rules = await PermissionRules.load(root);
    await rules.remember("git status");
    await assert.rejects(() => readFile(path.join(root, ".gitignore"), "utf8"), /ENOENT/);
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

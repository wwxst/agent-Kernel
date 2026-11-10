/**
 * Workspace 的单元测试：路径边界和输出上限是这个模块唯一的两个卖点，
 * 所以它们必须在接口上被验证 —— 不碰私有的 resolve/truncate。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fillBuffer, terminateTree, Workspace } from "../src/workspace.ts";
import { withWorkspace } from "./support/harness.mjs";

test("编辑提交事件：真实前后文件快照一致，显示观察者抛错不改变工具结果", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "edit.txt");
    await writeFile(file, "top\nold\nbottom\n");
    const snapshots = [];
    const workspace = new Workspace({ root: dir,
      onEditCommitted: (requested, before, after) => snapshots.push({ requested, before, after }),
    });
    const result = await workspace.edit("edit.txt", "old", "new");
    assert.match(result, /edited edit\.txt/);
    assert.deepEqual(snapshots, [{
      requested: "edit.txt", before: "top\nold\nbottom\n",
      after: "top\nnew\nbottom\n",
    }]);
    assert.equal(await readFile(file, "utf8"), snapshots[0].after);
    const brokenViewer = new Workspace({ root: dir,
      onEditCommitted: () => { throw new Error("viewer failed"); },
    });
    assert.match(await brokenViewer.edit("edit.txt", "new", "done"), /edited edit\.txt/);
    assert.equal(brokenViewer.editObserverFailureCount, 1);
    assert.equal(await readFile(file, "utf8"), "top\ndone\nbottom\n");
  });
});

test("Windows taskkill 成功：只清理一次，不错误杀掉直接子进程", async () => {
  const killer = new EventEmitter();
  let kills = 0;
  const pending = terminateTree({ pid: 1234, kill: () => { kills++; return true; } }, {
    platform: "win32",
    spawnTaskkill: (pid) => {
      assert.equal(pid, 1234);
      return killer;
    },
  });

  killer.emit("close", 0);
  assert.equal(await pending, true);
  assert.equal(kills, 0);
});

test("Windows taskkill 启动失败：尝试 child.kill，错误和 close 不会重复执行", async () => {
  const killer = new EventEmitter();
  let kills = 0;
  const pending = terminateTree({ pid: 1234, kill: () => { kills++; return true; } }, {
    platform: "win32",
    spawnTaskkill: () => killer,
  });

  killer.emit("error", new Error("taskkill unavailable"));
  killer.emit("close", -1);
  assert.equal(await pending, false);
  assert.equal(kills, 1);
});

test("Windows taskkill 非零退出或启动时抛错：fallback 异常也不会中断清理", async () => {
  const killer = new EventEmitter();
  const child = { pid: 1234, kill: () => { throw new Error("already exited"); } };
  const nonzero = terminateTree(child, { platform: "win32", spawnTaskkill: () => killer });
  killer.emit("close", 1);
  assert.equal(await nonzero, false);
  assert.equal(await terminateTree(child, {
    platform: "win32",
    spawnTaskkill: () => { throw new Error("spawn unavailable"); },
  }), false);
});

test("没有 PID：taskkill 不启动，也不调用 child.kill", async () => {
  assert.equal(await terminateTree({ pid: undefined, kill: () => { throw new Error("must not kill"); } }, {
    platform: "win32",
    spawnTaskkill: () => { throw new Error("must not spawn"); },
  }), false);
});

test("Windows taskkill 挂起：限定时间后停止 killer，尝试停止直接子进程，并返回清理未确认", async () => {
  const killer = new EventEmitter();
  let helperKills = 0;
  let childKills = 0;
  killer.kill = () => { helperKills++; return true; };
  const pending = terminateTree({ pid: 4567, kill: () => { childKills++; return true; } }, {
    platform: "win32",
    timeoutMs: 20,
    spawnTaskkill: () => killer,
  });

  assert.equal(await pending, false, "不能将超时回退等同于整棵进程树清理成功");
  assert.equal(helperKills, 1);
  assert.equal(childKills, 1);

  // 超时后可能还有迟到的 close / error；不能再把 false 改回 true，或重复杀进程。
  killer.emit("close", 0);
  killer.emit("error", new Error("late helper error"));
  assert.equal(helperKills, 1);
  assert.equal(childKills, 1);
});

test("Windows taskkill 挂起且 helper.kill 抛错：依然有界结束并报告未确认", async () => {
  const killer = new EventEmitter();
  let childKills = 0;
  killer.kill = () => { throw new Error("helper already gone"); };
  const result = await terminateTree({ pid: 4567, kill: () => { childKills++; return true; } }, {
    platform: "win32",
    timeoutMs: 20,
    spawnTaskkill: () => killer,
  });

  assert.equal(result, false);
  assert.equal(childKills, 1);
});

test("write：临时文件写完但提交前取消，不截断既有文件且不遗留临时文件", async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "saved.txt");
    await writeFile(file, "original");
    let checks = 0;
    // 精确在临时内容写完后、rename 前的取消检查触发；不用依赖定时器运气。
    const signal = { get aborted() { return ++checks >= 4; } };
    const workspace = new Workspace({ root, signal });

    await assert.rejects(() => workspace.write("saved.txt", "new content"), /cancelled before file write/);
    assert.ok(checks >= 4, "必须触达临时文件写完后的最终提交检查");
    assert.equal(await readFile(file, "utf8"), "original");
    assert.equal((await readdir(root)).some((name) => name.startsWith(".agent-kernel-")), false);
  });
});

test("edit：临时写回后取消仍保留原内容且清理临时文件", async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "saved.txt");
    await writeFile(file, "before\n");
    let checks = 0;
    const signal = { get aborted() { return ++checks >= 2; } };
    const workspace = new Workspace({ root, signal });

    await assert.rejects(() => workspace.edit("saved.txt", "before", "after"), /cancelled before file write/);
    assert.ok(checks >= 2);
    assert.equal(await readFile(file, "utf8"), "before\n");
    assert.equal((await readdir(root)).some((name) => name.startsWith(".agent-kernel-")), false);
  });
});

test("原子覆盖：write/edit 保留已有文件的 POSIX 权限", {
  skip: process.platform === "win32" && "Windows mode 不能反映完整 ACL",
}, async () => {
  await withWorkspace(async (root) => {
    const file = path.join(root, "saved.txt");
    await writeFile(file, "before");
    await chmod(file, 0o600);
    const workspace = new Workspace({ root });
    await workspace.write("saved.txt", "after");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await workspace.edit("saved.txt", "after", "done");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(file, "utf8"), "done");
  });
});

test("write 后 read 能拿回原文，父目录自动创建", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    assert.equal(await workspace.write("nested/dir/hello.txt", "hello\n"), "wrote 6 chars to nested/dir/hello.txt");
    assert.equal(await workspace.read("nested/dir/hello.txt"), "hello\n");
  });
});

test("取消时 write 尚在校验路径：不创建文件也不提交内容", async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController();
    const workspace = new Workspace({ root, signal: controller.signal });

    const writing = workspace.write("nested/aborted.txt", "should-not-be-written");
    controller.abort(new Error("stop"));
    await assert.rejects(writing, /cancelled before file write/);
    await assert.rejects(() => readFile(path.join(root, "nested", "aborted.txt")), /ENOENT/);
  });
});

test("取消时 edit 尚在异步校验：原文件内容保持不变", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "safe.txt"), "before\n");
    const controller = new AbortController();
    const workspace = new Workspace({ root, signal: controller.signal });

    const editing = workspace.edit("safe.txt", "before", "after");
    controller.abort(new Error("stop"));
    await assert.rejects(editing, /cancelled before file write/);
    assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "before\n");
  });
});

test("工作区内部的符号链接别名仍可读写编辑，使用真实目标路径", async () => {
  await withWorkspace(async (root) => {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "alias"), "junction");
    const workspace = new Workspace({ root });

    await workspace.write("alias/note.txt", "hello\n");
    assert.equal(await workspace.read("alias/note.txt"), "hello\n");
    await workspace.edit("alias/note.txt", "hello", "world");

    assert.equal(await readFile(path.join(root, "real", "note.txt"), "utf8"), "world\n");
  });
});

test("写入期间链接别名被改向工作区外：不得修改外部文件", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-race-outside-"));
    const inner = path.join(root, "real");
    const alias = path.join(root, "alias");
    await mkdir(inner);
    await writeFile(path.join(outside, "note.txt"), "untouched\n");
    await symlink(inner, alias, "junction");
    const workspace = new Workspace({ root });

    try {
      // Windows 上路径校验可能比 unlink 更早失败。必须在创建 Promise 当刻接管拒绝，
      // 否则 Node test 会把稍后才安装的 catch 视为 unhandledRejection（即使随后 await）。
      const pending = workspace.write("alias/note.txt", "inside only\n").catch((error) => {
        assert.match(String(error), /path escapes workspace|ENOENT|ELOOP/);
      });
      // 在异步路径校验与真正写入的窗口切换别名；允许操作拒绝或写入原真实目录。
      await unlink(alias);
      await symlink(outside, alias, "junction");
      await pending;
      assert.equal(await readFile(path.join(outside, "note.txt"), "utf8"), "untouched\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("edit：唯一命中就替换，返回文件长度变化", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "a\n");

    assert.equal(await workspace.edit("f.txt", "a", "bb"), "edited f.txt (2 → 3 chars)");
    assert.equal(await workspace.read("f.txt"), "bb\n");
  });
});

test("edit：多行片段也能替换", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "line1\nline2\nline3\n");

    await workspace.edit("f.txt", "line1\nline2", "one\ntwo");

    assert.equal(await workspace.read("f.txt"), "one\ntwo\nline3\n");
  });
});

test("edit：找不到片段就报错，文件保持原样", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "hello\n");

    await assert.rejects(() => workspace.edit("f.txt", "goodbye", "x"), /old_string not found in f\.txt/);

    assert.equal(await workspace.read("f.txt"), "hello\n");
  });
});

test("edit：命中多处时拒绝，并说清命中几次", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "a\na\n");

    await assert.rejects(() => workspace.edit("f.txt", "a", "b"), /appears 2 times in f\.txt/);

    assert.equal(await workspace.read("f.txt"), "a\na\n");
  });
});

test("edit：空片段直接拒绝（否则能匹配到任何位置）", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "a\n");

    await assert.rejects(() => workspace.edit("f.txt", "", "x"), /old_string must not be empty/);
  });
});

test("edit：新片段是空串就是删除", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "keep\ndrop\n");

    await workspace.edit("f.txt", "drop\n", "");

    assert.equal(await workspace.read("f.txt"), "keep\n");
  });
});

test("edit：越界路径同样被拒绝", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "a");

    await assert.rejects(() => workspace.edit("../f.txt", "a", "b"), /path escapes workspace/);
  });
});

test("edit：CRLF 文件里用 LF 的片段也能命中，且不改变行尾风格", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("crlf.txt", "one\r\ntwo\r\n");

    await workspace.edit("crlf.txt", "one\ntwo", "uno\ndos");

    assert.equal(await workspace.read("crlf.txt"), "uno\r\ndos\r\n");
  });
});

test("read 不存在的文件抛错（折成 ERROR 是 ToolRegistry 的事）", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    await assert.rejects(() => workspace.read("missing.txt"), /ENOENT/);
  });
});

test("越界路径一律拒绝，错误里带上原始路径", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    const outside = path.join(root, "..", "outside.txt");

    await assert.rejects(() => workspace.read("../outside.txt"), /path escapes workspace: \.\.\/outside\.txt/);
    await assert.rejects(() => workspace.read(outside), /path escapes workspace/);
    await assert.rejects(() => workspace.list(".."), /path escapes workspace/);
    await assert.rejects(() => workspace.write("../escape.txt", "nope"), /path escapes workspace/);
  });
});

test("Windows 上反斜杠按分隔符处理", { skip: path.sep !== "\\" && "反斜杠只在 Windows 上是分隔符" }, async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    await assert.rejects(() => workspace.read("..\\..\\escaped.txt"), /path escapes workspace/);
  });
});

test("以 .. 开头的文件名是合法的，不该被误杀", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    await workspace.write("..notes.md", "still inside\n");

    assert.equal(await workspace.read("..notes.md"), "still inside\n");
  });
});

test("read 超长内容会截断，并说明藏了多少字符", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("big.txt", "x".repeat(9_000));

    const text = await workspace.read("big.txt");

    assert.equal(text.length, 8_000 + "\n… [truncated 1000 chars]".length);
    assert.match(text, /\[truncated 1000 chars\]$/);
  });
});

test("list 每行带类型、字节数和名字", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("b.txt", "12345");
    await workspace.write("sub/a.txt", "x");

    const rows = (await workspace.list(".")).split("\n");

    assert.equal(rows.length, 2);
    assert.match(rows[0], /^dir\s+0\s+sub$/);
    assert.match(rows[1], /^file\s+5\s+b\.txt$/);
  });
});

test("list 空目录给出显式提示，而不是空串", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await mkdir(path.join(root, "sub"));

    assert.equal(await workspace.list("sub"), "(empty directory)");
  });
});

test("run 返回 exit code 加两路输出", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    const ok = await workspace.run('node -e "console.log(\'hi\')"');
    assert.match(ok, /^exit 0/);
    assert.match(ok, /hi/);

    const failed = await workspace.run('node -e "process.exit(3)"');
    assert.match(failed, /^exit 3/);
  });
});

test("run 的输出同样受 8000 字符上限约束", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    const output = await workspace.run('node -e "console.log(\'y\'.repeat(9000))"');

    assert.match(output, /\[truncated \d+ chars\]/);
    // 丢弃统计必须留在最后 —— 它是被二次截断时最容易丢掉的一句。
    assert.match(output, /\[dropped 1001 chars\]$/);
  });
});

test("glob：按模式找文件，返回排好序的相对路径", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.ts", "");
    await workspace.write("sub/b.ts", "");
    await workspace.write("sub/c.md", "");

    assert.equal(await workspace.glob("**/*.ts"), "a.ts\nsub/b.ts");
  });
});

test("glob：不带 ** 的模式只匹配根目录", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("root.md", "");
    await workspace.write("sub/nested.md", "");

    assert.equal(await workspace.glob("*.md"), "root.md");
  });
});

test("glob：没有命中时给出明确提示", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.ts", "");

    assert.equal(await workspace.glob("**/*.rs"), "(no matches)");
  });
});

test("glob：模式里带 .. 或绝对路径一律拒绝", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    await assert.rejects(() => workspace.glob("../**/*.ts"), /path escapes workspace/);
    await assert.rejects(() => workspace.glob(path.join(root, "**/*.ts")), /must be relative/);
  });
});

test("grep：跨文件搜索，每行带 路径:行号: 内容", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "hello\nworld\n");
    await workspace.write("sub/b.txt", "world again\n");

    assert.equal(await workspace.grep("world"), "a.txt:2: world\nsub/b.txt:1: world again");
  });
});

test("grep：给了 path 就只搜那棵子树", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "world\n");
    await workspace.write("sub/b.txt", "world again\n");

    assert.equal(await workspace.grep("world", "sub"), "sub/b.txt:1: world again");
  });
});

test("grep：没有命中时给出明确提示", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "hello\n");

    assert.equal(await workspace.grep("goodbye"), "(no matches)");
  });
});

test("grep：按正则搜索，元字符有特殊含义", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "value = a.b\naxb\nab\n");

    // `.` 匹配任意字符：a.b 命中 "a.b" 和 "axb"，不命中 "ab"。
    assert.equal(await workspace.grep("a.b"), "a.txt:1: value = a.b\na.txt:2: axb");
    // 坏正则在开始扫描前就要失败，不能变成「静默没搜到」。
    await assert.rejects(() => workspace.grep("(["), /invalid pattern/);
  });
});

test("grep：fixed=true 时回到字面搜索", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "value = a.b\naxb\n([\n");

    assert.equal(await workspace.grep("a.b", ".", { fixed: true }), "a.txt:1: value = a.b");
    assert.equal(await workspace.grep("([", ".", { fixed: true }), "a.txt:3: ([");
  });
});

test("grep：flags 支持忽略大小写，未知标志直接报错", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "Hello\nworld\n");

    assert.equal(await workspace.grep("hello", ".", { flags: "i" }), "a.txt:1: Hello");
    // g 是逐行匹配用不到的标志，忽略即可；x 是写错了，必须报出来。
    assert.equal(await workspace.grep("hello", ".", { flags: "gi" }), "a.txt:1: Hello");
    await assert.rejects(() => workspace.grep("hello", ".", { flags: "x" }), /unsupported regex flags/);
  });
});

test("grep：灾难性回溯会被超时打断，不会卡死主线程", async () => {
  await withWorkspace(async (root) => {
    // 40 个 a 再加一个 !：`(a+)+$` 在这行上是 2^40 级回溯，正常跑完要按年算。
    await writeFile(path.join(root, "evil.txt"), `${"a".repeat(40)}!\n`);
    const workspace = new Workspace({ root, regexBudgetMs: 50 });

    const started = Date.now();
    const result = await workspace.grep("(a+)+$");
    const elapsed = Date.now() - started;

    assert.match(result, /regex stopped after 50ms; results may be incomplete/);
    assert.equal(elapsed < 3_000, true, `超时后必须很快返回，实际用了 ${elapsed}ms`);
  });
});

test("grep：取消信号会打断正在匹配的线程", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "evil.txt"), `${"a".repeat(40)}!\n`);
    const controller = new AbortController();
    // 预算给得很宽，能停下来的唯一理由只能是取消。
    const workspace = new Workspace({ root, signal: controller.signal, regexBudgetMs: 10_000 });

    const running = workspace.grep("(a+)+$");
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(() => running, /cancelled by signal/);
  });
});

test("grep：空搜索模式直接拒绝（否则等于列出所有内容）", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "hello\n");

    await assert.rejects(() => workspace.grep(""), /search pattern must not be empty/);
  });
});

test("grep：跳过 node_modules 和 .git，并且只看文本文件", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "world\n");
    await workspace.write("node_modules/pkg/index.js", "world\n");
    await workspace.write(".git/config", "world\n");
    await workspace.write("blob.bin", "world\u0000binary\n");

    assert.equal(await workspace.grep("world"), "a.txt:1: world");
  });
});

test("grep：越界路径同样被拒绝", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "world\n");

    await assert.rejects(() => workspace.grep("world", ".."), /path escapes workspace/);
  });
});

test("glob：和 grep 一样跳过 node_modules 和 .git", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("src/a.ts", "");
    await workspace.write("node_modules/pkg/b.ts", "");
    await workspace.write(".git/c.ts", "");

    assert.equal(await workspace.glob("**/*.ts"), "src/a.ts");
  });
});

test("glob：花括号 / 方括号按字面匹配，绕不出工作区", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("src/a.ts", "");

    // 工作区外放一个「诱饵」文件：以前 {../x,src} 这种花括号展开能把它列出来。
    const outside = path.join(root, "..", `outside-${path.basename(root)}.ts`);
    await writeFile(outside, "secret\n");
    try {
      assert.equal(await workspace.glob("{../outside,src}/**/*.ts"), "(no matches)");
      assert.equal(await workspace.glob("[a-z]*.ts"), "(no matches)");
      await assert.rejects(() => workspace.glob("../**/*.ts"), /path escapes workspace/);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("glob：命中超过上限时明确告诉模型被截断", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    for (let index = 0; index < 205; index++) {
      await workspace.write(`many/f${String(index).padStart(3, "0")}.txt`, "");
    }

    const result = await workspace.glob("many/*.txt");

    assert.match(result, /… \(stopped at 200 matches\)$/);
  });
});

test("符号链接指向工作区外：read / write / list / grep 一律拒绝", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret\n");

    const workspace = new Workspace({ root });
    await symlink(outside, path.join(root, "link"), "junction");

    try {
      await assert.rejects(() => workspace.read("link/secret.txt"), /path escapes workspace/);
      await assert.rejects(() => workspace.write("link/new.txt", "x"), /path escapes workspace/);
      await assert.rejects(() => workspace.list("link"), /path escapes workspace/);
      await assert.rejects(() => workspace.grep("secret", "link"), /path escapes workspace/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("read：大文件只读进上限字节，不把整个文件塞进内存", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "big.log"), "x".repeat(65_536));
    const workspace = new Workspace({ root });

    const text = await workspace.read("big.log");

    assert.match(text, /\[truncated \d+ chars\]/);
    assert.match(text, /… \[stopped after 32768 bytes\]$/);
  });
});

test("grep：超大文件直接跳过，并在结果里说明", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "big.log"), "match\n" + "x".repeat(1_100_000));
    const workspace = new Workspace({ root });
    await workspace.write("small.txt", "nothing\n");

    const result = await workspace.grep("match");

    assert.match(result, /skipped 1 files over 1 MB/);
  });
});

test("grep：扫描预算用尽时说明结果不完整", async () => {
  await withWorkspace(async (root) => {
    for (let index = 0; index < 20; index++) {
      await writeFile(path.join(root, `f${index}.txt`), "nothing\n");
    }
    // 预算只够看 5 个目录项：要停下来，并且把「没搜完」说出去。
    const workspace = new Workspace({ root, scanLimit: 5 });

    const result = await workspace.grep("needle");

    assert.match(result, /scan stopped after 5 entries; results may be incomplete/);
  });
});

test("glob：扫描预算用尽时同样要说明", async () => {
  await withWorkspace(async (root) => {
    for (let index = 0; index < 20; index++) {
      await writeFile(path.join(root, `f${index}.txt`), "");
    }
    const workspace = new Workspace({ root, scanLimit: 5 });

    const result = await workspace.glob("**/*.txt");

    assert.match(result, /scan stopped after 5 entries; results may be incomplete/);
  });
});

test("edit：重叠的命中也算多处，不能被当成唯一", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "aaa\n");

    await assert.rejects(() => workspace.edit("f.txt", "aa", "b"), /appears 2 times/);
  });
});

test("run：stdout/stderr UTF-8 多字节被拆成独立分片仍完整解码", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    const command = 'node -e "process.stdout.write(Buffer.from([0xe4])); process.stderr.write(Buffer.from([0xe6])); setTimeout(() => { process.stdout.write(Buffer.from([0xb8,0xad])); process.stderr.write(Buffer.from([0x96,0x87])); }, 50)"';
    const result = await workspace.run(command);
    assert.match(result, /^exit 0/);
    assert.match(result, /中/);
    assert.match(result, /文/);
    assert.doesNotMatch(result, /\uFFFD/, "不能把分片汉字变成 UTF-8 替换字符");
  });
});

test("run：超时是独立的执行结果，不是普通的退出码", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root, timeoutMs: 300 });

    const result = await workspace.run('node -e "setTimeout(() => {}, 5000)"');

    assert.match(result, /^timeout after 300ms/);
  });
});

test("run：超时后整棵进程树都被杀掉，孙进程不会再写文件", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root, timeoutMs: 400 });
    const marker = path.join(root, "marker.txt");

    // node 是 cmd 的孙进程：只杀外层 shell 的话，它还会在 800ms 后把标记写出来。
    await workspace.run(
      `node -e "setTimeout(() => require('node:fs').writeFileSync('marker.txt', 'x'), 800)"`,
    );
    await new Promise((done) => setTimeout(done, 1_500));

    assert.equal(existsSync(marker), false, "超时后孙进程仍在运行");
  });
});

test(
  "grep：读不了的文件必须报出来，不能静默跳过",
  { skip: (process.platform === "win32" || process.getuid?.() === 0) && "chmod 拦不住文件所有者或 root 的读取" },
  async () => {
    await withWorkspace(async (root) => {
      const workspace = new Workspace({ root });
      await workspace.write("ok.txt", "hello\n");
      await workspace.write("locked.txt", "hello\n");
      const locked = path.join(root, "locked.txt");
      await chmod(locked, 0o000);

      try {
        const result = await workspace.grep("hello");

        assert.match(result, /1 files could not be read/);
        assert.match(result, /ok\.txt:1: hello/);
      } finally {
        // 恢复权限，否则临时目录删不掉。
        await chmod(locked, 0o644);
      }
    });
  },
);

test("fillBuffer：一次 read 只返回半截时继续读，直到读满", async () => {
  const source = Buffer.from("0123456789");
  const buffer = Buffer.alloc(10);
  const chunkSizes = [3, 2, 5];
  let reads = 0;
  const read = async (target, offset, length, position) => {
    assert.equal(position, offset, "续读必须从上次停下的位置开始");
    const size = Math.min(chunkSizes[reads++] ?? 0, length);
    source.copy(target, offset, position, position + size);
    return { bytesRead: size };
  };

  assert.equal(await fillBuffer(read, buffer), 10);
  assert.equal(buffer.toString(), "0123456789");
  assert.equal(reads, 3);
});

test("fillBuffer：读到 EOF 就停，不会在文件末尾空转", async () => {
  const buffer = Buffer.alloc(8);
  let reads = 0;
  const read = async (target) => {
    reads += 1;
    if (reads > 1) return { bytesRead: 0 };
    Buffer.from("abc").copy(target, 0);
    return { bytesRead: 3 };
  };

  assert.equal(await fillBuffer(read, buffer), 3);
  assert.equal(reads, 2);
});

test("read：文件正好等于读取上限时不算截断", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "exact.txt"), "x".repeat(32_768));
    const workspace = new Workspace({ root });

    const text = await workspace.read("exact.txt");

    assert.equal(text.includes("stopped after 32768 bytes"), false);
  });
});

test("read：多一个字节就标记截断，且不会制造半个 UTF-8 字符", async () => {
  await withWorkspace(async (root) => {
    // 32767 个 ASCII + 一个 3 字节字符：截断点正好落在这个字符中间。
    await writeFile(path.join(root, "cut.txt"), "a".repeat(32_767) + "€" + "tail");
    const workspace = new Workspace({ root });

    const text = await workspace.read("cut.txt");

    assert.match(text, /stopped after 32768 bytes/);
    assert.equal(text.includes("\uFFFD"), false, "截断不该制造替换字符");
  });
});

test("edit：超大文件直接拒绝，原文件一个字节都不动", async () => {
  await withWorkspace(async (root) => {
    const original = Buffer.alloc(2_000_001, "a");
    original.write("TAIL", original.length - 4);
    const file = path.join(root, "big.txt");
    await writeFile(file, original);
    const workspace = new Workspace({ root });

    await assert.rejects(() => workspace.edit("big.txt", "a", "b"), /larger than 2000000 bytes/);

    const after = await readFile(file);
    assert.equal(after.length, original.length);
    assert.equal(after.equals(original), true, "失败的 edit 不能改写原文件");
  });
});

test("edit：大文件读全后再改，尾部不会被悄悄截掉", async () => {
  await withWorkspace(async (root) => {
    const body = "a".repeat(1_000_000) + "MIDDLE" + "b".repeat(999_990) + "TAIL";
    await writeFile(path.join(root, "big.txt"), body);
    const workspace = new Workspace({ root });

    await workspace.edit("big.txt", "MIDDLE", "X");

    const after = await readFile(path.join(root, "big.txt"), "utf8");
    assert.equal(after, "a".repeat(1_000_000) + "X" + "b".repeat(999_990) + "TAIL");
  });
});

test("list：条目超过上限时先排序再截断，并说明还有多少", async () => {
  await withWorkspace(async (root) => {
    for (let index = 0; index < 505; index++) {
      await writeFile(path.join(root, `f${String(index).padStart(3, "0")}.txt`), "");
    }
    const workspace = new Workspace({ root });

    const result = await workspace.list(".");
    const rows = result.split("\n").filter((line) => line.startsWith("file "));
    const shown = rows.map((line) => line.slice(-8));

    // 500 行本身会超过 8000 字符的输出上限，所以正文会被截断 —— 但尾注必须保住。
    assert.match(result, /\[truncated \d+ chars\]/);
    assert.match(result, /… \(5 more entries not listed\)$/);
    assert.equal(shown[0], "f000.txt", "排序发生在截断之前");
    assert.deepEqual(shown, [...shown].sort());
  });
});

test("list：扫描预算耗尽时明确说目录可能没列全", async () => {
  await withWorkspace(async (root) => {
    for (let index = 0; index < 20; index++) {
      await writeFile(path.join(root, `f${index}.txt`), "");
    }
    const workspace = new Workspace({ root, scanLimit: 5 });

    const result = await workspace.list(".");

    assert.match(result, /scan stopped after 5 entries; listing may be incomplete/);
  });
});

test("grep：链接别名在扫描时切向工作区外，不读取外部文件", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-grep-race-"));
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "inside.ts"), "needle inside\n");
    await writeFile(path.join(outside, "secret.ts"), "needle EXTERNAL_SECRET\n");
    const alias = path.join(root, "alias");
    await symlink(path.join(root, "real"), alias, "junction");
    const workspace = new Workspace({ root });
    try {
      assert.match(await workspace.grep("needle", "alias"), /real\/inside\.ts:1: needle inside/);
      // 接管异步拒绝：切换发生在 realpath / opendir 的异步窗口，两种安全结局均可。
      const pending = workspace.grep("needle", "alias").catch((error) => {
        assert.match(String(error), /path escapes workspace|ENOENT|ELOOP/);
        return "";
      });
      await unlink(alias);
      await symlink(outside, alias, "junction");
      const result = await pending;
      assert.doesNotMatch(result, /EXTERNAL_SECRET/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("glob / grep：工作区内的符号链接目录不会把扫描带到外面", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-linked-"));
    await writeFile(path.join(outside, "secret.ts"), "needle\n");
    await symlink(outside, path.join(root, "nested-link"), "junction");
    await writeFile(path.join(root, "inside.ts"), "needle\n");

    try {
      const workspace = new Workspace({ root });
      assert.equal(await workspace.glob("**/*.ts"), "inside.ts");
      assert.equal(await workspace.grep("needle"), "inside.ts:1: needle");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("grep：超长行被截断时留下明确标记", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("long.txt", "needle " + "x".repeat(300) + "\n");

    const result = await workspace.grep("needle");

    assert.match(result, /…\[line truncated\]$/);
    assert.equal(result.includes("x".repeat(201)), false);
  });
});

test("run：取消后整棵进程树都被杀掉，run 等清理完才返回", async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController();
    const workspace = new Workspace({ root, signal: controller.signal, timeoutMs: 10_000 });
    const marker = path.join(root, "marker.txt");

    setTimeout(() => controller.abort(new Error("test cancel")), 300);
    const started = Date.now();
    const result = await workspace.run(
      `node -e "setTimeout(() => require('node:fs').writeFileSync('marker.txt', 'x'), 900)"`,
    );
    const elapsed = Date.now() - started;

    assert.match(result, /^cancelled by signal/);
    assert.ok(elapsed < 5_000, `run 应该很快返回，实际 ${elapsed}ms`);
    await new Promise((done) => setTimeout(done, 1_500));
    assert.equal(existsSync(marker), false, "取消后孙进程仍在运行");
  });
});

test("run：已经取消的工作区不会再启动新进程", async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const workspace = new Workspace({ root, signal: controller.signal });

    await assert.rejects(() => workspace.run("echo should-not-run"), /cancelled before the command started/);
  });
});

test("edit：写回时保留文件开头的 UTF-8 BOM", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("bom.txt", "\uFEFFhello world\n");

    await workspace.edit("bom.txt", "world", "there");

    const bytes = await readFile(path.join(root, "bom.txt"));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM 不应该被 edit 吃掉");
    assert.equal(bytes.toString("utf8"), "\uFEFFhello there\n");
  });
});

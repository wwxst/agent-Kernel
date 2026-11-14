/**
 * 文件目的：测工作区 —— 路径算得准不准、输出有没有上限，是它存在的两个理由，
 * 所以这两件事必须在外面能测到的地方验证。
 *
 * 文件职责：`Workspace` 九个方法的全部外部行为，外加进程树清理与后台任务的边界。
 * 不测工具箱怎么把异常折成文本（那是 `tool-registry.test.mjs`）。
 *
 * 内容目录：
 *   - 辅助：`waitGone()` 等进程真的消失（`taskkill` 返回成功不等于进程已退场）。
 *   - 写与改：原子提交后的前后快照、超大文件不给快照、取消不截断原文件、保留权限与 BOM、
 *     符号链接换向不碰外部文件、`edit` 唯一命中 / 多处拒绝 / 空片段拒绝 / CRLF 兼容。
 *   - 读与列：超长截断并说明、正好等于上限不算截断、半个 UTF-8 字符不出现、
 *     空目录显式提示、条目超限先排序再截断。
 *   - 搜索：`glob` 的模式、搜索根与重复通配符有界匹配；`grep` 的正则 / `fixed` / flags / 超长行 / 超大文件跳过 /
 *     扫描预算用尽 / 灾难性回溯被超时打断 / 取消打断匹配线程 / 跳过 `node_modules` 与 `.git`。
 *   - 跑命令：exit code 与两路输出、8000 字符上限、多字节分片解码、超时与取消后整棵进程树被杀、
 *     Windows `taskkill` 的各种失败路径。
 *   - 后台任务：立即返回编号、增量输出不重复、exit code 状态、单次 8k 上限与「还有」提示、
 *     多字节分片、多 Workspace 日志隔离、取消等待与日志缺失显式失败、`shell-kill` 后进程真的消失、未知编号报错。
 *   - 边界：工作区外读写与 `shell`、`..` 开头的文件名合法、Windows 反斜杠按分隔符处理。
 *
 * 模块关系：依赖 `src/tools/workspace.ts`、`test/support/harness.mjs` 与 `node:test`，
 * 由 `npm test` 启动；少数 Windows 专用用例在其他平台自动跳过。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fillBuffer, terminateTree, Workspace } from "../src/tools/workspace.ts";
import { withWorkspace } from "./support/harness.mjs";

/**
 * 等一个进程真的消失。
 *
 * `taskkill` 返回成功只代表系统接受了请求，Windows 上它还要一会儿才释放 cwd ——
 * 测试紧接着删临时目录就会撞上 EBUSY，所以收尾必须等进程退场，不能靠 sleep 猜。
 */
async function waitGone(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

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

test("write 文件差异：新建和覆盖均在原子提交后提供真实前后快照", async () => {
  await withWorkspace(async (dir) => {
    const events = [];
    const workspace = new Workspace({ root: dir, onWriteCommitted: (file, before, after, created) => {
      events.push({ file, before, after, created });
    } });
    assert.match(await workspace.write("generated.ts", "const value = 1;\n"), /wrote/);
    assert.match(await workspace.write("generated.ts", "const value = 2;\n"), /wrote/);
    assert.deepEqual(events, [
      { file: "generated.ts", before: "", after: "const value = 1;\n", created: true },
      { file: "generated.ts", before: "const value = 1;\n", after: "const value = 2;\n", created: false },
    ]);
    assert.equal(await readFile(path.join(dir, "generated.ts"), "utf8"), events[1].after);
  });
});

test("P2 write：超过 2,000,000 字节 的新文件和旧文件覆盖成功后均报告 Diff 快照不可用", async () => {
  await withWorkspace(async (root) => {
    const events = [];
    const workspace = new Workspace({ root, onWriteCommitted: (file, before, after, created) => {
      events.push({ file, before, after, created });
    } });
    const hugeContent = "Q".repeat(2_000_001);
    const created = await workspace.write("huge-new.txt", hugeContent);
    assert.match(created, /wrote 2000001 chars/);
    assert.equal((await stat(path.join(root, "huge-new.txt"))).size, hugeContent.length);
    assert.deepEqual(events[0], { file: "huge-new.txt", before: "", after: undefined, created: true },
      "新写入文件过大时不得静默丢掉通知，也不得伪造 Diff 快照");

    await writeFile(path.join(root, "huge-old.txt"), hugeContent);
    const replaced = await workspace.write("huge-old.txt", "short text\n");
    assert.match(replaced, /wrote 11 chars/);
    assert.equal(await readFile(path.join(root, "huge-old.txt"), "utf8"), "short text\n");
    assert.deepEqual(events[1], {
      file: "huge-old.txt", before: undefined, after: "short text\n", created: false,
    }, "旧内容太大时也应报告 Diff 快照不可用，但写入成功状态不变");
    assert.equal((await readdir(root)).some((name) => name.startsWith(".agent-kernel-")), false,
      "大文件 write 仍应清理原子写入临时文件");
  });
});

test("P2 read：图片观察者存在时，32 KiB 截断尾注和 8 KiB 输出警告必须保留", async () => {
  await withWorkspace(async (root) => {
    const bytes = Buffer.alloc(32_769, 65);
    await writeFile(path.join(root, "large.png"), bytes);
    const observed = [];
    const workspace = new Workspace({ root, onImageRead: (name, data) => observed.push({ name, data }) });
    const result = await workspace.read("large.png");
    assert.match(result, /\[truncated \d+ chars\]/, "输出上限警告不能被图片预览回调覆盖");
    assert.match(result, /… \[stopped after 32768 bytes\]$/, "必须保留 read 本身的字节上限尾注");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].name, "large.png");
    assert.equal(observed[0].data.length, bytes.length, "只有已获准的 read 可给 UI 有界图片字节");
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
    let committedNotices = 0;
    const workspace = new Workspace({ root, signal,
      onWriteCommitted: () => { committedNotices++; },
    });

    await assert.rejects(() => workspace.write("saved.txt", "new content"), /cancelled before file write/);
    assert.equal(committedNotices, 0, "取消提交不能发出成功的 Diff 快照事件");
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

test("edit：可以编辑工作区外的文件", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-outside-"));
    const file = path.join(outside, "f.txt");
    await writeFile(file, "a");
    try {
      const workspace = new Workspace({ root });

      await workspace.edit(file, "a", "b");

      assert.equal(await readFile(file, "utf8"), "b");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

test("read：FIFO 特殊文件不会阻塞读取，且明确拒绝非普通文件", {
  skip: process.platform === "win32" && "mkfifo is not available on Windows",
}, async () => {
  await withWorkspace(async (root) => {
    const fifo = path.join(root, "pipe");
    const created = spawnSync("mkfifo", [fifo]);
    assert.equal(created.status, 0, created.stderr?.toString() ?? "mkfifo failed");
    const workspace = new Workspace({ root });
    await assert.rejects(
      () => Promise.race([
        workspace.read("pipe"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO read blocked")), 500)),
      ]),
      /regular file/,
    );
  });
});

test("read 不存在的文件抛错（折成 ERROR 是 ToolRegistry 的事）", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    await assert.rejects(() => workspace.read("missing.txt"), /ENOENT/);
  });
});

test("工作区外路径可以读写列出：../ 与绝对路径都可用", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-outside-"));
    const file = path.join(outside, "notes.txt");
    const name = path.basename(outside);
    try {
      const workspace = new Workspace({ root });

      await workspace.write(file, "outside\n");

      assert.equal(await workspace.read(`../${name}/notes.txt`), "outside\n");
      assert.equal(await workspace.read(file), "outside\n");
      assert.match(await workspace.list(`../${name}`), /notes\.txt/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("Windows 上反斜杠按分隔符处理", { skip: path.sep !== "\\" && "反斜杠只在 Windows 上是分隔符" }, async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    const name = `escaped-${path.basename(root)}.txt`;

    await workspace.write(`..\\${name}`, "x");

    try {
      assert.equal(await workspace.read(`..\\${name}`), "x");
    } finally {
      await rm(path.join(root, "..", name), { force: true });
    }
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

test("glob：重复通配符的失败匹配有界返回，不在主线程指数回溯", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, `${"a".repeat(80)}.txt`), "");
    const workspaceUrl = new URL("../src/tools/workspace.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { Workspace } from ${JSON.stringify(workspaceUrl)};
       console.log(await new Workspace({ root: process.argv[1] }).glob('*a'.repeat(30) + 'b'));`,
      root], { encoding: "utf8", timeout: 3_000 });
    assert.equal(result.error, undefined, "合法 glob 的匹配不能耗尽整个子进程时限");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "(no matches)");
  });
});

test("glob：搜索根与绝对模式都能匹配工作区外的文件", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-outside-"));
    await writeFile(path.join(outside, "x.ts"), "");
    const expected = (await realpath(path.join(outside, "x.ts"))).split(path.sep).join("/");
    try {
      const workspace = new Workspace({ root });

      assert.equal(await workspace.glob(path.join(outside, "*.ts")), expected);
      assert.equal(await workspace.glob("*.ts", outside), expected);
      // 模式中间的 .. 仍然拒绝：glob 语义里没有唯一解释。
      await assert.rejects(() => workspace.glob("src/../*.ts"), /only use "\.\." at the start/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

test("grep：可以搜索工作区外的目录，结果用绝对路径", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-outside-"));
    await writeFile(path.join(outside, "a.txt"), "world\n");
    try {
      const workspace = new Workspace({ root });

      const result = await workspace.grep("world", outside);
      const expected = (await realpath(path.join(outside, "a.txt"))).split(path.sep).join("/");

      assert.equal(result, `${expected}:1: world`);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

test("glob：花括号 / 方括号按字面匹配", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("src/a.ts", "");

    // 只认 *、**、?；花括号和方括号没有特殊含义，不会被展开成别的路径。
    assert.equal(await workspace.glob("{../outside,src}/**/*.ts"), "(no matches)");
    assert.equal(await workspace.glob("[a-z]*.ts"), "(no matches)");
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

test("符号链接指向工作区外：read / write / list / grep 正常工作", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret\n");

    const workspace = new Workspace({ root });
    await symlink(outside, path.join(root, "link"), "junction");

    try {
      assert.equal(await workspace.read("link/secret.txt"), "secret\n");
      await workspace.write("link/new.txt", "x\n");
      assert.equal(await readFile(path.join(outside, "new.txt"), "utf8"), "x\n");
      assert.match(await workspace.list("link"), /secret\.txt/);
      assert.match(await workspace.grep("secret", "link"), /secret\.txt:1: secret/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("shell：可以在工作区外执行命令并删除文件", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "agent-kernel-outside-"));
    const file = path.join(outside, "temp.txt");
    await writeFile(file, "x");
    const workspace = new Workspace({ root });

    try {
      const result = await workspace.run(
        `node -e "require('node:fs').unlinkSync(process.argv[1])" "${file}"`,
      );

      assert.match(result, /^exit 0/);
      await assert.rejects(() => stat(file), /ENOENT/);
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

test("glob / grep：扫描不跟随目录内的符号链接（避免绕圈）", async () => {
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

/**
 * 去掉第一行状态，只留正文。
 *
 * 状态行会把命令原样带出来（`ran: node -e "...second..."`），
 * 正文断言如果连状态行一起匹配，就会因为命令里的字样而假通过或假失败。
 */
function body(output) {
  return output.slice(output.indexOf("\n") + 1);
}

/**
 * 后台任务必须在收尾时停掉，而且要在 finally 里停。
 *
 * 进程活着就占着工作区目录，`withWorkspace` 的清理会抛 EBUSY ——
 * 那个 EBUSY 会把真正的断言失败盖掉，让人以为是「目录删不掉」而不是「行为不对」。
 */
async function stopJob(workspace, pid) {
  try {
    await workspace.killJob("job-1");
  } catch {
    // 可能已经自己退出，或清理未确认；收尾失败不该盖住测试真正想证明的事。
  }
  if (pid !== undefined) await waitGone(pid);
}

test("shell 后台执行：返回任务编号，立即返回不等待进程结束", async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    const started = Date.now();
    // 起服务这类命令永远不会退出：前台跑会等到超时，后台必须立刻返回。
    const result = await workspace.run("node -e \"setTimeout(()=>{},60000)\"", { background: true });
    const pid = Number(/pid (\d+)/.exec(result)?.[1]);
    try {
      assert.match(result, /started job-1 \(pid \d+\) in the background/);
      assert.ok(Date.now() - started < 5000, "后台调用不能等进程结束");
    } finally {
      await stopJob(workspace, pid);
    }
  });
});


test("shell 后台启动失败：返回可恢复工具错误，不伪报 started", async () => {
  await withWorkspace(async (dir) => {
    const missingRoot = path.join(dir, "missing-root");
    const workspace = new Workspace({ root: missingRoot });

    await assert.rejects(
      () => workspace.run('node -e "setTimeout(()=>{},1000)"', { background: true }),
      /could not start background command:.*ENOENT/i,
    );
    await assert.rejects(
      () => workspace.readJobOutput("job-1"),
      /unknown background job "job-1" \(known: none\)/,
      "启动失败的任务不能登记成 running",
    );
  });
});

test("shell 后台日志：同一进程的多个 Workspace 不覆盖彼此的输出", async () => {
  await withWorkspace(async (dir) => {
    const first = new Workspace({ root: dir });
    const second = new Workspace({ root: dir });
    try {
      await first.run('node -e "console.log(\'alpha\')"', { background: true });
      assert.equal(body(await first.readJobOutput("job-1", 5000)), "alpha\n");
      await second.run('node -e "console.log(\'another-workspace\')"', { background: true });
      assert.equal(body(await second.readJobOutput("job-1", 5000)), "another-workspace\n");
      assert.equal(body(await first.readJobOutput("job-1", 0)), "(no new output)");
    } finally {
      await stopJob(first);
      await stopJob(second);
    }
  });
});

test("shell-output：读到输出后，第二次只返回新增的部分", async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    // 第二行由测试写 go.txt 触发，不靠时间窗口：负载一高，几百毫秒的间隔根本不够，
    // 第一次读会把两行一起拿走，测试就假失败了。
    const script = [
      "console.log('first')",
      "const fs=require('fs')",
      "const t=setInterval(()=>{if(fs.existsSync('go.txt')){clearInterval(t);console.log('second')}},50)",
      "setTimeout(()=>{},30000)",
    ].join(";");
    await workspace.run(`node -e "${script}"`, { background: true });

    const first = await workspace.readJobOutput("job-1", 5000);
    const pid = Number(/pid (\d+)/.exec(first)?.[1]);
    try {
      assert.match(first, /^job-1 \(running, pid \d+\) ran: /, "第一行必须是状态");
      assert.match(body(first), /first/);
      assert.doesNotMatch(body(first), /second/, "还没产生的内容不能提前出现");

      await workspace.write("go.txt", "");
      const second = await workspace.readJobOutput("job-1", 5000);
      assert.match(body(second), /second/);
      assert.doesNotMatch(body(second), /first/, "已经读过的内容不能重复返回");
    } finally {
      await stopJob(workspace, pid);
    }
  });
});

test("shell-output：进程自己退出时报告 exit code，且没有新输出时明确说没有", async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    await workspace.run('node -e "console.log(\'bye\');process.exit(3)"', { background: true });

    const output = await workspace.readJobOutput("job-1", 5000);
    const pid = Number(/pid (\d+)/.exec(output)?.[1]);
    try {
      assert.match(output, /bye/);

      // 第二次没有新字节，等到进程退场再返回：状态行必须换成 exit code。
      const after = await workspace.readJobOutput("job-1", 5000);
      assert.match(after, /^job-1 \(exited with code 3, pid \d+\)/);
      assert.match(after, /\(no new output\)/);
    } finally {
      await stopJob(workspace, pid);
    }
  });
});

test("shell-kill：停掉后台任务，进程真的不在了", async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    await workspace.run('node -e "setInterval(()=>{},1000)"', { background: true });
    const pid = Number(/pid (\d+)/.exec(await workspace.readJobOutput("job-1", 3000))?.[1]);
    try {
      assert.ok(Number.isInteger(pid), "状态行里必须带 pid");

      assert.match(await workspace.killJob("job-1"), /stopped job-1/);

      assert.equal(await waitGone(pid), true, "kill 之后进程必须真的消失");
      assert.match(await workspace.killJob("job-1"), /job-1 is already stopped/);
    } finally {
      await stopJob(workspace, pid);
    }
  });
});


test("shell-kill：命令启动的后台后代仍属于同一任务，可通过任务接口停止", { skip: process.platform === "win32" }, async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    await workspace.run('node -e "setInterval(()=>{},1000)" & echo $! > child.pid; echo ready', { background: true });

    const output = await workspace.readJobOutput("job-1", 5000);
    const shellPid = Number(/pid (\d+)/.exec(output)?.[1]);
    const childPid = Number((await readFile(path.join(dir, "child.pid"), "utf8")).trim());
    try {
      assert.match(output, /ready/);
      assert.ok(Number.isInteger(childPid), "命令启动的后台子进程必须有 pid");
      assert.match(await workspace.killJob("job-1"), /stopped job-1/);
      assert.equal(await waitGone(childPid), true, "shell-kill 必须停止 shell 已启动的后台后代");
    } finally {
      await stopJob(workspace, shellPid);
    }
  });
});

test("shell-output：未知任务编号报错，并列出已知编号", async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    await assert.rejects(() => workspace.readJobOutput("job-9"), /unknown background job "job-9" \(known: none\)/);

    await workspace.run("node -e \"setTimeout(()=>{},5000)\"", { background: true });
    const pid = Number(/pid (\d+)/.exec(await workspace.readJobOutput("job-1", 0))?.[1]);
    try {
      await assert.rejects(() => workspace.readJobOutput("job-9"), /unknown background job "job-9" \(known: job-1\)/);
    } finally {
      await stopJob(workspace, pid);
    }
  });
});

test("shell-output：等待新输出期间取消，及时拒绝而不等完整预算", async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController();
    const workspace = new Workspace({ root, signal: controller.signal });
    const started = await workspace.run('node -e "setTimeout(()=>{},30000)"', { background: true });
    const pid = Number(/pid (\d+)/.exec(started)?.[1]);
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await assert.rejects(() => workspace.readJobOutput("job-1", 400), /cancelled by signal/);
    } finally {
      clearTimeout(timer);
      await stopJob(workspace, pid);
    }
  });
});

test("shell-output：日志丢失时明确报错，不能伪装没有新输出", async () => {
  await withWorkspace(async (root) => {
    const logRoot = path.join(tmpdir(), "agent-kernel-jobs");
    const before = new Set(await readdir(logRoot).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }));
    const workspace = new Workspace({ root });
    const started = await workspace.run('node -e "console.log(\'done\')"', { background: true });
    const pid = Number(/pid (\d+)/.exec(started)?.[1]);
    try {
      await workspace.readJobOutput("job-1", 5000);
      assert.equal(await waitGone(pid), true);
      const candidates = (await readdir(logRoot)).filter((name) =>
        name.startsWith(`${process.pid}-job-1-`) && !before.has(name));
      assert.equal(candidates.length, 1, "只删除本用例新产生的真实日志");
      await unlink(path.join(logRoot, candidates[0]));
      await assert.rejects(() => workspace.readJobOutput("job-1"), /ENOENT/);
    } finally {
      await stopJob(workspace, pid);
    }
  });
});

test("shell-output：单次最多 8000 字符，剩下的明确说还有并留给下一次", async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    await workspace.run('node -e "process.stdout.write(\'x\'.repeat(9000))"', { background: true });

    const first = await workspace.readJobOutput("job-1", 5000);
    const pid = Number(/pid (\d+)/.exec(first)?.[1]);
    try {
      assert.match(first, /1000 chars not shown; call shell-output again/);
      // 只数正文那一行：状态行里的命令本身也带 x，整段数会多数两个。
      assert.equal(first.split("\n")[1].length, 8000, "一次只能给 8000 个字符");

      const second = await workspace.readJobOutput("job-1", 5000);
      assert.match(second, /x{1000}/);
      assert.doesNotMatch(second, /not shown/, "读完就不该再提示还有");
    } finally {
      await stopJob(workspace, pid);
    }
  });
});


test("shell-output：截断边界不切开 emoji 代理对，后续读取不损坏 UTF-8", async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    const expectedFirst = `${"x".repeat(7_999)}😀`;
    const outputText = `${expectedFirst}Z`;
    await workspace.write("payload.txt", outputText);
    // 从文件读取，避免把 8k 测试载荷塞进 Windows 命令行长度限制。
    await workspace.run(`node -e "process.stdout.write(require('fs').readFileSync('payload.txt'))"`, { background: true });

    const first = await workspace.readJobOutput("job-1", 5000);
    const pid = Number(/pid (\d+)/.exec(first)?.[1]);
    try {
      assert.equal(body(first).split("\n")[0], expectedFirst, "第一次只能在完整 emoji 之后截断");
      assert.match(first, /1 chars not shown/);

      const second = await workspace.readJobOutput("job-1", 5000);
      assert.equal(body(second), "Z", "第二次从正确的 UTF-8 字节偏移继续");
      assert.doesNotMatch(second, /\uFFFD/);
    } finally {
      await stopJob(workspace, pid);
    }
  });
});

test("shell-output：被切断的多字节字符不会读成替换字符，补齐后才返回", async () => {
  await withWorkspace(async (dir) => {
    const workspace = new Workspace({ root: dir });
    // "中" = e4 b8 ad：先只写前两个字节，等测试写 go.txt 才补上第三个。
    const script = [
      "process.stdout.write(Buffer.from([0xe4,0xb8]))",
      "const fs=require('fs')",
      "const t=setInterval(()=>{if(fs.existsSync('go.txt')){clearInterval(t);process.stdout.write(Buffer.from([0xad]))}},50)",
      "setTimeout(()=>{},30000)",
    ].join(";");
    await workspace.run(`node -e "${script}"`, { background: true });

    const first = await workspace.readJobOutput("job-1", 1500);
    const pid = Number(/pid (\d+)/.exec(first)?.[1]);
    try {
      assert.doesNotMatch(first, /\uFFFD/, "半个字符不能变成替换字符");
      assert.doesNotMatch(first, /中/, "只有两个字节时还不能算读到这个字");

      await workspace.write("go.txt", "");
      const second = await workspace.readJobOutput("job-1", 5000);
      assert.match(second, /中/, "补齐之后才能读出完整字符");
      assert.doesNotMatch(second, /\uFFFD/);
    } finally {
      await stopJob(workspace, pid);
    }
  });
});

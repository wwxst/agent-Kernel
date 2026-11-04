/**
 * Workspace 的单元测试：路径边界和输出上限是这个模块唯一的两个卖点，
 * 所以它们必须在接口上被验证 —— 不碰私有的 resolve/truncate。
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Workspace } from "../src/workspace.ts";
import { withWorkspace } from "./support/harness.mjs";

test("write 后 read 能拿回原文，父目录自动创建", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });

    assert.equal(await workspace.write("nested/dir/hello.txt", "hello\n"), "wrote 6 chars to nested/dir/hello.txt");
    assert.equal(await workspace.read("nested/dir/hello.txt"), "hello\n");
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
    await assert.rejects(() => workspace.read("..\\..\\escaped.txt"), /path escapes workspace/);
    await assert.rejects(() => workspace.read(outside), /path escapes workspace/);
    await assert.rejects(() => workspace.list(".."), /path escapes workspace/);
    await assert.rejects(() => workspace.write("../escape.txt", "nope"), /path escapes workspace/);
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

    assert.match(output, /\[truncated \d+ chars\]$/);
  });
});

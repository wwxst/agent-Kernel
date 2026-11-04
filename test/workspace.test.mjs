/**
 * Workspace 的单元测试：路径边界和输出上限是这个模块唯一的两个卖点，
 * 所以它们必须在接口上被验证 —— 不碰私有的 resolve/truncate。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

    assert.match(output, /\[truncated \d+ chars\]$/);
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

test("grep：非法正则直接报错（由 ToolRegistry 折成 ERROR 文本）", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("a.txt", "hello\n");

    await assert.rejects(() => workspace.grep("(["), /Invalid regular expression/);
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

    assert.match(text, /\[truncated 24768 chars\]/);
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

test("edit：重叠的命中也算多处，不能被当成唯一", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root });
    await workspace.write("f.txt", "aaa\n");

    await assert.rejects(() => workspace.edit("f.txt", "aa", "b"), /appears 2 times/);
  });
});

test("run：超时是独立的执行结果，不是普通的退出码", async () => {
  await withWorkspace(async (root) => {
    const workspace = new Workspace({ root, timeoutMs: 300 });

    const result = await workspace.run('node -e "setTimeout(() => {}, 5000)"');

    assert.match(result, /^timeout after 300ms/);
  });
});

/**
 * 文件目的：验证 Worktree 管理工具不会覆盖分支、误删用户文件或把多个工作区嵌套在一起。
 *
 * 文件职责：在临时 Git 仓库中真实执行 create / list / remove，检查分支、路径和安全边界。
 * 不依赖 agent 模型、不联网；测试需要本机 Git 可执行。
 *
 * 内容目录：
 *   - 创建和列表：新分支、新目录、从 linked worktree 调用仍定位到主仓库。
 *   - 删除保护：当前工作区、主工作区、脏工作区都不能删除。
 *   - 分支保护：已存在的分支和非法分支名不能被覆盖或创建。
 *   - 删除语义：删除工作区后保留 Git 分支。
 *
 * 模块关系：测试 bin/worktree.mjs；由 npm test 启动。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const worktreeTool = fileURLToPath(new URL("../bin/worktree.mjs", import.meta.url));

async function runGit(cwd, args) {
  return exec("git", args, { cwd, encoding: "utf8" });
}

async function runTool(cwd, args) {
  return exec(process.execPath, [worktreeTool, ...args], { cwd, encoding: "utf8" });
}

async function withRepository(run) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-worktree-test-"));
  try {
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.name", "Agent Kernel Test"]);
    await runGit(root, ["config", "user.email", "agent-kernel-test@example.com"]);
    await writeFile(path.join(root, "README.md"), "# temporary repository\n");
    await runGit(root, ["add", "README.md"]);
    await runGit(root, ["commit", "-m", "initial commit"]);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createdPath(stdout) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("路径："));
  assert.ok(line, "create 输出里应该有工作区路径");
  return line.slice("路径：".length);
}

async function expectToolFailure(cwd, args, pattern) {
  await assert.rejects(
    () => runTool(cwd, args),
    (error) => pattern.test(error.stderr ?? error.message ?? ""),
  );
}

test("Worktree：创建、从子工作区列出、删除目录但保留分支", async () => {
  await withRepository(async (root) => {
    const created = await runTool(root, ["create", "feature/isolated", "main"]);
    const worktreePath = createdPath(created.stdout);

    await access(worktreePath);
    assert.equal((await runGit(worktreePath, ["branch", "--show-current"])).stdout.trim(), "feature/isolated");

    const listed = await runTool(worktreePath, ["list"]);
    assert.match(listed.stdout, /feature\/isolated/);
    assert.ok(listed.stdout.includes("路径："), "list 应该显示工作区路径");


    const removed = await runTool(root, ["remove", "feature/isolated"]);
    assert.match(removed.stdout, /分支保留：feature\/isolated/);
    await assert.rejects(() => access(worktreePath));

    const branches = (await runGit(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout;
    assert.match(branches, /feature\/isolated/);
  });
});

test("Worktree：从 linked worktree 创建时，默认 HEAD 使用调用者自己的提交", async () => {
  await withRepository(async (root) => {
    const parent = createdPath((await runTool(root, ["create", "feature/parent", "main"])).stdout);
    await writeFile(path.join(parent, "child-only.txt"), "commit from child worktree\\n");
    await runGit(parent, ["add", "child-only.txt"]);
    await runGit(parent, ["commit", "-m", "commit only in child worktree"]);
    const parentHead = (await runGit(parent, ["rev-parse", "HEAD"])).stdout.trim();

    // 不传 base，默认 HEAD 必须指向当前调用者所在 Worktree 的提交，而不是主工作区的 HEAD。
    const child = createdPath((await runTool(parent, ["create", "feature/from-child-head"])).stdout);
    const childHead = (await runGit(child, ["rev-parse", "HEAD"])).stdout.trim();
    assert.equal(childHead, parentHead);
    await access(path.join(child, "child-only.txt"));

    await runTool(root, ["remove", "feature/from-child-head"]);
    await runTool(root, ["remove", "feature/parent"]);
  });
});

test("Worktree：兼容 separate-git-dir 仓库", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "agent-separate-git-dir-"));
  try {
    const project = path.join(sandbox, "project");
    const metadata = path.join(sandbox, "metadata");
    await mkdir(project);
    await exec("git", ["init", "-b", "main", "--separate-git-dir", metadata, project], {
      cwd: sandbox,
      encoding: "utf8",
    });
    await runGit(project, ["config", "user.name", "Agent Kernel Test"]);
    await runGit(project, ["config", "user.email", "agent-kernel-test@example.com"]);
    await writeFile(path.join(project, "README.md"), "# separate git dir\\n");
    await runGit(project, ["add", "README.md"]);
    await runGit(project, ["commit", "-m", "initial commit"]);

    const listed = await runTool(project, ["list"]);
    assert.match(listed.stdout, /main/);

    const created = createdPath((await runTool(project, ["create", "feature/separate-git-dir"])).stdout);
    await access(created);
    await runTool(project, ["remove", "feature/separate-git-dir"]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Worktree：不能删除主工作区或当前正在使用的 linked worktree", async () => {
  await withRepository(async (root) => {
    await expectToolFailure(root, ["remove", "main"], /主工作区/);

    const created = await runTool(root, ["create", "feature/current", "main"]);
    const worktreePath = createdPath(created.stdout);
    await expectToolFailure(worktreePath, ["remove", "feature/current"], /当前正在使用的工作区/);
    await access(worktreePath);

    await runTool(root, ["remove", "feature/current"]);
  });
});

test("Worktree：脏工作区拒绝删除，清理后可以删除", async () => {
  await withRepository(async (root) => {
    const created = await runTool(root, ["create", "feature/dirty", "main"]);
    const worktreePath = createdPath(created.stdout);
    const untracked = path.join(worktreePath, "unfinished.txt");
    await writeFile(untracked, "do not delete me\n");

    await expectToolFailure(root, ["remove", "feature/dirty"], /未提交、未跟踪或被忽略的文件/);
    await access(untracked);
    await rm(untracked);

    await runTool(root, ["remove", "feature/dirty"]);
    await assert.rejects(() => access(worktreePath));
  });
});

test("Worktree：assume-unchanged 和 skip-worktree 文件不能被误删", async () => {
  await withRepository(async (root) => {
    const worktreePath = createdPath((await runTool(root, ["create", "feature/hidden-index-flags", "main"])).stdout);
    const tracked = path.join(worktreePath, "README.md");

    await runGit(worktreePath, ["update-index", "--assume-unchanged", "README.md"]);
    await writeFile(tracked, "# locally modified but hidden\\n");
    await expectToolFailure(root, ["remove", "feature/hidden-index-flags"], /特殊标记，拒绝删除/);
    await runGit(worktreePath, ["update-index", "--no-assume-unchanged", "README.md"]);
    await runGit(worktreePath, ["checkout", "--", "README.md"]);

    await runGit(worktreePath, ["update-index", "--skip-worktree", "README.md"]);
    await writeFile(tracked, "# locally modified and skip-worktree\\n");
    await expectToolFailure(root, ["remove", "feature/hidden-index-flags"], /特殊标记，拒绝删除/);
    await runGit(worktreePath, ["update-index", "--no-skip-worktree", "README.md"]);
    await runGit(worktreePath, ["checkout", "--", "README.md"]);

    await runTool(root, ["remove", "feature/hidden-index-flags"]);
  });
});

test("Worktree：不覆盖已有分支，也拒绝非法分支名", async () => {
  await withRepository(async (root) => {
    const created = await runTool(root, ["create", "feature/existing", "main"]);
    const worktreePath = createdPath(created.stdout);

    await expectToolFailure(root, ["create", "feature/existing", "main"], /本地分支已存在/);
    await expectToolFailure(root, ["create", "bad..branch", "main"], /分支名不合法/);

    await access(worktreePath);
    await runTool(root, ["remove", "feature/existing"]);
  });
});

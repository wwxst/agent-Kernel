#!/usr/bin/env node
/**
 * 文件目的：管理 agent-Kernel 的独立 Git Worktree，避免多个 Agent / 开发会话共用写入目录。
 *
 * 文件职责：
 *   - create：从指定 commit 创建新分支和独立工作区，不覆盖已有分支或目录。
 *   - list：查看当前仓库的全部 Worktree。
 *   - remove：只删除干净的 Worktree 目录，不删除分支，不使用 --force。
 *
 * 安全边界：
 *   - 所有新工作区放在当前调用者 Worktree 根目录的 .worktrees/ 下。
 *   - 以 Git common-dir 定位主仓库，所以从任一 linked worktree 调用也会放到同一个位置。
 *   - 有未提交、未跟踪或被忽略的文件时拒绝删除，避免丢失 .env / node_modules 等本地数据。
 *   - 不执行 branch -D、reset、clean、stash、rebase 或自动合并。
 *
 * 模块关系：只依赖 Node.js 内置模块和 Git CLI；由 package.json 的 worktree script 启动。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function usage() {
  process.stdout.write([
    "Worktree 管理工具",
    "",
    "用法：",
    "  npm run worktree -- create <branch> [base]",
    "  npm run worktree -- list",
    "  npm run worktree -- remove <branch>",
    "",
    "说明：",
    "  create 会创建新分支；已存在的本地分支不会被覆盖。",
    "  remove 只删除干净的工作区目录，不会删除对应分支。",
    "",
  ].join("\n"));
}

async function git(args, cwd) {
  try {
    return await run("git", args, { cwd, encoding: "utf8" });
  } catch (error) {
    const detail = error.stderr?.trim() || error.message || String(error);
    throw new Error(detail, { cause: error });
  }
}

function parseWorktrees(output) {
  const entries = [];
  let current;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line === "bare") {
      current.bare = true;
    } else if (current && line.startsWith("prunable ")) {
      current.prunable = line.slice("prunable ".length);
    }
  }

  if (current) entries.push(current);
  return entries;
}

async function listWorktrees(root) {
  const result = await git(["worktree", "list", "--porcelain"], root);
  return parseWorktrees(result.stdout);
}

function displayBranch(entry) {
  if (entry.branch?.startsWith("refs/heads/")) return entry.branch.slice("refs/heads/".length);
  return entry.detached ? "(detached HEAD)" : "(unknown)";
}

async function createWorktree(root, branch, baseRef = "HEAD") {
  if (!branch) throw new Error("create 缺少分支名");
  if (branch.startsWith("-")) throw new Error("分支名不能以 - 开头");

  try {
    await git(["check-ref-format", "--branch", branch], root);
  } catch {
    throw new Error(`分支名不合法：${branch}`);
  }

  const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root))
    .stdout.split(/\r?\n/).filter(Boolean);
  if (branches.includes(branch)) {
    throw new Error(`本地分支已存在，不会覆盖：${branch}`);
  }

  let baseCommit;
  try {
    baseCommit = (await git([
      "rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`,
    ], root)).stdout.trim();
  } catch {
    throw new Error(`基准引用不存在或不是 commit：${baseRef}`);
  }

  const safeSlug = (branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree").slice(0, 60);
  const suffix = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  const worktreesDir = path.join(root, ".worktrees");
  const target = path.join(worktreesDir, `${safeSlug}-${suffix}`);

  await mkdir(worktreesDir, { recursive: true });
  try {
    await lstat(target);
    throw new Error(`目标目录已存在，不会覆盖：${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await git(["worktree", "add", "-b", branch, target, baseCommit], root);
  process.stdout.write([
    "Worktree 已创建",
    `分支：${branch}`,
    `路径：${target}`,
    `基于：${baseCommit.slice(0, 12)}`,
    "",
  ].join("\n"));
}

async function showWorktrees(root) {
  const entries = await listWorktrees(root);
  if (entries.length === 0) {
    process.stdout.write("当前没有 Worktree。\n");
    return;
  }

  for (const [index, entry] of entries.entries()) {
    process.stdout.write([
      `[${index + 1}] ${displayBranch(entry)}`,
      `路径：${entry.path}`,
      `提交：${entry.head?.slice(0, 12) ?? "unknown"}`,
      entry.prunable ? `状态：可清理（${entry.prunable}）` : "",
      "",
    ].filter(Boolean).join("\n") + "\n");
  }
}

async function removeWorktree(root, branch) {
  if (!branch) throw new Error("remove 缺少分支名");

  const entries = await listWorktrees(root);
  const entry = entries.find((item) => item.branch === `refs/heads/${branch}`);
  if (!entry) throw new Error(`没有找到分支 ${branch} 对应的 Worktree`);

  const target = path.resolve(entry.path);
  if (target === path.resolve(root)) {
    throw new Error("这是主工作区，不能通过 Worktree 工具删除");
  }
  const currentTopLevel = path.resolve((await git(["rev-parse", "--show-toplevel"], process.cwd())).stdout.trim());
  if (target === currentTopLevel) {
    throw new Error("不能删除当前正在使用的工作区，请从另一个 Worktree 执行");
  }

  // assume-unchanged / skip-worktree 会让普通 git status 隐藏 tracked file 的本地修改。
  // 为避免误删这类文件，遇到任何非普通 H 索引标记时保守拒绝删除。
  const indexEntries = (await git(["ls-files", "-v", "-z"], target)).stdout.split("\\0").filter(Boolean);
  const specialIndexEntries = indexEntries.filter((entry) => entry[0] !== "H");
  if (specialIndexEntries.length > 0) {
    throw new Error(`索引中存在 assume-unchanged、skip-worktree 或其他特殊标记，拒绝删除：${target}`);
  }

  // --ignored 也检查 .env、node_modules 等被忽略的本地文件，防止删除时一起丢失。
  const status = await git(["status", "--porcelain", "--ignored", "--untracked-files=all"], target);
  if (status.stdout.trim() !== "") {
    throw new Error(`工作区还有未提交、未跟踪或被忽略的文件，拒绝删除：${target}`);
  }

  // 不传 --force；即使前面的状态检查遗漏了 Git 认定的脏数据，Git 也会再次拒绝。
  await git(["worktree", "remove", target], root);
  process.stdout.write([
    "Worktree 已删除",
    `分支保留：${branch}`,
    `原路径：${target}`,
    "",
  ].join("\n"));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    usage();
    return;
  }

  // 直接使用调用者所在 Worktree 的根目录，不从 common-dir 推算路径。
  // 这样既能正确处理 linked worktree，也兼容 --separate-git-dir。
  const root = (await git(["rev-parse", "--show-toplevel"], process.cwd())).stdout.trim();

  if (command === "create") {
    if (args.length < 1 || args.length > 2) throw new Error("用法：create <branch> [base]");
    await createWorktree(root, args[0], args[1] ?? "HEAD");
    return;
  }
  if (command === "list") {
    if (args.length !== 0) throw new Error("用法：list");
    await showWorktrees(root);
    return;
  }
  if (command === "remove") {
    if (args.length !== 1) throw new Error("用法：remove <branch>");
    await removeWorktree(root, args[0]);
    return;
  }

  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`Worktree 操作失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

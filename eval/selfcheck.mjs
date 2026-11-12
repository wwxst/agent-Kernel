#!/usr/bin/env node
/**
 * 文件目的：评测集自检 —— 不调用模型，只验证「每个任务在动手之前，检查器一定会失败」。
 *
 * 为什么需要：一个任务如果在 agent 动手前就已经通过，它什么都没测 ——
 * 这比没有任务更糟，因为会让分数虚高。不需要密钥，随时能跑。
 *
 * 三种结果必须分开，否则会把「检查器坏了」当成「任务没问题」：
 *   - 正常：检查器报「断言没过」，说明初始状态确实不达标，符合预期。
 *   - 题目有问题：初始状态直接通过（这题白出），或者检查脚本没按约定导出。
 *   - 工具坏了：检查脚本加载不起来、依赖缺失、脚本自己写错。
 * 前两种要改题目，第三种要修工具 —— 混在一起就分不清该找谁。
 *
 * 文件职责：负责逐个任务跑初始断言、给结果分类、打印汇总。
 * 不负责跑真实模型、不负责判分（那是 `run.mjs`）。
 *
 * 内容目录：
 *   - `SELFCHECK_OK` / `SELFCHECK_BROKEN` / `SELFCHECK_INFRA`：三种结果。
 *   - `isExpectedFailure()`：只有断言失败才算「预期的初始失败」，`run.mjs` 也用它。
 *   - `checkTask()`：单个任务 —— 复制夹具、加载 `check.mjs`、跑一次，顺序不能反。
 *   - `runSelfcheck()`：按目录名顺序跑完整个任务集。
 *   - 文件末尾：直接执行时打印逐条结果与汇总，有问题就设非零退出码。
 *
 * 模块关系：只依赖 Node 内置模块，不引用 `src/`。
 * 被 `run.mjs`（判分时区分失败类型）与 `test/selfcheck.test.mjs` 使用。
 */
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SELFCHECK_OK = "ok";
export const SELFCHECK_BROKEN = "broken";
export const SELFCHECK_INFRA = "infra";

/** 只有断言失败才是「预期的初始失败」；其他一切错误都属于评测基础设施。 */
export function isExpectedFailure(error) {
  return error?.code === "ERR_ASSERTION" || error?.name === "AssertionError";
}

/**
 * 跑完一个任务的自检，返回 `{ name, status, detail }`。
 *
 * 顺序有讲究：先确认检查器本身能加载、能跑，再谈「初始状态该失败」。
 * 反过来的话，一个 import 写错的任务会被当成「初始状态确实失败了」。
 */
async function checkTask(tasksDir, name) {
  const taskDir = path.join(tasksDir, name);
  const workdir = await mkdtemp(path.join(tmpdir(), `agent-selfcheck-${name}-`));

  try {
    try {
      await cp(path.join(taskDir, "files"), workdir, { recursive: true });
    } catch (error) {
      return { name, status: SELFCHECK_INFRA, detail: `复制初始夹具失败：${message(error)}` };
    }

    let check;
    try {
      check = (await import(pathToFileURL(path.join(taskDir, "check.mjs")).href)).default;
    } catch (error) {
      return { name, status: SELFCHECK_INFRA, detail: `check.mjs 加载失败：${message(error)}` };
    }

    if (typeof check !== "function") {
      return { name, status: SELFCHECK_BROKEN, detail: "check.mjs 没有默认导出函数" };
    }

    try {
      await check(workdir);
    } catch (error) {
      if (isExpectedFailure(error)) return { name, status: SELFCHECK_OK };
      return {
        name,
        status: SELFCHECK_INFRA,
        detail: `检查器抛出了非断言错误：${error?.name ?? "Error"}: ${message(error)}`,
      };
    }

    return { name, status: SELFCHECK_BROKEN, detail: "初始状态就已经通过，这个任务什么都没测" };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** 对 `tasksDir` 下的每个任务按目录名顺序自检。 */
export async function runSelfcheck(tasksDir) {
  const names = (await readdir(tasksDir)).sort();
  const results = [];
  for (const name of names) {
    results.push(await checkTask(tasksDir, name));
  }
  return results;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const results = await runSelfcheck(path.join(here, "tasks"));

  for (const result of results) {
    const label =
      result.status === SELFCHECK_OK ? "ok     " : result.status === SELFCHECK_BROKEN ? "BROKEN" : "INFRA ";
    console.log(`  ${label}  ${result.name}${result.detail === undefined ? "" : `：${result.detail}`}`);
  }

  const ok = results.filter((result) => result.status === SELFCHECK_OK).length;
  const broken = results.filter((result) => result.status === SELFCHECK_BROKEN).length;
  const infra = results.filter((result) => result.status === SELFCHECK_INFRA).length;

  if (broken === 0 && infra === 0) {
    console.log(`\n全部 ${results.length} 个任务自检通过`);
  } else {
    console.log(`\n${ok}/${results.length} 个任务自检通过 · ${broken} 个任务无效 · ${infra} 个基础设施错误`);
  }

  if (broken > 0 || infra > 0) process.exitCode = 1;
}

function message(error) {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

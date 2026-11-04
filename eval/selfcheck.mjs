#!/usr/bin/env node
/**
 * 评测集自检：不调用模型，只验证「每个任务的初始夹具都会让 check 失败」。
 *
 * 为什么需要：一个任务如果在 agent 动手之前就已经通过，它什么都没测 ——
 * 这种任务比没有任务更糟，因为它会让评测分数虚高。也不需要 API Key，随时能跑。
 *
 * 三种结果必须分开，否则自检会把「检查器坏了」当成「任务没问题」：
 *
 *   ok     —— 预期内的任务失败：check 抛 AssertionError，说明初始状态确实不达标。
 *   broken —— 评测设计错误：初始状态直接通过（这个任务什么都没测），或者 check.mjs
 *             没有默认导出函数。
 *   infra  —— 评测基础设施错误：check.mjs 加载失败，或检查器抛出非断言错误
 *             （导入失败、依赖缺失、TypeError、检查器自己写错）。它不是任务失败，
 *             不能算自检通过 —— 这类错误恰恰是以前被吞掉的那一类。
 *
 * 对应关系：ok 是「任务失败」的预期；broken 是「任务本身有问题」；infra 是「评测环境有问题」。
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

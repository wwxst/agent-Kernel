/**
 * 评测集自检：不调用模型，只验证「每个任务的初始夹具都会让 check 失败」。
 *
 * 为什么需要：一个任务如果在 agent 动手之前就已经通过，它什么都没测——
 * 这种任务比没有任务更糟，因为它会让评测分数虚高。也不需要 API Key，随时能跑。
 */
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = path.join(here, "tasks");

const names = (await readdir(tasksDir)).sort();
let broken = 0;

for (const name of names) {
  const taskDir = path.join(tasksDir, name);
  const workdir = await mkdtemp(path.join(tmpdir(), `agent-selfcheck-${name}-`));
  await cp(path.join(taskDir, "files"), workdir, { recursive: true });

  let check;
  try {
    check = (await import(pathToFileURL(path.join(taskDir, "check.mjs")).href)).default;
  } catch (error) {
    console.log(`  BROKEN  ${name}: check.mjs 加载失败 —— ${message(error)}`);
    broken += 1;
    await rm(workdir, { recursive: true, force: true });
    continue;
  }

  if (typeof check !== "function") {
    console.log(`  BROKEN  ${name}: check.mjs 没有默认导出函数`);
    broken += 1;
    await rm(workdir, { recursive: true, force: true });
    continue;
  }

  try {
    await check(workdir);
    console.log(`  BROKEN  ${name}: 初始状态就已经通过，这个任务什么都没测`);
    broken += 1;
  } catch {
    console.log(`  ok      ${name}`);
  }

  await rm(workdir, { recursive: true, force: true });
}

console.log(`\n${names.length - broken}/${names.length} 个任务自检通过`);
if (broken > 0) process.exitCode = 1;

function message(error) {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

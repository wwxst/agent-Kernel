import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);

export default async function check(root) {
  const configFile = path.join(root, "config.json");
  await writeFile(configFile, '{"name":"demo"}', "utf8");

  const { readConfig } = await import(pathToFileURL(path.join(root, "config.mjs")).href);

  // 新签名只收一个参数。先确认签名，再调用——用旧签名调用会异步炸掉整个进程。
  assert.equal(readConfig.length, 1, "readConfig 应该只收 file 一个参数");

  const pending = readConfig(configFile);
  assert.equal(typeof pending?.then, "function", "readConfig 应该返回 Promise");
  assert.equal((await pending).name, "demo", "读出来的内容不对");

  // app.mjs 也要改成 await 版本：有配置时正常输出，没配置时退出码 1。
  const ok = await run(process.execPath, ["app.mjs"], { cwd: root });
  assert.match(ok.stdout, /demo/, "app 应该打印配置里的 name");

  await rm(configFile);
  await assert.rejects(
    () => run(process.execPath, ["app.mjs"], { cwd: root }),
    (error) => error.code === 1,
    "缺少 config.json 时 app 应该以退出码 1 结束",
  );
}

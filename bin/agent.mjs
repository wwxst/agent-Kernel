#!/usr/bin/env node
/**
 * 全局命令入口（`npm link` 之后可用的 `agent-kernel`）。
 *
 * 为什么不直接把 bin 指向 src/cli.ts：npm run 那条路靠 `--env-file-if-exists=.env`
 * 加载配置，而这个开关是相对「当前目录」解析的。全局命令恰恰是在别的目录里执行的，
 * 于是 .env 会找不到，表现为「没配 API Key」。所以这里先用包内绝对路径把 .env 读进
 * process.env，再进入真正的 CLI —— 工作目录仍然是用户当前所在的那个目录。
 *
 * 已知边界：不解析当前目录下的 .env。工作区的配置属于这个仓库，不属于被打开的目录。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(packageRoot, ".env");

// process.loadEnvFile 不覆盖已存在的环境变量：命令行上显式给的 API_KEY / MODEL 仍然优先。
if (existsSync(envFile)) process.loadEnvFile(envFile);

await import("../src/cli.ts");

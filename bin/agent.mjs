#!/usr/bin/env node
/**
 * 文件目的：全局命令的入口（`npm link` 之后，在任意目录敲 `agent` / `agent-kernel` 走的就是这里）。
 *
 * 为什么不直接指向主程序：正常启动靠「读当前目录下的配置文件」，
 * 而全局命令恰恰是在别的目录里执行的，于是找不到配置，表现为「没配密钥」。
 * 所以这里先用包内的绝对路径把配置读进来，再进主程序 —— 工作目录仍然是用户所在的那个。
 *
 * 文件职责：找到本包的 `.env`、加载它、把控制权交给 `src/cli.ts`。
 * 不负责解析参数、不负责改工作目录、不负责任何业务逻辑。
 *
 * 内容目录：
 *   - `packageRoot` / `envFile`：由本文件位置推出包根目录与配置路径。
 *   - 两行主体：存在就 `process.loadEnvFile()`，然后 `await import("../src/cli.ts")`。
 *
 * 模块关系：只依赖 `node:fs` / `node:path` / `node:url`。
 * 被 `package.json` 的 `bin` 字段登记；`cli.ts` 是它唯一的下游。
 *
 * 已知边界：不读当前目录下的配置。配置属于这个仓库，不属于被打开的那个目录。
 * 命令行上显式给的 `API_KEY` / `MODEL` 优先 —— `loadEnvFile` 不覆盖已存在的环境变量。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(packageRoot, ".env");

// process.loadEnvFile 不覆盖已存在的环境变量：命令行上显式给的 API_KEY / MODEL 仍然优先。
if (existsSync(envFile)) process.loadEnvFile(envFile);

await import("../src/cli.ts");

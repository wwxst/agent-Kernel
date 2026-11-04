import { readFileSync } from "node:fs";

/** 读一个配置文件。 */
export function load(file) {
  return readFileSync(file, "utf8");
}

import { readFile } from "node:fs";

export function readConfig(file, callback) {
  readFile(file, "utf8", (error, text) => {
    if (error) return callback(error);
    callback(null, JSON.parse(text));
  });
}

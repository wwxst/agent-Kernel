import { readConfig } from "./config.mjs";

readConfig("config.json", (error, config) => {
  if (error) {
    console.error("failed to read config");
    process.exitCode = 1;
    return;
  }
  console.log(config.name);
});

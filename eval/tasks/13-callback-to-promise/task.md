`readConfig(file, callback)` 还是回调风格。

把它改成返回 Promise（参数只剩 `file`），并让 `app.mjs` 用 `await` 调用。行为不变：文件不存在时报错，进程退出码 1。

`handle(body)` 现在遇到坏 JSON 会直接抛异常。

改成：`body` 不是合法 JSON 时返回 `{ status: 400, body: { error: "invalid json" } }`，合法时行为不变。

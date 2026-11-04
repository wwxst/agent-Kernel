`isEmail(text)` 的正则太严了：它会误判这些合法地址：

- `first.last@example.com`（用户名里带点）
- `user+tag@my-site.io`（用户名里带 `+tag`、域名里带连字符）

修好它，同时不能开始接受这些：没有 `@` 的、带空格的、`@` 前面为空的。

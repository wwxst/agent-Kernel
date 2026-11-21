修复 src/format.mjs 中的用户信息格式化逻辑，并补齐测试。

要求：
1. 用户姓名和邮箱前后空格都要去掉。
2. 正常结果格式为 Name <email@example.com>。
3. name 或 email 缺失、不是字符串或去掉空格后为空时，抛出 Error，错误信息必须是 name and email are required。
4. 邮箱不包含 @ 时，抛出 Error，错误信息必须是 email must contain @。
5. 保留 test/format.test.mjs 里原有的格式化测试，并新增空格处理、缺失字段和无效邮箱测试。
6. 用 node --test test/format.test.mjs 运行测试，确保通过。

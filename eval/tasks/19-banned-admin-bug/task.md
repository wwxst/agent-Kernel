`canEdit(user, doc)` 有两件事要做：

1. 现在被 ban 的管理员也能编辑——这是 bug，**被 ban 的用户不管什么角色都不能编辑**；
2. 把嵌套的 `if` 改成提前返回（guard clause），行为除了第 1 点之外保持不变。

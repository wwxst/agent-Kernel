`validateName` 和 `validateTitle` 里有三段一模一样的校验。抽成一个共享函数，两个导出保持可用、报错文案格式不变（name 的错误里仍要出现 `name`，title 的仍要出现 `title`）。

共享函数中每种校验规则只保留一份，不要把原来的两套校验搬进同一个函数后再按 name/title 分支执行。

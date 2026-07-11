# Current Skill Catalog

状态：Current

实时 catalog 以 repository [`skills`](/skills)、用户 `~/.agents/skills`、[`config/permission_policy.yaml`](/config/permission_policy.yaml) 和 `config/connector-states.local.json` 为事实源。Dashboard `/api/skills` 与 Runtime system prompt 调用同一个 `SkillCatalog`，不会维护两份静态列表。

业务 script tool 的名称、schema、owner skill 与 timeout 以 [`py_tools/catalog.json`](/py_tools/catalog.json) 为唯一事实源；TS/Python 启动验证命名和 handler 一一对应。

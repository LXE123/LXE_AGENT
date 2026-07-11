# Skills

状态：Current

[`SkillCatalog`](/packages/runtime/src/skills.ts) 同时服务 Runtime 与 Dashboard，扫描 repository `skills/**/SKILL.md` 和 `~/.agents/skills`，按 size/mtime signature 自动刷新。Repository skill 在同名时优先；其它重复 name/command、越界 reference 或缺失文件会明确报错。

Runtime prompt 只列出 bot policy 与 connector state 允许的 skills。模型读取某个 manifest 后，本 turn 激活该 skill 并暴露其 owner script tools；activation、owner module、失败与耗时进入 usage tables。

Active business skills 的 frontmatter 使用 `script_tools`，不得指导模型通过 coding exec 启动 `services.agent_cli`。

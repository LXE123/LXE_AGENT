# Runtime Workspace Instance 领域（2026-07-18）

状态：Accepted

Runtime 新增 `src/workspace` 及镜像的 `test/workspace` 领域，用来统一管理会话工作区的进程内实例、不可变快照、文件监听和自动回收。

这部分不放进 `engine`，因为一个 Workspace Instance 会被多个 Session Turn 共用；也不放进 `tooling`，因为它同时管理 System Prompt 的 Skill、`SOUL.md`、`AGENTS.md` 视图和搜索服务。单独成域可以避免 Turn 编排或某个工具再次拥有一份工作区缓存。

该领域只保存进程内可丢弃状态，不新增数据库或磁盘解析缓存。Session 的 `WorkspaceContext` 仍由 Runtime SQLite 持久化，工作区文件仍是每次启动后的事实来源。

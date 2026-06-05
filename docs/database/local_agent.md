# Local Agent Database Layout

本地部署 agent 使用 SQLite 保存运行态。旧的 PostgreSQL agent shared-state 已删除，不再维护 PostgreSQL model、DDL 或读写实现。

## SQLite Local State

默认数据库文件：

```text
user_session_db/local_agent.sqlite3
```

可通过环境变量覆盖：

```text
LXE_SQLITE_DB_PATH
```

当前 SQLite 表：

- `card_owners`：平台卡片上下文、回调定位、发送结果句柄。
- `agent_sessions`：agent 会话元数据，包括 `source`、模型信息、创建/活跃时间、消息计数、工具/API/token 计数和标题。
- `agent_session_pending_events`：后台任务完成事件队列，每个 session 最多 10 条，append/pop 使用显式写事务。
- `ziniao_store_sessions`：紫鸟店铺浏览器 session 复用状态。

历史表 `agent_contexts` 已在 schema 初始化时删除。`agent_sessions` 不再包含 `status`、`state_data` 或 `pending_events` 列；消息内容存储在每个 session 的 JSONL message 文件中，pending events 存储在 `agent_session_pending_events` 表中。

## PostgreSQL

PostgreSQL 目前只保留 FBA pricing 数据：

- `pricing_channels`
- `pricing_rate_tiers`
- `pricing_constraints`
- `pricing_surcharge_rules`

不要把 FBA pricing 的 PostgreSQL 访问和 agent shared-state 混在一起清理。

## Runtime Notes

当前执行链路是单 gateway 进程内调度：

- `gateway/app.py` 初始化 `SessionScheduler`、`AgentQueue`、`SessionRouter`、`HeartbeatWakeManager` 和平台 adapter。
- `gateway/session_scheduler.py` 按 session 串行执行 agent job，并用全局并发限制控制同一时间运行的 job 数量。
- `gateway/heartbeat_wake.py` 在后台任务写入 pending event 后唤醒对应 session；如果 session 忙，会延后重试。
- `shared/db/client.py` 为 async 调用方提供线程池包装，SQLite 写入逻辑仍保持同步实现。

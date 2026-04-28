# Local Agent Database Layout

本地部署 agent 使用 SQLite 保存运行态。旧的 PostgreSQL agent shared-state 已删除，不再维护 `agent_sessions` / `agent_contexts` 的 PostgreSQL model、DDL 或读写实现。

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

- `card_owners`：平台卡片上下文和回调定位。
- `ziniao_store_sessions`：店铺浏览器 session 复用。
- `agent_contexts`：agent 持久上下文，核心是 `context_data.messages`。
- `agent_sessions`：agent 会话主状态，包含 `status`、`state_data`、`pending_events`。

`agent_sessions.state_data`、`agent_sessions.pending_events`、`agent_contexts.context_data` 使用 SQLite `TEXT` 存储 JSON。读写代码负责 JSON 序列化和反序列化，坏数据直接抛错。

## PostgreSQL

PostgreSQL 目前只保留 FBA pricing 数据：

- `pricing_channels`
- `pricing_rate_tiers`
- `pricing_constraints`
- `pricing_surcharge_rules`

不要把 FBA pricing 的 PostgreSQL 访问和 agent shared-state 混在一起清理。

## Runtime Notes

Gateway + supervised worker 架构仍然存在，执行链路仍是“调度中心 + 子进程 worker”：

- `gateway/app.py` 初始化 `SessionScheduler`、`AgentSupervisor`、`OutboundRouter`。
- `gateway/app.py` 启动 IPC server、worker、outbound router。
- `gateway/agent_supervisor.py` 负责拉起、探活、重启 worker。

会话调度仍然按多 session 设计：

- `gateway/session_scheduler.py` 维护 `pending_by_session`、`active_sessions`。
- `shared/config.py` 中仍有 worker lease/concurrency 配置。

后台子任务回流主会话的事件链仍然存在：

- 子进程结束后把事件写入 `agent_sessions.pending_events`。
- `gateway/heartbeat_wake.py` 通过 heartbeat wake 唤醒主会话。

SQLite 实现对 `pending_events` 的 append/pop 使用显式写事务，避免本地并发读改写丢事件。

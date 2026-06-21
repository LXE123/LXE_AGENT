# Gateway Lifecycle

状态：Current

## 目的

这篇文档解释 gateway 进程如何从一个 Python 入口变成可接收平台消息的运行体。读者如果想知道服务启动时创建了哪些组件、后台任务在哪里启动、停止信号会怎样传播，应该先读这一篇。

## 设计理念

生命周期层只做 bootstrap 和组件编排，不把平台消息解析、权限判断、agent 执行或出站发送写进入口。`main.py` 保持很薄，`GatewayApp` 集中管理 start/stop 顺序，让关闭、重启 adapter、Dashboard 和 shared-state 连接释放有一个清晰的归口。

## 链路位置

这一层覆盖 `main.py -> GatewayApp`。它把 `ChannelRegistry`、`SessionRouter`、`SessionScheduler`、`GatewayEmitter` 和 `HeartbeatWakeManager` 装配好，然后通过 dispatch loop 把 adapter 送入的 `InboundEvent` 交给下一篇文档描述的路由层。

本文维护当前 gateway 的启动、初始化、后台任务和关闭顺序。事实来源是 [main.py](../../../main.py)、[gateway/app.py](../../../gateway/app.py)、[gateway/config.py](../../../gateway/config.py) 和 [gateway/dashboard/settings.py](../../../gateway/dashboard/settings.py)。

## 启动入口

`main.py` 是 gateway 进程入口：

- 先调用 `bootstrap_network_policy(label="gateway")` 建立网络策略。
- 记录当前 agent planner 摘要。
- 通过 `GatewayApp.from_config()` 创建应用。
- 注册 `SIGINT` / `SIGTERM`。第一次信号触发 `app.request_shutdown()`，第二次信号直接 `os._exit(130)`。
- 执行 `app.start()`，随后 `app.wait_forever()` 阻塞到 stop event，最后在 `finally` 中调用 `app.stop()`。

`main()` 使用 `asyncio.run()` 启动 `_run_gateway()`，所以 gateway 的主生命周期运行在单个 asyncio event loop 内。

## GatewayApp 组装

`GatewayApp.__init__()` 组装 gateway 内部依赖：

- `ChannelRegistry`：保存平台 adapter。
- `AgentQueue`：接收 adapter 送入的 `InboundEvent`。
- `SessionScheduler`：执行 agent job，`AGENT_MAX_CONCURRENCY` 来自 [gateway/config.py](../../../gateway/config.py)。
- `GatewayEmitter`：把 agent emit 请求发送回平台。
- `HeartbeatWakeManager`：处理后台 pending event 的 wake 请求。
- `SessionRouter`：解析入站消息、权限、session 和控制命令。
- `DashboardServer`：当 `AGENT_DASHBOARD_ENABLED` 为 true 时启动。

`GatewayApp.from_config()` 当前注册的是 `FeishuStreamAdapter`。它会校验 Feishu runtime config，并要求 `lark-oapi` 依赖可用。

## start()

`GatewayApp.start()` 的当前顺序：

1. 获取当前 asyncio loop。
2. 调用 `init_schema()` 初始化 SQLite schema。
3. 启动 Dashboard server。
4. 记录 Feishu runtime 状态。
5. 注册 emit handler 和 heartbeat wake handler。
6. 创建 `_dispatch_loop()` task。
7. 为每个 adapter 设置 inbound sink：`adapter.set_inbound_sink(self.publish_from_adapter)`。
8. 启动所有 channel adapter。
9. 创建并启动 APScheduler。
10. 同步刷新一次 Mabang ERP cookie。
11. 读取 adapter health snapshot 并记录启动成功日志。
12. 如果 Dashboard 已启动且配置允许，打开浏览器。

如果 adapter 启动失败，`start()` 会取消 dispatch task、停止 session scheduler、停止 adapter、停止 dashboard，并 reset emit handlers。

## 后台定时任务

`_build_scheduler()` 当前注册这些 APScheduler job：

- `mabang_erp_cookie_refresh`：每 2 小时刷新 Mabang ERP cookie。
- `gateway_adapter_recycle`：当 `GATEWAY_ADAPTER_RECYCLE_ENABLED` 开启时，每 1 小时重启 adapter。
- `gateway_adapter_watchdog`：当 `GATEWAY_ADAPTER_WATCHDOG_ENABLED` 开启时，每 1 分钟检查 adapter thread 状态。
- `telemetry_snapshot_sync`：当 telemetry 开启时按配置同步 snapshot。

adapter recycle 会避开 gateway stopping 状态和 inflight agent jobs。watchdog 只在 adapter thread 不存活时尝试重启；如果 thread 仍在但连接断开，会信任 SDK 自动重连。

## 入站 dispatch loop

adapter 调用 `publish_from_adapter(event)` 后，gateway 使用 `loop.call_soon_threadsafe()` 把 `InboundEvent` 放进 `AgentQueue`。

`_dispatch_loop()` 从 queue 取事件，并调用 `SessionRouter.route_message(event)`。路由异常只记录日志，不会退出 dispatch loop。

## stop()

`GatewayApp.stop()` 当前关闭顺序：

1. 设置 stop event。
2. 停止 `HeartbeatWakeManager`。
3. 停止 `SessionScheduler`。
4. 取消 dispatch task。
5. 停止 channel adapters。
6. 停止 Dashboard server。
7. 停止 APScheduler。
8. 关闭网络客户端。
9. 释放 SQLite shared-state store。
10. reset emit handlers。

每个异步关闭步骤通过 `_await_stop_step()` 包装，有独立 timeout 和 warning 日志，避免单个组件卡住导致整个进程无法退出。

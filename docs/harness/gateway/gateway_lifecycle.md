# Gateway Lifecycle

状态：Current

## 目的

Gateway lifecycle 负责把配置、持久化、Runtime、Dashboard、scheduler 和 channel 组装成一个可启动、可停止、可诊断的 Bun 进程。它只管理组件生命周期，不承担消息解析、模型调用或业务工具实现。

## 事实来源

- [`apps/gateway/src/main.ts`](/apps/gateway/src/main.ts)：顶层入口、fatal handler 和日志 flush。
- [`apps/gateway/src/bootstrap/cli.ts`](/apps/gateway/src/bootstrap/cli.ts)：`start`、`stop`、配置与 status 文件入口。
- [`apps/gateway/src/orchestration/production.ts`](/apps/gateway/src/orchestration/production.ts)：provider、storage、tools、MCP、skills、Dashboard 和维护任务装配。
- [`apps/gateway/src/orchestration/composition.ts`](/apps/gateway/src/orchestration/composition.ts)：Gateway 与 Runtime 的进程内组合。
- [`apps/gateway/src/orchestration/lifecycle.ts`](/apps/gateway/src/orchestration/lifecycle.ts)：启动、停止、health 和回滚状态机。

## 生产组件装配

`createProductionGateway()` 先加载环境、permission policy 和飞书配置，然后创建：

1. `SqliteRuntimeStore`，默认位于 `user_session_db/local_agent.sqlite3`。
2. `AtomicRuntimeProviderManager`，负责当前 provider generation。
3. `ToolRegistry`、coding tools、MCP manager 和 `SkillCatalog`。
4. `TypeScriptAgentRuntime`，通过 emitter port 与 Gateway 解耦。
5. `DashboardApi` 与 `BunDashboardServer`。
6. `SessionBindingStore`、`SessionRouter`、`SessionScheduler` 和 `HeartbeatBridge`。
7. 可选 `FeishuAdapter`；缺少必要配置时不注册飞书 channel。

业务能力由模型通过 native `exec` 调用版本化的独立 `lxeskill ...` 命令。Gateway 用 catalog 做命令归属与展示，并把允许的 skill scope 注入 CLI；Bun 常驻进程不注册 Python tool，也不加载业务模块。

## 启动顺序

`GatewayLifecycle.start()` 是 single-flight：重复调用共享同一个启动任务。生命周期先把 ingress 标记为不可接收，并依次执行：

1. 验证 session binding/state 可用。
2. 启动 Dashboard listener。
3. 启动进程内 Runtime 及其 services。
4. 启动 heartbeat bridge。
5. 将 channel inbound sink 绑定到 Router。
6. 启动所有 channel adapters。
7. 启动 planned-stop/status controller。
8. 标记 ingress ready，并写入当前 boot id 的状态文件。

只有全部 required component ready 后，health 才能报告可接收请求。Runtime 或 required channel 动态变为 unhealthy 时，readiness 同步变为 false，新 ingress 会被拒绝。

## 启动失败与并发 stop

启动过程中任一步失败，已启动组件按逆序 best-effort 关闭，原始启动错误保持为主错误。单个清理步骤失败不会阻止后续清理。

`stop()` 可以与 `start()` 竞态：

- stop 会改变 lifecycle generation，使尚未完成的启动不能晚到后重新宣告 ready。
- channel start 被中止时，`ChannelRegistry` 会调用已登记 adapter 的幂等 stop。
- heartbeat 或 channel start 永不结束时，生命周期仍使用有界等待退出。
- 重复 stop 共享已有任务，不重复释放资源。

这些行为由 `gateway-lifecycle.test.ts` 和 `channel-lifecycle.test.ts` 固定。

## 停止顺序

正常停止先关闭 ingress，再依次：

1. 停止 planned-stop/status controller。
2. 停止 heartbeat，等待正在进行的 flush。
3. 停止 scheduler 接收新 job，并取消 active run。
4. abort Runtime 中登记的 provider、MCP 和 process 工作。
5. 停止 Runtime services。
6. 逆序停止 channel adapters。
7. 停止 Dashboard。
8. 关闭 SQLite、文件日志和仅属于当前 boot id 的状态文件。

每一步独立处理异常，确保一次失败不会留下其它组件。验收目标是连续 start/stop/restart 后没有残留端口、SQLite lock、MCP client、业务脚本或浏览器进程。

## Planned stop 与状态文件

`GatewayStatusFiles` 使用 boot id 区分当前进程与陈旧状态；写入采用原子 UTF-8 JSON。`PlannedStopPoller` 只消费目标匹配且未过期的 marker，默认 marker TTL 为 300 秒。poll 错误会被报告并继续下一轮，不会直接终止 Gateway。

CLI stop、系统信号、fatal error 和 planned stop 最终进入同一个停止路径，因此不会出现多套资源释放顺序。

## Dashboard 与配置热切换

Dashboard API 和静态资源由 `BunDashboardServer` 提供，默认监听 `127.0.0.1:8765`，端口冲突时可按配置 fallback。模型或 thinking PATCH 会先构造并验证新 provider client，再原子写入 `.env.local` 并切换 generation；已开始的 turn 继续使用自己的 snapshot。

## Health 解释

health snapshot 汇总 lifecycle phase、Runtime readiness、channel health、Dashboard 和当前 boot 状态。`ready=false` 表示不能安全接受新 ingress，不代表进程一定已退出。诊断时应同时查看组件级 health 和 runtime JSONL，而不是只观察端口是否存在。

# Desktop Gateway Lifecycle

状态：Current

## 目的

Gateway lifecycle 负责在 Electron Main 内管理持久化、私有 Runtime 子进程、scheduler、heartbeat 和 channel。它不提供命令行产品入口，也不监听 HTTP Dashboard 端口。

## 事实来源

- [`apps/desktop/src/main/desktop-gateway.ts`](/apps/desktop/src/main/desktop-gateway.ts)：桌面配置、环境和 Gateway 装配。
- [`apps/gateway/src/orchestration/composition.ts`](/apps/gateway/src/orchestration/composition.ts)：Router、Scheduler、Channel 和 Runtime port 的组合。
- [`apps/gateway/src/orchestration/lifecycle.ts`](/apps/gateway/src/orchestration/lifecycle.ts)：启动、停止、health 和失败回滚。
- [`apps/gateway/src/orchestration/process-runtime.ts`](/apps/gateway/src/orchestration/process-runtime.ts)：受管 `agent-cli` 子进程协议。
- [`apps/agent-cli/src/runtime-host.ts`](/apps/agent-cli/src/runtime-host.ts)：Agent 进程内的 Runtime composition root。

## 生产组件装配

Electron Main 创建 `ProcessAgentRuntime`、桌面 Gateway SQLite store 与可选 Feishu adapter，然后调用 `createDirectGatewayComposition()`。Feishu adapter 的图片模型输入处理器由 Desktop 显式注入，Gateway 只依赖 `InboundImageProcessorPort`，没有 Runtime fallback。Renderer 发送 `{ operation, input }` 类型化调用，经 preload IPC 进入 `DesktopGateway`；`channels.health` 由 Main 本地处理，其余操作通过私有 NDJSON protocol 交给 `agent-cli` 内的 `DashboardService`。链路没有 URL、method、HTTP status、fetch fallback 或 HTTP Server。

`ProcessAgentRuntime.isReady` 是 Runtime readiness 的唯一事实来源。Lifecycle 的 ingress 与 health 每次直接读取该值；composition 只负责在状态通知到达时把当前值同步给 Scheduler 的派发门闩。Desktop 不得直接修改 Scheduler，也不得根据另一份缓存决定是否接受或执行消息。

Desktop Cloud 的设备权限快照决定允许的 skill types，并在初始化 Agent 进程及权限热更新时传递授权结果。实际 `SkillCatalog` 过滤、Workspace scope、`ToolRegistry` 装配和 `LXESKILL_SKILL_SCOPE` 注入由 `AgentRuntimeHost` 执行，Gateway 不导入这些 Runtime 具体类。

## 启动顺序

`GatewayLifecycle.start()` 是 single-flight：

1. 验证 session binding/state 可用。
2. 启动受管 Runtime 子进程并等待 ready。
3. 启动 heartbeat bridge。
4. 将 channel inbound sink 绑定到 Router。
5. 启动所有 channel adapters。
6. 标记 ingress ready。

只有 Runtime 和 required channel 都健康时，health 才能报告可接收请求。启动任一步失败时，已尝试组件按反向依赖关系 best-effort 清理，同时保留原始错误。

## 停止顺序

正常停止先关闭 ingress，再依次停止 channel、heartbeat、scheduler readiness、active run 和 Runtime 子进程。每一步有独立超时与错误收集；重复 stop 共享同一任务。

桌面窗口保存配置后会调用同一 stop/start 路径，因此更换凭据、集成或日志档位不会建立第二套生命周期。

## Health 解释

Health snapshot 汇总 Runtime readiness、channel health、ingress 状态和最后错误。`ready=false` 表示不能安全接受新消息，不代表 Electron 已退出。诊断应通过桌面设置中的状态卡和日志目录完成，而不是检查端口或浏览器页面。

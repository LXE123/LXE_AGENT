# Gateway

状态：Current

Gateway 是单 Bun 进程的协议与生命周期边界：飞书事件进入 `FeishuAdapter`，转换为 `InboundEvent`，经 `SessionRouter` 和 `SessionScheduler` 直接调用 `TypeScriptAgentRuntime`；出站统一经 `GatewayEmitter` 返回 channel。

- [Gateway Lifecycle](gateway_lifecycle.md)
- [Channel Adapter Boundary](channel_adapter_boundary.md)
- [Session Routing and Permission](session_routing_permission.md)
- [Session Scheduler and Cancellation](session_scheduler_cancellation.md)
- [Emitter and Heartbeat Wake](emitter_heartbeat_wake.md)

事实来源是 [`apps/gateway/src`](/apps/gateway/src)。生产入口只有 `apps/gateway/src/main.ts`；不存在 worker 或其它 runtime fallback。

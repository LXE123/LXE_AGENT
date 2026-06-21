# Runtime Flow

状态：Current

## 目的

这篇文档解释一条用户消息从平台进入系统、经过 gateway 和 agent runtime、再回复到平台的端到端链路。读者如果只知道现象，不知道应该去 gateway、runtime、context 还是 tools 文档里继续查，应该先读这一篇。

## 设计理念

Runtime flow 只画边界，不承载模块细节。每一段只回答“谁把什么交给谁、交接物是什么、下一步去哪里查”，具体实现留给对应专题文档。这样这篇文档可以作为跨模块导航，而不会和 gateway、turn execution、context、tools 文档互相重复。

## 链路位置

本文横跨 `main.py -> GatewayApp -> SessionRouter -> SessionScheduler -> TurnHandler -> AgentLoop -> GatewayEmitter`。它覆盖 gateway 入口、runtime 执行、出站回复和后台唤醒，但不替代这些模块自己的 Current 文档。

Gateway 专题入口见 [Gateway 文档入口](../gateway/README.md)，runtime 专题入口见 [Runtime 文档入口](README.md)。

## 主链路

```text
main.py
  -> GatewayApp
  -> platform adapter
  -> InboundEvent
  -> SessionRouter
  -> SessionScheduler
  -> TurnHandler
  -> run_turn()
  -> AgentLoop
  -> TurnOutcome
  -> GatewayEmitter
  -> platform adapter outbound
```

这条链路的核心交接物依次是：

- 平台事件转换成 `InboundEvent`。
- `SessionRouter` 把入站消息转换成 `AgentJob`。
- `SessionScheduler` 把 job 和 `RunHandle` 交给 runtime。
- `TurnHandler` 调用 `run_turn()` 并接收 `TurnOutcome`。
- `GatewayEmitter` 把 runtime emit 转成平台 outbound request。

## 边界地图

| 边界 | 交接物 | 继续阅读 |
| --- | --- | --- |
| Process bootstrap | `main.py -> GatewayApp` | [Gateway lifecycle](../gateway/gateway_lifecycle.md) |
| Inbound boundary | platform event -> `InboundEvent` | [Channel and adapter boundary](../gateway/channel_adapter_boundary.md) |
| Routing boundary | `InboundEvent` -> `AgentJob` | [Session routing and permission](../gateway/session_routing_permission.md) |
| Scheduling boundary | `AgentJob` + `RunHandle` | [Session scheduler and cancellation](../gateway/session_scheduler_cancellation.md) |
| Runtime boundary | `TurnHandler -> run_turn() -> AgentLoop` | [Turn Execution](turn_execution.md) |
| Context boundary | state + current input -> LLM messages | [Runtime Context](context/README.md) |
| Tools boundary | tool registry/schema -> tool call/result | [Runtime Tools](tools/README.md) |
| LLM integration boundary | messages + tools -> provider stream -> `LLMResponse` | [LLM Integration](../llm/README.md) |
| Outbound boundary | `EmitRequest` -> platform outbound | [Emitter and heartbeat wake](../gateway/emitter_heartbeat_wake.md) |
| Storage boundary | SQLite, JSONL, `sessions.json` | [Local agent database layout](../../database/local_agent.md) |

## 后台唤醒

后台任务完成时不会直接绕过主链路发消息。它先写入 session pending event，再请求 wake：

```text
pending event
  -> HeartbeatWakeManager
  -> AgentJob(job_kind="heartbeat")
  -> SessionScheduler
  -> TurnHandler
  -> AgentLoop
  -> GatewayEmitter
```

`HeartbeatWakeManager` 仍然把 heartbeat job 放回同一个 `SessionScheduler`，所以后台唤醒遵守同一 session 串行规则。gateway 侧细节见 [Emitter and heartbeat wake](../gateway/emitter_heartbeat_wake.md)，runtime 侧 heartbeat turn 构造见 [Turn Execution](turn_execution.md)。

## 存储边界

端到端链路会触碰几类持久化状态：

- SQLite `agent_sessions`：session metadata、source、model、metrics 和 title。
- SQLite `response_routes`：平台回复定位。
- SQLite `agent_session_pending_events`：后台完成事件。
- JSONL `session_messages/<session_id>.jsonl`：canonical message history。
- `sessions.json`：`session_key -> session_id` 绑定。

这些存储不属于 flow 文档的实现细节；需要查字段和落盘方式时读 [Local agent database layout](../../database/local_agent.md) 和 [Runtime Context](context/README.md)。

## 关键不变量

- 同一 session 的 job 只能通过 `SessionScheduler` 串行进入 runtime。
- 平台回复必须经过 `response_route_id` 定位，不能由 tool 直接拼平台 API。
- `AgentLoop` 只接收 gateway 已经授权、已绑定 session 的 job。
- Context 和 tools 是 runtime 子系统，具体规则分别由 `runtime/context/` 和 `runtime/tools/` 承载。
- LLM provider integration 由 harness 级 [LLM Integration](../llm/README.md) 承载，agent loop 只消费统一的 `LLMResponse`。
- Pending event 通过 heartbeat job 回到主链路，不直接修改对话历史。

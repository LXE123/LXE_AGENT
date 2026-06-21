# Emitter And Heartbeat Wake

状态：Current

## 目的

这篇文档解释 agent runtime 产生的输出怎样回到平台，以及后台事件怎样重新唤醒同一个 session。读者如果在排查 streaming 卡片、final 回复、文件发送、typing indicator、pending event 或 heartbeat job，应该读这一篇。

## 设计理念

出站层把 runtime 的“我要发什么”与平台 adapter 的“怎么发”分开。`GatewayEmitter` 只根据 `response_route_id` 找到平台 route 并创建 outbound request；`HeartbeatWakeManager` 只把后台 pending event 重新排回 scheduler，不直接绕过 session 串行规则。

## 链路位置

这一层覆盖链路的尾部和后台回流：`AgentLoop`/`TurnHandler` 通过 emit bus 调到 `GatewayEmitter`，再经 adapter 发回平台；tool 或后台执行写入 pending event 后，通过 heartbeat wake 创建 `AgentJob(job_kind="heartbeat")`，重新进入 `SessionScheduler`。

本文维护 gateway 的出站发送和后台唤醒链路。事实来源是 [gateway/emitter.py](../../../gateway/emitter.py)、[gateway/heartbeat_wake.py](../../../gateway/heartbeat_wake.py)、[agent_runtime/emit_bus.py](../../../agent_runtime/emit_bus.py) 和 [shared/agent_io.py](../../../shared/agent_io.py)。

## GatewayEmitter

`GatewayEmitter` 把 agent runtime 的 `EmitRequest` 转成平台 adapter 的 `OutboundRequest`。

`GatewayApp.start()` 会调用：

- `configure_emit_handler(self._emitter.emit)`
- `configure_heartbeat_wake_handler(self._handle_heartbeat_wake_request)`

因此 agent runtime 不直接依赖平台 adapter，只通过 emit bus 回到 gateway。

## response_route_id

出站发送依赖 `response_route_id`：

- `SessionRouter` 在处理入站消息和控制反馈时调用 `create_response_route_context(ctx)`。
- `GatewayEmitter.emit()` 根据 `response_route_id` 读取 route context。
- 如果 route context 存在，platform 以 route context 为准。
- 如果 route context 不存在，则回退到 session source 中的 platform。
- 最后通过 `ChannelRegistry.get(platform)` 找到 adapter。

这使同一个 session 可以在不同消息 route 上回复，而不是只依赖 session source。

## emit kind

`GatewayEmitter.emit()` 当前处理这些 `emit_kind`：

- `progress`：只记录日志并忽略。
- `stream`：发送 `stream_message`。
- `tool`：先发送 files，再在有 content 时发送 message。
- `final`：先在有 content 时发送 message，再发送 files。

其它 `emit_kind` 会报错。

## Stream、final、file 和 typing

`emit_stream()` 创建 `EmitRequest(emit_kind="stream")`，包含：

- `stream_type`
- `state`
- `seq`
- `content`
- thinking 相关字段
- tool pending 和 tool steps

`emit_final()` 创建 `EmitRequest(emit_kind="final")`，包含最终内容和文件路径。

`emit_typing_indicator()` 当前只支持 `operation` 为 `start` 或 `stop`，且只对 Feishu 平台发送 typing indicator。非 Feishu 平台会跳过。

底层发送到 adapter 时使用 `OutboundRequest`：

- `stream_message`
- `send_message`
- `send_file`
- `typing_indicator`

## HeartbeatWakeManager

`HeartbeatWakeManager` 处理 tool 或后台执行写入 pending event 后的唤醒请求。它不会直接执行 agent runtime，而是把 heartbeat job 放回同一个 `SessionScheduler`。

当前 wake 请求来自 emit bus 中注册的 heartbeat wake handler，数据形态是 `HeartbeatWakeRequest`：

- `session_id`
- `reason`，默认 `exec-event`
- `response_route_id`

## Wake 去重和延迟

`HeartbeatWakeManager` 内部按 `session_id` 去重 pending wake：

- 普通 wake 延迟 `_NORMAL_DELAY_S = 0.25` 秒。
- retry wake 延迟 `_RETRY_DELAY_S = 1.0` 秒。
- `retry` 优先级高于 `exec-event`。

如果同一个 session 已经有 pending wake，新 wake 会根据 priority 覆盖或保留，并尽量保留已有 `response_route_id`。

## Wake batch

定时器触发后，`_run_batch()` 对每个 wake 执行：

1. 如果 session 没有 pending events，丢弃 wake。
2. 如果 session 有 active 或 pending work，改为 retry 并延后。
3. 如果 session 不存在，丢弃 wake。
4. 从 session source 重建 `SessionSource` 和 `session_key`。
5. 创建 `AgentJob(job_kind="heartbeat")`。
6. enqueue 到 `SessionScheduler`。

heartbeat job 的 `user_input` 为空，`raw_data` 包含 `heartbeat_reason`、`session_key` 和 `source`。后续仍由同一个 `handle_unified_turn_job()` 处理。

## 关闭行为

`GatewayApp.stop()` 会先停止 `HeartbeatWakeManager`，再停止 `SessionScheduler`。这样关闭时不会继续把新的 heartbeat job 放进 scheduler。

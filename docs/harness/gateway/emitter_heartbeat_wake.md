# Emitter and Heartbeat Wake

状态：Current

[`GatewayEmitter`](/apps/gateway/src/emitter.ts) 严格校验 `EmitRequest`，通过 `response_route_id` 解析 channel route。飞书 streaming 只接受 `stream_type=final_answer` 与 `state=delta|final|error`；一个 turn 只创建并关闭一张 CardKit 卡。

后台命令完成后先写 SQLite pending event，再由 [`HeartbeatBridge`](/apps/gateway/src/heartbeat-bridge.ts) 将 heartbeat job 放回同一个 `SessionScheduler`。因此后台通知仍遵守 session 串行、权限、cancel 和统一出站规则，不会由 Python 工具直接发送文件或消息。

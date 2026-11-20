# Gateway 出站与工具卡片更新

## 目的

本专题说明 Runtime 如何在不了解平台 SDK 的前提下发送 stream、final、tool artifact 和 typing，以及桌面如何更新后台 exec 工具卡。

事实来源：[`emitter.ts`](/apps/gateway/src/channels/emitter.ts) 和 [`local-conversation.ts`](/apps/gateway/src/orchestration/local-conversation.ts)。

## Emitter 边界

Runtime 只调用 emitter port：

- `emit(EmitRequest)`：progress、stream、tool 或 final。
- `typing()`：start/stop typing intent。

`GatewayEmitter` 先使用 protocol schema 验证请求，再读取 session 和 `response_route_id`。它根据 route platform 从 `ChannelRegistry` 获取 adapter，构造统一 `OutboundRequest`。Runtime 不持有飞书 client、card id 或 source message id。

route 存在但无法读取时，正式发送明确失败；typing 允许缺失 route 并静默返回，因为它是 best-effort UX。

## Emit kind

### Progress

`progress` 只用于内部状态，不产生平台消息。

### Stream

stream payload 保留：

- `state=delta|final|error` 与单调 `seq`。
- answer content 与 thinking 文本。
- redacted thinking 数量，不包含 encrypted data。
- thinking/tool elapsed time、pending 状态和 tool steps。
- model/context/token 等 display metrics。

内容、thinking、tool 和 metrics 全为空时不发送空帧。飞书 adapter 只接受 `stream_type=final_answer`，同一 `emit_id` 的所有帧更新同一张 CardKit 卡。

### Tool 与 final

tool emit 先发送 artifact files，再发送可选说明；final 先发送正文，再发送 files。这个顺序是协议合同，用于避免正式结论与中间附件错位。

每个 file path 单独生成 `send_file` action。单个发送失败会结束该 emit 并交给 turn failure handling，不会假装文件已经送达。

## Response route isolation

route 是发送位置的持久化快照，包含 platform、conversation/source message 和 CardKit delivery handle。Card 创建成功后 adapter patch route；后续帧每次按 route id 解析。

如果某个 route 的 final delivery 失败：

- 已完成的 Runtime outcome 与 transcript 不回滚。
- 不使用其它 session 或旧 message 作为 fallback。
- 不重放 tool call。
- 只记录当前 delivery failure，并按 final streamer 规则决定是否允许一次普通 fallback。

该隔离避免跨会话误发和“发送失败导致业务重跑”。

## Typing

typing 只对飞书执行，operation 必须是 `start` 或 `stop`。adapter 使用 message reaction 添加/删除 `Typing`，并持久化必要 handle。重复 start 幂等；API 或权限失败只记录，不阻塞 turn。

## FinalAnswerStreamer

一个飞书 turn 只创建一个 streamer 和一个 emit id。streamer 负责节流 delta、保持 sequence、发送 final/error 和有界关闭 sender task。只有从未成功投递任何 stream frame 时，才允许一次普通 final/error fallback；cancel 不额外制造错误卡。

## 后台 exec 工具卡更新

`exec` 返回 `exec_id` 后，Agent 通过 `background_task.changed` 通知桌面更新运行中的输出和最终状态。

1. 事件携带 Session、来源 Turn、原 `tool_call_id`、递增的 `revision` 和有界任务快照。
2. Desktop 使对应 Session 查询失效；本地会话控制器把原 exec 工具卡从 `running` 更新为 `success` 或 `error`。
3. 若完成事件早于工具卡，控制器暂存事件，并在卡片出现后补上终态。

后台完成事件只更新界面。模型可通过 `wait` 获取命令的输出和退出状态。

## 可观测性与安全

日志记录 emit kind、状态、耗时、文件数量和失败阶段，但不打印 authorization、cookie、绝对敏感路径、base64、redacted thinking data 或完整用户正文。诊断发送问题时应结合 response route、CardKit sequence 和 runtime trace，而不是重跑业务工具。

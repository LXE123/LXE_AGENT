# Channel And Adapter Boundary

状态：Current

## 目的

这篇文档解释平台世界和 gateway 世界之间的翻译边界。读者如果想知道 Feishu SDK 事件怎样进入 gateway、gateway 为什么不直接处理平台 SDK 对象、出站回复怎样重新交给平台 adapter，应该读这一篇。

## 设计理念

平台边界层的取舍是把平台差异压进 adapter，把 gateway 内部统一成 `InboundEvent` 和 `OutboundRequest`。这样新增或替换平台时，不需要让 `SessionRouter`、`SessionScheduler` 或 `AgentLoop` 理解平台 SDK 的消息结构。

## 链路位置

这一层位于 `GatewayApp` 和 `SessionRouter` 之间，也位于 `GatewayEmitter` 和具体平台发送实现之间。入站方向是 adapter -> `AgentQueue` -> dispatch loop -> `SessionRouter`；出站方向是 `GatewayEmitter` -> `ChannelRegistry` -> adapter。

本文维护 gateway 与平台 adapter 的边界。事实来源是 [gateway/channel_registry.py](../../../gateway/channel_registry.py)、[gateway/agent_queue.py](../../../gateway/agent_queue.py)、[gateway/models.py](../../../gateway/models.py)、[shared/platform/adapter.py](../../../shared/platform/adapter.py) 和 [platforms/feishu/gateway.py](../../../platforms/feishu/gateway.py)。

## Adapter contract

平台 adapter 实现 [ChannelAdapter](../../../shared/platform/adapter.py) 协议：

- `platform`：平台名，例如 `feishu`。
- `set_inbound_sink(sink)`：注册 gateway 入站回调。
- `start()` / `stop()`：启动和停止平台连接。
- `health()`：返回 adapter 健康状态。
- `handle_outbound(request)`：处理 gateway 发出的 `OutboundRequest`。

Gateway 不直接依赖平台 SDK。平台 SDK 事件必须先由 adapter 转成 gateway 的 canonical DTO。

## ChannelRegistry

`ChannelRegistry` 只管理 adapter 集合：

- `register(adapter)` 按 `adapter.platform` 注册，重复平台会报错。
- `list()` 和 `adapter_keys()` 用于启动、关闭和日志。
- `get(platform)` 用于 outbound 时找到对应 adapter。
- `start_all()` 按注册顺序启动 adapter。
- `stop_all()` 按反向顺序停止 adapter，并对每个 adapter stop 设置 timeout。
- `health_snapshot()` 汇总所有 adapter 的 `health()`。

当前 `GatewayApp.from_config()` 注册的是 `FeishuStreamAdapter`。

## InboundEvent

平台入站消息进入 gateway 时使用 [InboundEvent](../../../gateway/models.py)：

- 平台和事件：`platform`、`event_type`。
- 用户输入：`user_input`、`user_content_blocks`。
- 用户和会话来源：`user_id`、`union_id`、`conversation_id`、`is_group`、`sender_nick`。
- 平台消息：`message_id`、`response_route_id`。
- 原始上下文：`source`、`raw_data`。

Feishu adapter 会解析消息内容、附件、引用消息和群聊 at 规则。群聊消息只有明确 at 当前 bot 时才会进入 gateway。

## AgentQueue

`AgentQueue` 是 gateway 内部的 asyncio queue，只保存 `InboundEvent`：

- adapter 通过 `GatewayApp.publish_from_adapter()` 送入事件。
- `publish_from_adapter()` 使用 `loop.call_soon_threadsafe()`，适配 Feishu adapter 自己的线程和 gateway 主 loop 之间的边界。
- `GatewayApp._dispatch_loop()` 从 queue 读取事件，然后交给 `SessionRouter.route_message()`。

`AgentQueue` 不做权限、session 或业务判断。

## OutboundRequest

Gateway 发回平台时使用 [OutboundRequest](../../../gateway/models.py)：

- `action`：当前 Feishu adapter 支持 `stream_message`、`typing_indicator`、`send_message`、`send_file`，并忽略 unsupported `react`。
- `platform`：目标平台。
- `payload`：平台无关的发送参数。
- `session_id`、`response_route_id`：用于找 session 和平台 route。
- `event_id`、`execution_token`：用于发送追踪或执行上下文。

Feishu adapter 会根据 `response_route_id` 读取 route context，再决定把内容发到哪个 chat/message 线程。

## Feishu adapter 当前职责

`FeishuStreamAdapter` 当前承担这些平台细节：

- 启动 lark-oapi WebSocket client，并在独立线程中运行 SDK loop。
- 探测 bot identity，用于群聊 at 过滤。
- 对入站消息做去重、最大年龄过滤、消息解析、资源解析和引用消息注入。
- 把平台消息转成 `InboundEvent`。
- 把 `OutboundRequest` 转成 Feishu CardKit、markdown card、文件发送或 typing indicator。
- 维护 stream card 状态，处理 stream reopening、finalized 和 stale frame。

这些细节留在 adapter 内，gateway 其它模块只消费 `InboundEvent` 和 `OutboundRequest`。

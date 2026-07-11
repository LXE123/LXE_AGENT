# Channel Adapter Boundary

状态：Current

[`ChannelRegistry`](/apps/gateway/src/channel.ts) 只管理平台 adapter。入站 adapter 产出统一 `InboundEvent`；出站接收统一 `OutboundRequest`。平台 SDK、消息类型、资源下载和 CardKit 状态都封装在 [`apps/gateway/src/feishu`](/apps/gateway/src/feishu)。

飞书入站 converter registry 覆盖 text/post/image/file/audio/video 及 location、sticker、calendar、share、folder、todo、vote、video chat、merge-forward、interactive、system、unknown。单个资源下载失败会成为可读占位，不会丢弃整条消息。

Adapter 不调用 Runtime，也不推测 session。`SessionRouter` 负责权限与绑定，`GatewayEmitter` 通过 `response_route_id` 查找发送位置。

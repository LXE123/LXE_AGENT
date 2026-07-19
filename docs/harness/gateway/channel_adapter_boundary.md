# Channel Adapter Boundary

状态：Current

## 目的

Channel adapter 隔离平台 SDK 与 Agent 核心。Gateway 只接受统一 `InboundEvent` 并发出统一 `OutboundRequest`；飞书事件结构、资源下载、reaction、CardKit sequence 和 API 错误都留在 adapter 内部。

## 统一接口

[`ChannelAdapter`](/apps/gateway/src/channels/registry.ts) 暴露最小端口：

- `platform`：稳定平台 key，用于 registry 和 response route。
- `setInboundSink()`：注册统一入站回调。
- `start()` / `stop()`：可选、幂等生命周期。
- `handleOutbound()`：处理标准出站 action。
- `health()`：返回不含密钥的动态状态。

`ChannelRegistry` 拒绝重复 platform，按注册顺序启动、逆序停止。启动失败时会回滚已经登记的 adapter；即使失败发生在 adapter 部分绑定资源之后，也会调用其 stop。stop 与 start 竞态通过 generation 阻止晚到启动复活。

## 入站链路

飞书 SDK callback 先被 [`feishu/inbound.ts`](/apps/gateway/src/channels/feishu/inbound.ts) 快照化和归一化，再进入 Router：

```text
Lark event callback
  -> immutable message snapshot
  -> timestamp/dedup/group mention validation
  -> rich message conversion
  -> ordinary message resource download
  -> InboundEvent
  -> registered inbound sink
```

Normalizer 支持 text、post、image、file、audio、video，以及 location、sticker、calendar、share、folder、todo、vote、video chat、merge-forward、interactive、system 和 unknown。unknown 消息保留可读描述，不能因为 converter 未识别而静默丢失。

Interactive Card 是单独的结构化文本边界。直接收到卡片、读取被引用卡片或展开合并转发时，adapter 都以 `card_msg_content_type=raw_card_content` 获取原始 CardKit JSON，再提取标题、Markdown、代码块、折叠面板、操作和 footer。引用查询先请求 `/im/v1/messages/{id}`；查询、快照、转换、资源处理或组装任一阶段失败，都会带着该阶段的实际异常继续尝试 `/im/v1/messages/mget`。只有整条尝试成功才算引用可用；两条路径均失败时，用户正文保持原样，脱敏后的真实异常通过 `AgentDiagnostic` 传递，不再写“引用不可用”等自造错误文本。飞书的内部 icon、image key 和默认升级客户端降级文案不会进入 Agent 输入。

私聊保留 sender、chat、thread、quote 和 union-id 信息。群聊必须包含当前 bot mention，mention 从用户可见文本中移除后再进入 Runtime。缺少 sender open id 的事件被拒绝；无法解析或缺失 timestamp 的事件允许继续，但明确过旧的事件会被丢弃。

## 资源处理

[`feishu/resources.ts`](/apps/gateway/src/channels/feishu/resources.ts) 下载 image/file 等资源到受控本地路径。单个资源失败不会制造替代正文；其它文本和成功资源仍进入同一消息，脱敏后的实际下载、解码或落盘异常进入 `diagnostics`。平台下载失败不能使整条用户消息消失。

只有普通 image/file/audio/video、富文本和合并转发子消息中的普通资源进入下载链路。Interactive Card converter 始终返回空资源列表；卡片图片只保留 alt 等文本语义，因为飞书的 message-resource API 不支持卡片消息资源。引用普通图片仍会下载并作为模型 image block 传入。

Agent 进程中的 `feishu_im_bot_fetch_resource` 还会在下载前回读目标消息，确认 key 与类型确实由普通消息正文声明。CardKit key 被确定性拒绝为 `interactive_card_not_downloadable_resource`，不属于目标消息的 key/type 被拒绝为 `resource_not_declared_by_message`；验证查询失败时 fail closed，不盲目调用资源接口。

图片解码和模型 block 生成通过 `InboundImageProcessorPort` 显式注入。Desktop 提供 Electron 实现；Gateway 没有 Bun Runtime fallback，也不导入 Runtime 的图片类。

资源路径只作为 canonical user block 交给 Runtime。adapter 不调用业务 skill，也不自行读取附件内容。

## 出站 action

`FeishuAdapter.handleOutbound()` 只接受已知 action：

- `stream_message`：创建、更新或关闭同一张 CardKit stream。
- `send_message`：发送 Markdown/card 回复。
- `send_file`：上传并回复本地 artifact。
- `typing_indicator`：best-effort 添加或删除 Typing reaction。

每个 action 都验证 payload shape。未知 action、空正文、无效文件路径或平台 API 非零响应会明确失败。typing 与 reaction 失败不会阻塞正常回复；正式消息和文件失败则返回给 emitter/turn failure handling。

## CardKit 状态

CardKit state 由 adapter 内部维护，按 session/emit 串行化更新：

- 第一帧创建卡片并保存 delivery handle。
- sequence 必须单调增加，过期帧被拒绝或忽略。
- thinking、tool 和 answer 复用同一张卡。
- final/error 关闭 streaming mode，再替换最终结构并清理内存状态。
- 新建卡片首次被 IM 引用时，只有精确的 `230099/11310/cardid is invalid` 会使用同一卡片按 1 秒间隔重试两次；恢复卡、更新操作和其它错误不重试。
- 新卡引用三次均失败时终止当前 CardKit stream，Runtime 在 turn 结束后只发送一次普通 final。
- API code `200850` 只允许重开一次；重复或其它错误终止当前 stream。

encrypted thinking data 永远不进入卡片、日志或异常文本。

## 生命周期与健康状态

飞书 adapter start 创建 SDK connection，stop 有界等待正常关闭，必要时升级为 force close。WebSocket reconnect health 和 idle restart 在 adapter 内部处理；只有 scheduler 无 queued/inflight 工作时才允许主动重启，避免切断活跃 turn。

raw event dump 只在 local logs 开启时写入。health 只能暴露 ready、connection/restart 等运行状态，不输出 app secret、token、authorization 或用户消息全文。

错误边界遵循一条硬规则：默认保留实际错误，只允许脱敏和显式截断。固定友好文本只有在 operation 加明确 provider code/subcode（或本地确定性错误码）精确匹配，并且有真实 fixture/集成测试证明语义等价时才能使用；HTTP status、异常关键词和模糊正则不能单独生成原因。

## 禁止越界

Adapter 不负责：

- permission policy 或 session binding。
- job 排队、并发、cancel 或 steering。
- provider、context、tool 或 skill 调用。
- 根据平台事件直接写 assistant transcript。

这些职责分别属于 Router、Scheduler、Runtime 和 storage。保持该边界可以新增平台而不改 turn 执行核心。

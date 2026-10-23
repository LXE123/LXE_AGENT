# Canonical Message

## 目的

Canonical message 是 storage、ContextPipeline、provider 和 tool loop 共享的模型历史格式。供应商专属字段按来源保存，只在匹配的请求边界重放；协议适配不能反向改写持久化 transcript。

## Message 形态

普通消息 role 为 `user`、`assistant`、`tool` 或 `system`。Runtime 还使用 `compactionSummary` 保存结构化摘要及文件读写线索，发送给 Provider 时投影为用户上下文。普通 content 可以是字符串或 block 列表，主要 block 包括：

- `text`
- `thinking`，新消息用 `thinkingSignature` 和可选 `redacted` 保存来源相关元数据
- `redacted_thinking` 与旧 `signature` 字段仍可在兼容历史中出现
- `tool_call`，包含 id、name 和 object arguments
- `tool_result`，包含对应 `tool_call_id`、content 和可选 `is_error`
- `image`，保存图片 source，由 provider 按能力转换请求
- `local_file`，用户提供的本地附件引用

Tool result 位于独立 `tool` message。各 Provider adapter 转换为对应 wire 格式，例如 Anthropic 的 `user + tool_result/tool_use_id`；响应先还原为 canonical `tool_call/arguments` 再进入 Runtime 和 transcript。统一 AssistantMessage 的来源字段和流事件见 [模型消息流](../../llm/assistant-message-stream.md)。

## Tool closure

每个有效 `tool_call.id` 必须最多匹配一个 result。provider request 前 sanitizer：

1. 丢弃没有对应 tool use 的 orphan result。
2. 忽略 duplicate result，只保留第一个有效闭合。
3. 对缺失 result 的 tool use 注入 `Tool result unavailable.` error stub。
4. 保持原消息顺序和非工具 blocks。

Runtime 正常路径在本批工具执行结束后按原调用顺序写入 tool message；sanitizer 主要修复旧数据、崩溃中断或外部 transcript 修改。

## Thinking

思考签名与不透明数据可以进入 canonical history，使来源匹配的 provider 在后续 turn 继续使用。新消息字段以 [AssistantMessage](../../../../packages/agent/runtime/src/messages/assistant-message.ts) 为准；旧历史可能包含 `signature` 和 `redacted_thinking.data`。它们受到严格隔离：

- summary transcript 只写占位或描述，不写 opaque data。
- runtime log、wire trace 和错误文本不写 data/signature 原文。
- CardKit 只显示允许的 thinking 文本和 redacted count。
- Provider adapter 可以为不支持的模型删除相关 blocks，而不修改 canonical storage。

## Image

Image block 在统一消息中保留 source，可跨 turn 与重启继续使用。模型视图是否携带图片取决于上下文压缩和当前 Provider 的输入能力；展示或请求内的占位不代表磁盘原图已删除。保存与恢复只在 [图片持久化](context_persistence.md#图片与敏感数据)维护。

## Legacy replay

运行时直接读取 Transcript v2；v1 整段替换事件、旧工具块命名和早期 session_messages 存储需要先离线迁移，不会在正常加载时静默转换。损坏行或非法 patch 明确报错；v2 中因异常中断缺失的工具结果可由 replay closure 修复，但不会重跑工具。迁移与恢复见 [Context Persistence](context_persistence.md)。

## 序列化原则

- message 必须是可 JSON 序列化数据。
- tool input 和 state patch 必须是 object，不能接受 array/null 伪装。
- clone 进入 provider request，防止 SDK mutation 反向修改 transcript。
- 任何脱敏只影响日志/展示；模型视图的修复、压缩与重置通过明确的 `context_patch` 记录。

## 验证

Context tests 覆盖 orphan/duplicate/missing tool result、thinking/redacted blocks、图片保留、legacy replay 和 compaction 后 closure。新增 block 类型时必须同时更新 token estimate、provider adaptation、storage replay 和 trace redaction。

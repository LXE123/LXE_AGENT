# Canonical Message

状态：Current

## 目的

Canonical message 是 storage、ContextPipeline、provider 和 tool loop 共享的模型历史格式。Provider-specific 字段只在请求边界 adaptation，不能污染持久化 transcript。

## Message 形态

消息 role 为 `user`、`assistant`、`tool` 或 `system`。content 可以是字符串或 block 列表，主要 block 包括：

- `text`
- `thinking`，可带 signature
- `redacted_thinking`，只保存 opaque data
- `tool_call`，包含 id、name 和 object arguments
- `tool_result`，包含对应 `tool_call_id`、content 和可选 `is_error`
- `image`，本轮可携带 provider 支持的 source

Tool result 位于独立 `tool` message。只有 Provider adapter 会将它转换为 Anthropic-compatible 的 `user + tool_result/tool_use_id` wire message；Provider 响应中的 `tool_use/input` 也必须先还原成 canonical `tool_call/arguments` 才能进入 Runtime 和 transcript。

## Tool closure

每个有效 `tool_call.id` 必须最多匹配一个 result。provider request 前 sanitizer：

1. 丢弃没有对应 tool use 的 orphan result。
2. 忽略 duplicate result，只保留第一个有效闭合。
3. 对缺失 result 的 tool use 注入 `Tool result unavailable.` error stub。
4. 保持原消息顺序和非工具 blocks。

Runtime 正常路径会在 tool dispatch 后立即写结果；sanitizer 主要修复旧数据、崩溃中断或外部 transcript 修改。

## Thinking

`thinking` signature 和 `redacted_thinking.data` 可以进入 canonical history，使支持的 provider 在后续 turn 继续使用。它们受到严格隔离：

- summary transcript 只写占位或描述，不写 opaque data。
- runtime log、wire trace 和错误文本不写 data/signature 原文。
- CardKit 只显示允许的 thinking 文本和 redacted count。
- Provider adapter 可以为不支持的模型删除相关 blocks，而不修改 canonical storage。

## Image

当前 turn 的 image block 进入 token estimate 和 provider request。消息持久化时，base64 source 替换为 `[image data removed - already processed by model]` 文本占位；路径/资源描述可保留。

这样 replay 仍知道用户提供过图片，但不会在每个 turn 重复携带二进制数据。

## Legacy replay

Storage 的模型 replay 会归一化历史兼容形态，包括早期 Bun 写入的 `user + tool_use/tool_result` 和 main 的 tool role。兼容只发生在模型读取边界，不改写 JSONL；Dashboard 的 immutable transcript 视图不会重解释旧 Bun 记录。

无法识别的安全文本应尽量保留；结构损坏、越界对象或无法闭合的 tool metadata 转换为明确占位，不能导致整个 session 无法读取。

## 序列化原则

- message 必须是可 JSON 序列化数据。
- tool input 和 state patch 必须是 object，不能接受 array/null 伪装。
- clone 进入 provider request，防止 SDK mutation 反向修改 transcript。
- 任何脱敏只影响日志/展示；除 image aging 和明确 replacement 外，不静默改写持久化内容。

## 验证

Context tests 覆盖 orphan/duplicate/missing tool result、thinking/redacted blocks、image aging、legacy replay 和 compaction 后 closure。新增 block 类型时必须同时更新 token estimate、provider adaptation、storage replay 和 trace redaction。

# Canonical Message 与 Context State

状态：Current

## 目的

这篇文档解释 runtime 内部“长期记忆”的数据形状：`state_data` 里哪些内容属于控制态，哪些内容属于可进入 LLM 的 message history。读者如果在排查消息为什么被清洗、某个 role/block 为什么被保留或丢弃、JSONL history 和 provider messages 如何对应，应该读这一篇。

## 设计理念

Canonical message 是 runtime 的共同语言。它把 session 存储、context 组装、tool result、thinking block 和 provider 适配都收敛到一套 role/block 结构里，同时把 `runtime` 控制字段和 `context.messages` 分开，避免控制态混进模型上下文。

## 链路位置

这一层位于 session storage 和 `AgentLoop` 之间。turn 开始时，JSONL history 被读回并清洗成 canonical messages；turn 执行中，assistant message 和 tool result 继续按同一格式追加；turn 结束后，这套 messages 再写回 session message history。

本文说明当前 runtime 内部保存和传递的 context state 与 canonical message 格式。事实来源：

- [shared/agent_state.py](../../../../shared/agent_state.py)
- [agent_runtime/context_pipeline.py](../../../../agent_runtime/context_pipeline.py)
- [agent_runtime/llm_adapter.py](../../../../agent_runtime/llm_adapter.py)
- [shared/db/sqlite/session_messages.py](../../../../shared/db/sqlite/session_messages.py)

## Context State Shape

当前 `state_data` 的规范形状是：

```json
{
  "runtime": {
    "session_activity_at": 1780000000
  },
  "context": {
    "messages": []
  }
}
```

`ensure_agent_state()` 会把输入清洗成这个 nested shape。`runtime` 是控制态，目前允许的字段由 `RUNTIME_ALLOWED_KEYS` 限制，当前只有 `session_activity_at`。`context.messages` 是 canonical messages 数组。

读取 context 时：

- `context_state(state_data)` 返回清洗后的 `context`。
- `load_context_messages(state_data)` 取出并再次规范化 `context.messages`。

写入 context 时：

- `update_context_state()` 只接受并清洗 `messages` patch。
- `replace_context_state()` 会用新的 `messages` 整包替换 context。
- `append_messages_to_state()` 追加本轮 messages 前会校验 assistant tool call 与 tool result 是否闭合。

## Storage

当前 session message history 不再保存在 SQLite session row 或旧 context data 表中。SQLite session row 保存 metadata、metrics、model 等字段；message history 保存在 JSONL 文件：

```text
session_messages/<session_id>.jsonl
```

`save_session_messages()` 写入前会调用 `update_context_state()` 清洗 messages，再逐行写 JSON。`load_session_messages()` 读取 JSONL 后也会重新清洗，非法 role 或非法 block 不会进入最终 context。

## Message Roles

canonical message 允许四种 role：

| Role | Content shape | 用途 |
| --- | --- | --- |
| `system` | string | 少量系统事件或控制消息。大 system prompt 通常不持久化在 messages 中。 |
| `user` | string 或 inline blocks | 用户文本、当前图片、compaction summary 等用户侧内容。 |
| `assistant` | content blocks | LLM 文本、thinking、tool call 等 assistant 输出。 |
| `tool` | tool result blocks | 工具执行结果，后续会适配成 provider 所需格式。 |

不认识的 role 会被丢弃。

## User Content

`user.content` 可以是字符串，也可以是 inline content blocks。当前稳定清洗的 inline block：

```json
[
  {"type": "text", "text": "用户输入"},
  {
    "type": "image",
    "source": {
      "type": "base64",
      "media_type": "image/png",
      "data": "..."
    }
  }
]
```

image source 会统一成 `type/base64`、`media_type`、`data`。`mimeType` 会被接受并转成 `media_type`。

## Assistant Content

`assistant.content` 总是 blocks 数组。当前稳定保留：

```json
[
  {"type": "text", "text": "回复文本"},
  {"type": "thinking", "thinking": "...", "signature": "..."},
  {"type": "redacted_thinking", "data": "..."},
  {
    "type": "tool_call",
    "id": "toolu_xxx",
    "name": "read",
    "arguments": {"path": "README.md"}
  }
]
```

清洗规则：

- assistant 字符串内容会转成单个 `text` block。
- `tool_call` 必须有 `name`，否则丢弃。
- 缺失 `tool_call.id` 时会自动补 UUID。
- `thinking` 在有 `thinking` 或 `signature` 时保留。
- `redacted_thinking` 保留 `data`。

Anthropic response 中的 `tool_use` 只在 provider response canonicalize 或 legacy migration 场景中转成内部 `tool_call`。

## Tool Result Content

`tool` message 的 content 是 tool result blocks：

```json
{
  "role": "tool",
  "content": [
    {
      "type": "tool_result",
      "tool_call_id": "toolu_xxx",
      "content": "工具执行结果",
      "is_error": false
    }
  ]
}
```

规则：

- `tool_result.tool_call_id` 对应 assistant `tool_call.id`。
- 缺失 `tool_call_id` 时会自动补 UUID，但正常运行路径应保持闭合。
- `content` 可以是字符串，也可以是 inline blocks；inline blocks 会按 user inline block 规则清洗。
- `is_error` 只有为 true 时才有语义。

`validate_tool_call_closure()` 会检查已持久化 messages 中所有 assistant `tool_call.id` 是否都有后续 tool result 消费；未闭合会抛错，避免保存破损上下文。

## Provider Adaptation

canonical messages 是 runtime 内部格式。发送给当前 agent LLM provider 前，`adapt_messages_for_anthropic()` 会转换为 Anthropic Messages 风格：

- `assistant.tool_call` -> `assistant` content 中的 `tool_use`
- `tool.tool_result` -> `user` content 中的 `tool_result`
- `system` message -> `user` message，内容前缀为 `[System Message]`
- DeepSeek provider 下，图片和 redacted thinking 会被替换成文本占位，因为该兼容 API 不支持这些 block

因此调试当前上下文时，应先看 canonical messages；wire format 只应在 provider adapter 或 wire trace 中查看。

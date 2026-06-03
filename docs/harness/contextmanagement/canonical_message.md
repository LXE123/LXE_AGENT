对，我们先把“当前 context 格式”拆清楚。现在项目里的上下文不是 Anthropic 格式，也不是 OpenAI 格式，而是项目自己的 **canonical message 格式**。

核心位置：

- [shared/agent_state.py](D:/rpa/python/20260420/lxe_agent_local/shared/agent_state.py:1)：定义 state/context/messages 清洗规则。
- [agent_runtime/context_pipeline.py](D:/rpa/python/20260420/lxe_agent_local/agent_runtime/context_pipeline.py:295)：构造 user/assistant/tool message。
- [shared/db/sqlite/agent_contexts.py](D:/rpa/python/20260420/lxe_agent_local/shared/db/sqlite/agent_contexts.py:31)：context_data 存储清洗。
- [agent_runtime/llm_adapter.py](D:/rpa/python/20260420/lxe_agent_local/agent_runtime/llm_adapter.py:567)：把基础格式适配成 Anthropic/OpenAI 请求格式。

**整体结构**

运行时完整 state 长这样：

```json
{
  "runtime": {
    "active_turn_id": "...",
    "active_card_id": "...",
    "active_turn_started_at": 0,
    "stop_turn_id": "...",
    "stop_requested_at": 0,
    "session_activity_at": 1780000000
  },
  "context": {
    "messages": []
  }
}
```

数据库里拆开存：

```text
agent_sessions.state_data    -> {"runtime": {...}}
agent_contexts.context_data  -> {"messages": [...]}
```

所以你现在要拆的主要是：

```json
{
  "messages": [
    ...
  ]
}
```

**message 基础格式**

`messages` 是一个有序数组。顺序就是上下文顺序，目前没有单独的 message id、timestamp、turn_id。

允许的 role 只有四种：

```text
system
user
assistant
tool
```

1. `system`

格式：

```json
{
  "role": "system",
  "content": "系统消息文本"
}
```

但注意：当前真正的大 system prompt 通常不存进 context，而是每轮通过 `build_system_prompt()` 重新生成。这个 role 被允许，但不是主流持久化内容。

2. `user`

纯文本：

```json
{
  "role": "user",
  "content": "用户输入内容"
}
```

多模态：

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "用户输入内容"
    },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/png",
        "data": "..."
      }
    }
  ]
}
```

当前只稳定支持 `text` 和 `image` 两类 inline block。飞书文件一般会变成文本元数据，比如文件名、本地路径、MIME type；当前消息图片才会作为 image block 进入。

3. `assistant`

格式固定是 content blocks 数组：

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "助手回复文本"
    },
    {
      "type": "tool_call",
      "id": "toolu_xxx",
      "name": "read",
      "arguments": {
        "path": "README.md"
      }
    }
  ]
}
```

如果 assistant 只是文本，也会被清洗成：

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "助手回复文本"
    }
  ]
}
```

`tool_call.id` 用来和后面的 tool result 对上。

补充：LLM response 解析层能看到 `thinking` / `redacted_thinking`，但持久化到 `agent_contexts.context_data` 时，稳定保留的主要还是 `text` 和 `tool_call`。所以做数据库拆分时，先不要把 thinking 当作必备持久字段。

4. `tool`

格式：

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

如果工具失败：

```json
{
  "role": "tool",
  "content": [
    {
      "type": "tool_result",
      "tool_call_id": "toolu_xxx",
      "content": "错误信息",
      "is_error": true
    }
  ]
}
```

`is_error` 只有为 true 时才有意义。`tool_call_id` 对应 assistant 的 `tool_call.id`。

**一轮对话的典型排列**

纯文本对话：

```json
[
  {
    "role": "user",
    "content": "你好"
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "你好，有什么可以帮你？"
      }
    ]
  }
]
```

带工具调用的一轮：

```json
[
  {
    "role": "user",
    "content": "读取 README"
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "tool_call",
        "id": "toolu_1",
        "name": "read",
        "arguments": {
          "path": "README.md"
        }
      }
    ]
  },
  {
    "role": "tool",
    "content": [
      {
        "type": "tool_result",
        "tool_call_id": "toolu_1",
        "content": "README 内容..."
      }
    ]
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "我已经读取了 README，内容是..."
      }
    ]
  }
]
```

多步工具调用时，会重复出现：

```text
assistant tool_call
tool result
assistant tool_call
tool result
assistant final text
```

**清洗规则**

写入 context 时会做规范化：

- 不认识的 `role` 会丢弃。
- user inline block 只保留 `text` / `image`。
- assistant block 只稳定保留 `text` / `tool_call`。
- tool block 只保留 `tool_result`。
- assistant `tool_call` 没有 `name` 会丢弃。
- 缺失的 `tool_call.id` / `tool_call_id` 会自动补 UUID。
- image source 会统一成：
  ```json
  {
    "type": "base64",
    "media_type": "...",
    "data": "..."
  }
  ```

**上下文会被修改**

context 不是单纯 append-only。运行过程中会被这些逻辑修改：

- 图片处理后会把历史图片替换成：
  ```text
  [image data removed - already processed by model]
  ```
- 过大的 tool result 可能被裁剪或清空：
  ```text
  [Old tool result content cleared]
  ```
- context 太长时会压缩，老消息会变成一个 summary user message：
  ```json
  {
    "role": "user",
    "content": "The conversation history before this point was compacted into the following summary: ..."
  }
  ```
- history limit 会截断旧 turn。

所以如果以后拆成 `agent_messages`，不能只支持 append，还要支持“整包 messages 快照重写”。

**供应商适配前后**

当前 context 里的格式是基础格式：

```text
基础 messages
```

发送给 Anthropic 前会变成 Anthropic Messages 格式：

```text
assistant tool_call -> Anthropic tool_use
tool role -> user content 里的 tool_result
image -> Anthropic image block
```

发送给 OpenAI 前又会变成 OpenAI chat/completions 格式：

```text
assistant tool_call -> tool_calls
tool role -> role=tool
```

所以可视化页面应该展示项目基础格式，不要展示 Anthropic/OpenAI 的 wire format。

**结论**

当前 context 的稳定格式就是：

```json
{
  "messages": [
    {
      "role": "user | assistant | tool | system",
      "content": "string 或 content blocks"
    }
  ]
}
```

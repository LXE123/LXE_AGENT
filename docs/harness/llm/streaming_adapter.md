# Streaming Adapter

状态：Current

## 目的

这篇文档解释一次 LLM step 如何从 `AgentLoop` 的请求变成 provider streaming request，再从流式事件归一化为 `LLMResponse`。读者如果在排查 text 没有流出、thinking 没有保存、tool_use 参数不完整、provider cancel 没生效或 provider error 怎么变成用户回复，应该读这一篇。

## 设计理念

Streaming adapter 把 provider wire event 和 agent loop 内部格式隔离开。外层 `agent_runtime.llm_adapter` 负责 runtime-facing API、message/tool schema 适配和 `LLMResponse` 聚合；内层 `shared.llm.transports.anthropic_sdk_stream` 负责 Anthropic Messages 兼容请求、SSE 事件解析、thinking payload、wire trace、cancel handle 和 provider-specific error 分类。

## 链路位置

这一层位于 `AgentLoop._request_llm_step() -> chat_with_tools_streaming() -> stream_message_events() -> LLMStreamEvent -> LLMResponse`。它接收本 step 的 system prompt、messages、tool schemas、tool choice、wire trace context 和 cancel handles；返回后 `AgentLoop` 决定是结束 turn、执行 tool calls、重试、压缩上下文还是返回错误回复。

本文事实来源：

- [agent_runtime/loop.py](../../../agent_runtime/loop.py)
- [agent_runtime/llm_adapter.py](../../../agent_runtime/llm_adapter.py)
- [agent_runtime/stream_logging.py](../../../agent_runtime/stream_logging.py)
- [shared/llm/events.py](../../../shared/llm/events.py)
- [shared/llm/errors.py](../../../shared/llm/errors.py)
- [shared/llm/transports/anthropic_sdk_stream.py](../../../shared/llm/transports/anthropic_sdk_stream.py)
- [shared/llm/transports/wire_trace.py](../../../shared/llm/transports/wire_trace.py)

## 调用入口

`AgentLoop._request_llm_step()` 每个 step 最多尝试 3 次。每次尝试会：

1. 读取当前 provider name，用于 stream logging 和 wire trace。
2. 创建 `StreamAttemptLogger` 记录本次 streaming 事件。
3. 调用 `chat_with_tools_streaming()`。
4. 把 `on_stream_event` 同时转给 final answer streamer 和 attempt logger。
5. 如果失败，根据错误是否 retryable、是否 context overflow 和尝试次数决定重试或交给上层处理。

`chat_with_tools_streaming()` 是 runtime-facing streaming API。它只接受当前内部格式：

- system prompt：字符串。
- messages：canonical messages 经 context pipeline 构造后的 LLM messages。
- tool schemas：内部 `ToolSchema` 列表。
- tool choice：`auto` 或 `none`。
- provider descriptor：默认来自 `agent_provider_descriptor()`。
- stream callback、wire trace context、cancel handles。

## Provider API Style

当前 agent runtime 只支持 `anthropic-messages`。`chat_with_tools_streaming()` 会检查：

```python
if desc.api_style != "anthropic-messages":
    raise RuntimeError(...)
```

因此 OpenAI chat completions、OpenAI function calling 或其它 wire style 不是当前运行路径。即使 provider 是 Kimi Coding、DeepSeek 或 GLM，也都是通过 Anthropic Messages 兼容接口发送。

## 请求适配

发送前会做两类适配：

- `adapt_tool_schemas(tool_schemas, desc.api_style)`：把内部 `parameters` 转为 Anthropic Messages 使用的 `input_schema`。细节见 [Runtime Tool Schema](../runtime/tools/tool_schema.md)。
- `adapt_messages_for_anthropic(messages, provider_name=desc.name)`：把内部 message blocks 转成 Anthropic Messages wire blocks。

Message 适配规则：

- `user` 文本保持 user content；图片在支持 vision 的 provider 中转成 base64 image block。
- `system` 历史消息作为 user content 中的 `[System Message]` 发送；当前 system prompt 仍走 request 顶层 `system` 字段。
- `assistant` 的内部 `tool_call` 转为 Anthropic `tool_use`。
- `tool` 的内部 `tool_result` 转为 user content 中的 `tool_result`。
- DeepSeek 不支持图片和 `redacted_thinking` wire block 时，用占位文本替代。

## Streaming Transport

`shared.llm.transports.anthropic_sdk_stream.stream_message_events()` 负责真正调用 provider：

1. 用 `ProviderDescriptor` 生成 Anthropic SDK client。
2. 根据 `base_url` 调用 `/v1/messages`。
3. 构造 request payload：`model`、`max_tokens`、`system`、`messages`、`stream=True`、tools、tool choice 和 thinking。
4. 如开启 wire trace，写入 request start、response start、每个 wire event 和 request end。
5. 把 Anthropic SDK streaming events 解析为统一的 `LLMStreamEvent`。
6. 在 finally 中清理 provider cancel handle，并在取消时关闭 stream/client。

Kimi Coding 会附带 `User-Agent` default header。GLM 和 DeepSeek 使用 provider JSON 中的 `base_url`、headers 和模型配置。

## LLMStreamEvent

`LLMStreamEvent` 是 provider stream 和 runtime 之间的事件语言：

- `message_start`：记录 message id、model 和初始 usage。
- `text_delta`：普通可见文本增量。
- `thinking_delta`：thinking 文本增量。
- `thinking_signature`：thinking signature。
- `redacted_thinking`：供应商返回的加密 thinking block。
- `tool_use`：完整 tool call，包含 id、name、arguments。
- `message_delta`：stop reason 和 usage。
- `message_stop`：stream 正常结束信号。
- `cancelled`：cancel event 已触发。

`content_block_start` / `content_block_delta` / `content_block_stop` 是 Anthropic wire event；它们不会直接暴露给 agent loop，而是在 transport 内部归一化为上面的事件。

## LLMResponse

`chat_with_tools_streaming()` 收集所有 `LLMStreamEvent` 后返回 `LLMResponse`：

- `text`：最终可见文本。
- `public_text`：从 assistant content 中收集的公开 text block。
- `assistant_content`：写回 canonical message history 的 assistant blocks。
- `tool_calls`：按 block index 排序后的 `LLMToolCall` 列表。
- `raw`：包含 message id、model、content、usage、stop reason 和 stream event 摘要。
- `usage`：provider usage。
- `latency_ms`：本次 streaming 总耗时。

如果没有看到 `message_stop`，会抛出 `AnthropicStreamError("stream ended before message_stop")`。

## Tool Use

Anthropic wire 中的 tool input 可能分多段 `input_json_delta` 到达。transport 会按 content block index 缓存 partial JSON，并在 `content_block_stop` 时解析成一个完整 `LLMToolCall`。

`AgentLoop` 收到 `LLMResponse.tool_calls` 后才进入 tool execution。streaming adapter 不执行工具，也不把 tool result 写回历史。

## Provider Error 与取消

Provider stream 中的 `error` event、Anthropic SDK 的 `APIStatusError` 和其它异常会被分类：

- Kimi Coding：`classify_kimi_coding_error()`。
- DeepSeek：`classify_deepseek_error()`。
- 其它 Anthropic Messages provider：`AnthropicStreamError` 或原异常。

分类后的 `LLMProviderError` 带有 `provider`、`status_code`、`category`、`user_message`、`retryable` 和 `context_overflow`。`AgentLoop` 使用这些字段决定是否重试、是否触发 context overflow recovery，以及最终用户可见错误文案。

取消来自 gateway `RunHandle`。`provider_cancel_registrar` 会登记一个关闭 stream/client 的 handle；取消发生后 transport 会关闭目标，并把 registrar 清回 `None`。

## Wire Trace 与 Stream Logging

Wire trace 记录 provider request/response 原始边界，事实来源是 [shared/llm/transports/wire_trace.py](../../../shared/llm/transports/wire_trace.py)。Stream logging 记录 runtime 观察到的 `LLMStreamEvent`、attempt 结果和 tool_use 事件，事实来源是 [agent_runtime/stream_logging.py](../../../agent_runtime/stream_logging.py)。

这两者只用于观测，不改变 `LLMResponse` 的语义。

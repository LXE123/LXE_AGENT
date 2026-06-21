# LLM Integration

状态：Current

## 目的

这个目录解释当前 harness 如何接入 agent LLM provider、组装 provider descriptor、发送 streaming request，并把供应商返回的事件归一化为 agent loop 能理解的 `LLMResponse`。读者如果在排查模型为什么选错、thinking 参数为什么这样发送、streaming 为什么中断、tool_use 为什么没有进入 tool loop，应该先从这里进入。

## 设计理念

LLM integration 按“agent runtime 调用接口”和“供应商差异”分层。`AgentLoop` 只面对 `chat_with_tools_streaming()`、`LLMStreamEvent` 和 `LLMResponse`；provider catalog、模型能力、headers、thinking payload、错误分类和 wire trace 都被收在 `shared.llm` 侧。这样 AgentLoop 不需要在每个 turn 里散落 Kimi、DeepSeek、GLM 的分支判断。

## 链路位置

这一层位于 `TurnHandler -> run_turn -> AgentLoop -> LLM adapter -> shared.llm transport -> LLMResponse`。它接收 [Runtime Context](../runtime/context/README.md) 构造出的 messages 和 [Runtime Tools](../runtime/tools/README.md) 提供的 tool schemas，调用 provider streaming 接口后，把 text、thinking、tool_use、usage 和错误状态交回 [Turn Execution](../runtime/turn_execution.md)。

本文档组事实来源：

- [agent_runtime/loop.py](../../../agent_runtime/loop.py)
- [agent_runtime/llm_adapter.py](../../../agent_runtime/llm_adapter.py)
- [shared/llm/agent_planner.py](../../../shared/llm/agent_planner.py)
- [shared/llm/provider_catalog.py](../../../shared/llm/provider_catalog.py)
- [shared/llm/runtime_config.py](../../../shared/llm/runtime_config.py)
- [shared/llm/events.py](../../../shared/llm/events.py)
- [shared/llm/transports/anthropic_sdk_stream.py](../../../shared/llm/transports/anthropic_sdk_stream.py)

## 阅读顺序

1. [Provider Catalog](provider_catalog.md)：provider JSON、runtime env、model capability、thinking 配置和 `ProviderDescriptor`。
2. [Streaming Adapter](streaming_adapter.md)：一次 LLM streaming request 如何变成 `LLMStreamEvent` 和 `LLMResponse`。

## 当前边界

当前 agent runtime 的 LLM wire style 只有 `anthropic-messages`。这不等于只支持 Anthropic 官方 provider；Kimi Coding、DeepSeek 和 GLM 都通过 Anthropic Messages 兼容接口进入同一条 runtime 路径。

本目录不解释完整 tool schema。provider 请求前的 tool schema 适配见 [Runtime Tools](../runtime/tools/tool_schema.md)。

# Provider Catalog

状态：Current

## 目的

这篇文档解释当前 agent runtime 如何决定“这一轮调用哪个模型供应商、哪个模型、最大输出和 thinking 形态”。读者如果在排查 `AGENT_LLM_PROVIDER` 没生效、模型 fallback、API key 缺失、provider headers 或 thinking level，应该读这一篇。

## 设计理念

Provider 配置被做成 catalog，而不是散在调用代码里。JSON 文件描述供应商、模型和能力；`provider_catalog.py` 负责校验和归一化；`agent_planner.py` 负责把 runtime env 选择变成当前 active `ProviderDescriptor`。这样新增 provider 时优先更新 catalog 和少量 provider-specific 处理，不需要改写 agent loop 的主流程。

## 链路位置

这一层位于 `AgentLoop` 发起 LLM step 之前。`AgentLoop._request_llm_step()` 调用 `agent_provider_descriptor()` 取得当前 `ProviderDescriptor`，再把它交给 [Streaming Adapter](streaming_adapter.md) 生成 provider request。

本文事实来源：

- [shared/llm/providers/kimi_coding.json](../../../shared/llm/providers/kimi_coding.json)
- [shared/llm/providers/deepseek.json](../../../shared/llm/providers/deepseek.json)
- [shared/llm/providers/glm.json](../../../shared/llm/providers/glm.json)
- [shared/llm/provider_catalog.py](../../../shared/llm/provider_catalog.py)
- [shared/llm/agent_planner.py](../../../shared/llm/agent_planner.py)
- [shared/llm/runtime_config.py](../../../shared/llm/runtime_config.py)
- [shared/llm/model_capabilities.py](../../../shared/llm/model_capabilities.py)

## Catalog 文件

当前 provider catalog 存在 [shared/llm/providers](../../../shared/llm/providers)：

| Provider | 默认模型 | API style | 关键能力 |
| --- | --- | --- | --- |
| `kimi_coding` | `kimi-for-coding` | `anthropic-messages` | vision、thinking、Kimi Coding headers、`kimi-code` model alias |
| `deepseek` | `deepseek-v4-pro` | `anthropic-messages` | thinking、无 vision、DeepSeek effort 映射 |
| `glm` | `glm-5v-turbo` | `anthropic-messages` | vision、thinking 由 provider 管理 |

每个 provider JSON 描述：

- `name`、`label`、`api_style`、`base_url`
- `default_model`
- `default_headers`
- `aliases` 和 `model_aliases`
- `models` 下每个模型的 `context_window_tokens`、`max_tokens`、vision、thinking、temperature 能力

`provider_catalog.py` 会在读取 JSON 时校验这些字段。当前只接受 `api_style == "anthropic-messages"`；其它 style 会在 catalog 解析或 runtime adapter 处失败。

## Runtime 选择

当前 active provider 来自 [shared/llm/runtime_config.py](../../../shared/llm/runtime_config.py)：

- `AGENT_LLM_PROVIDER`：默认 `kimi_coding`。
- `AGENT_LLM_MODEL`：默认 `kimi-for-coding`。
- `AGENT_LLM_MAX_TOKENS`：可选上限；大于 0 时会限制当前模型的最大输出。
- `AGENT_LLM_THINKING_ENABLED`：是否发送 thinking request。
- `AGENT_LLM_THINKING_EFFORT`：thinking effort 或 provider-specific level。
- `AGENT_LLM_THINKING_DISPLAY`：支持 adaptive thinking 的 provider 使用。
- `LLM_REQUEST_TIMEOUT_S`：provider request 默认超时。

`agent_planner.py` 的 `active_agent_planner_descriptor()` 会：

1. 归一化 `AGENT_LLM_PROVIDER`，支持 provider alias。
2. 根据 `AGENT_LLM_MODEL` 解析模型；模型不存在时回退到 provider 默认模型能力。
3. 通过 auth profile 读取 provider API key。
4. 返回 `ProviderDescriptor`，包含 `name`、`label`、`api_style`、`api_key`、`base_url`、`default_model`、`max_tokens`、thinking 配置和 default headers。

如果当前 provider 没有 API key，`active_agent_planner_descriptor()` 会抛出 `Missing API key for agent LLM provider`。

## Capability 与 max_tokens

`active_agent_planner_capabilities()` 从 provider catalog 解析当前模型能力，供 context pipeline 决定 context window、vision 和输出预算。

`effective_agent_planner_max_tokens()` 会把模型自己的 `max_tokens` 和 `AGENT_LLM_MAX_TOKENS` 取较小值。`chat_with_tools_streaming()` 发送请求时还会再次用 `ProviderDescriptor.max_tokens` 限制本次请求的 `max_tokens`。

## Thinking 配置

Provider JSON 中的 `thinking_request_style` 决定 streaming transport 如何生成 request payload：

- `anthropic-budget`：Kimi Coding 当前使用；根据 `AGENT_LLM_THINKING_ENABLED` 和 `AGENT_LLM_THINKING_EFFORT` 决定是否发送 `thinking` budget。
- `anthropic-effort`：DeepSeek 当前使用；启用时发送 `thinking` 和 `output_config.effort`。
- `provider-managed`：GLM 当前使用；runtime 不额外构造 thinking payload。
- `none` / `anthropic-adaptive`：catalog 支持的 style，当前 provider JSON 中没有把它们作为主路径使用。

Thinking 的 UI/日志展示由 `agent_planner.py` 生成 label；真正 request payload 由 [Streaming Adapter](streaming_adapter.md) 中的 `anthropic_sdk_stream.py` 构造。

## 非当前事实

旧 provider profile 设想不是当前事实。当前事实以 `shared/llm/providers/*.json`、`provider_catalog.py` 和 `agent_planner.py` 为准。

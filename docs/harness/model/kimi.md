# Kimi Coding 工具请求适配

本项目仅保留 Kimi Coding API；旧的兼容 OpenAI 聊天格式 provider 已移除。

## Kimi Coding API

| 配置项 | 值 | 说明 |
|--------|-----|------|
| **API 类型** | `anthropic-messages` | 使用 Anthropic Messages API 格式 |
| **Base URL** | `https://api.kimi.com/coding/` | Kimi 专用编码 API 端点 |
| **User-Agent** | `claude-code/0.1.0` | 伪装成 Claude Code |
| **工具 Schema 格式** | `anthropicToolSchemaMode: "native"` | 原生 Anthropic 工具格式 |
| **工具选择格式** | `anthropicToolChoiceMode: "native"` | 原生 Anthropic 工具选择 |
| **思考签名** | `preserveAnthropicThinkingSignatures: false` | 不保留 thinking 块签名 |

**工具请求格式**（标准 Anthropic 格式）：
```json
{
  "tools": [
    {
      "name": "bash",
      "description": "Execute bash command",
      "input_schema": { ... }
    }
  ],
  "tool_choice": { "type": "auto" }
}
```

## 代码中的适配逻辑

- `shared/llm/providers/kimi_coding.json` 声明 `api_style: "anthropic-messages"`、`base_url: "https://api.kimi.com/coding/"` 和默认 headers。
- `agent_runtime/tool_schema_adapter.py` 将内部工具 schema 转为 Anthropic 的 `input_schema` 格式。
- `shared/llm/transports/anthropic_sdk_stream.py` 通过 Anthropic SDK 调用 `/v1/messages` 并解析 streaming 事件。

**工具格式转换**：
- Kimi Code 使用原生 Anthropic 工具格式，不需要转换
- 其他非原生 Anthropic 提供商（如 Bedrock、Vertex）可能需要转换为 OpenAI Functions 格式

## 总结

**Kimi Code** 实际上**直接使用 Anthropic 的原生工具格式**，通过 `anthropic-messages` API 类型发送请求到 `api.kimi.com/coding/`。这意味着：

1. 工具请求的 **JSON 结构**与 Anthropic Claude 完全相同
2. **URL 不同**：`https://api.kimi.com/coding/` 而非 `https://api.anthropic.com/v1`
3. **User-Agent 伪装**：发送 `claude-code/0.1.0` 作为 User-Agent
4. 不保留 Anthropic 的 thinking 签名（`preserveAnthropicThinkingSignatures: false`）

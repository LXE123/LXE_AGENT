kimi-code
现在我可以给你完整的答案了。

## Kimi Code / Moonshot 的工具请求特别适配

### 1. Kimi Code（Kimi Coding API）

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

### 2. Moonshot（标准 Kimi API）

| 配置项 | 值 | 说明 |
|--------|-----|------|
| **API 类型** | `openai-completions` | 使用 OpenAI Completions API 格式 |
| **Base URL** | `https://api.moonshot.ai/v1` | 标准 Moonshot API 端点 |
| **工具格式** | OpenAI Functions | 标准 OpenAI 工具格式 |
| **流式 usage** | 原生支持（自动启用） | 仅对原生端点自动启用 |

**工具请求格式**（标准 OpenAI 格式）：
```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Execute bash command",
        "parameters": { ... }
      }
    }
  ],
  "tool_choice": "auto"
}
```

### 3. 关键区别

| 特性 | Kimi Code | Moonshot |
|------|-----------|----------|
| **API 协议** | Anthropic Messages | OpenAI Completions |
| **工具字段名** | `input_schema` | `parameters` |
| **工具类型标识** | 无（隐式） | `type: "function"` |
| **工具选择格式** | `{type: "auto"}` | `"auto"` 字符串 |
| **端点 URL** | `/coding/` 专用端点 | 标准 `/v1` 端点 |
| **模型 ID** | `kimi-code`, `k2p5` | `kimi-k2.5` |

### 4. 代码中的适配逻辑

```typescript
// provider-catalog.ts - Kimi Code 配置
buildKimiCodingProvider() {
  return {
    baseUrl: "https://api.kimi.com/coding/",
    api: "anthropic-messages",  // ← 关键区别
    headers: { "User-Agent": "claude-code/0.1.0" },
    ...
  };
}

// provider-catalog.ts - Moonshot 配置  
buildMoonshotProvider() {
  return {
    baseUrl: "https://api.moonshot.ai/v1",
    api: "openai-completions",  // ← 关键区别
    ...
  };
}
```

**工具格式转换**（在 `anthropic-stream-wrappers.ts` 中）：
- Kimi Code 使用原生 Anthropic 工具格式，不需要转换
- 其他非原生 Anthropic 提供商（如 Bedrock、Vertex）可能需要转换为 OpenAI Functions 格式

### 5. 总结

**Kimi Code** 实际上**直接使用 Anthropic 的原生工具格式**，通过 `anthropic-messages` API 类型发送请求到 `api.kimi.com/coding/`。这意味着：

1. 工具请求的 **JSON 结构**与 Anthropic Claude 完全相同
2. **URL 不同**：`https://api.kimi.com/coding/` 而非 `https://api.anthropic.com/v1`
3. **User-Agent 伪装**：发送 `claude-code/0.1.0` 作为 User-Agent
4. 不保留 Anthropic 的 thinking 签名（`preserveAnthropicThinkingSignatures: false`）

**Moonshot** 则使用标准的 **OpenAI API 格式**，工具请求与普通 OpenAI 兼容模型相同。
# Tool Schema

状态：Current

## 目的

这篇文档解释 runtime 如何把内部工具定义变成模型可调用的 tool schema。读者如果在排查一个工具为什么出现在可用工具列表里、参数 schema 为什么这样发送给 provider、browser planner tool 如何进入统一 registry，应该读这一篇。

## 设计理念

Tool schema 被分成两层：runtime 内部只维护 canonical `ToolSchema`，provider 请求前再适配成具体 wire format。这样工具注册、system prompt 摘要、provider schema 和 tool call/result 消息不会绑死在某一家模型 API 的格式上。

## 链路位置

这一层位于 context assembly 和 LLM adapter 之间。`AgentLoop` 先从 tool registry 取本轮 active schemas，system prompt 只展示简短工具摘要，完整 schema 则在 provider adapter 中转换后随请求发送；模型返回 tool call 后，执行生命周期见 [Tool Execution](tool_execution.md)。

本文说明当前 runtime 内部 tool schema 的 canonical 格式，以及发送给 agent LLM provider 前的 schema 适配。事实来源：

- [agent_runtime/types.py](../../../../agent_runtime/types.py)
- [agent_runtime/tool_registry.py](../../../../agent_runtime/tool_registry.py)
- [agent_runtime/tool_schema_adapter.py](../../../../agent_runtime/tool_schema_adapter.py)
- [agent_runtime/llm_adapter.py](../../../../agent_runtime/llm_adapter.py)

## Canonical ToolSchema

内部唯一的 tool schema 类型是：

```python
class ToolSchema(TypedDict):
    name: str
    description: str
    parameters: dict[str, Any]
```

含义：

- `name`：模型调用工具时使用的工具名。
- `description`：工具用途说明。
- `parameters`：JSON Schema 风格参数定义。

`ToolDefinition` 在 schema 之外还保存 handler 和资源要求：

```python
ToolDefinition(
    name="read",
    description="...",
    parameters={...},
    handler=...,
    requires_resource=None,
    source="builtin",
    exposure="direct",
)
```

这些执行侧字段不会直接发送给模型。MCP 工具会额外保存 `mcp_route`、server/connector 展示信息、`search_text` 和 `exposure`，用于把模型可见名路由回原始 MCP server/tool。

## Registry 输出

`UnifiedToolRegistry.tool_schemas()` 从已注册的 `ToolDefinition` 生成 canonical schemas：

```json
{
  "name": "read",
  "description": "...",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

浏览器 planner tools 的原始 schema 使用 `input_schema` 字段；注册到 runtime 时会转换成 `ToolDefinition.parameters`，之后统一以 canonical `parameters` 参与后续流程。

## MCP ToolInfo Projection

MCP 连接层每个 turn 根据 `config/mcp_servers.local.yaml` 或 `LXE_MCP_CONFIG_PATH` 构建 runtime。每个启用的 server 完成 `initialize -> tools/list` 后，工具会先变成内部 `McpToolInfo`：

- `server_name` / `raw_tool_name`：执行时回调 MCP server 的原始身份。
- `callable_namespace` / `callable_name`：归一化前的模型身份。
- `model_name`：Anthropic 当前实际可见工具名，形如 `mcp__{namespace}__{tool}`，会 sanitize、去重、hash 并限制在 64 bytes 内。
- `input_schema`：MCP `inputSchema` 修补为 object schema，缺失 `properties` 时补 `{}`。
- `exposure` / `search_text`：决定直接暴露还是通过 `tool_search` 延迟加载。

当前 provider 仍是 Anthropic Messages，不支持 Responses API namespace tools，所以 namespace 被压平成单个 tool name；raw MCP route 只留在执行元数据中。

## System Prompt 中的 Tool Summary

`build_system_prompt()` 不把完整参数 schema 拼进 system prompt。它只用 `_tool_summary_block()` 生成简短摘要：

```text
- read: Read file contents
- exec: Run shell commands with optional background sessions
```

摘要只用于让模型知道有哪些工具类别。完整 schema 走 provider request 的 tools 顶层字段。

如果启用 deferred MCP tools，初始摘要通常只包含 `tool_search` 和直接暴露工具。模型调用 `tool_search` 后，匹配到的 MCP 工具会在下一次 LLM step 的 provider tools 字段中出现。

## Provider Schema Adaptation

当前 agent LLM adapter 支持的运行路径是 `anthropic-messages`。`chat_with_tools_streaming()` 会先调用：

```python
adapt_tool_schemas(tool_schemas, desc.api_style)
```

当 `api_style == "anthropic-messages"` 时，canonical schema 会转换为：

```json
{
  "name": "read",
  "description": "...",
  "input_schema": {
    "type": "object",
    "properties": {}
  }
}
```

也就是只在 provider 边界把 `parameters` 改名为 Anthropic Messages API 使用的 `input_schema`。

如果传入其它 `api_style`，`adapt_tool_schemas()` 当前会抛出 `Unsupported tool schema api_style`。因此 OpenAI function calling 不是当前 agent runtime 的已接入路径，不应在本目录写成当前事实。

## Tool Calls 与 Tool Results

schema 描述工具可怎么调用；真正的调用和结果由 [Tool Execution](tool_execution.md) 负责，并进入 canonical messages：

- assistant 发起：`{"type": "tool_call", "id": "...", "name": "...", "arguments": {...}}`
- tool 返回：`{"type": "tool_result", "tool_call_id": "...", "content": "..."}`

发送给 Anthropic provider 前，message adapter 会把内部 `tool_call` 转成 `tool_use`，把内部 `tool_result` 转成 user content 中的 `tool_result`。

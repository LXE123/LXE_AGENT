# Tool Schema and Exposure

状态：Current

`ToolDefinition` 包含 schema、source、exposure、ownerSkills 与 connectorName。原生 direct 工具立即进入 provider tools；MCP 与 script tools 默认 deferred。`tool_search` 按名称、raw name、description 和参数搜索，并从下一 step 暴露命中项。

读取 skill manifest 会激活该 skill 的 owner tools。Bot skill types、connector enabled state、MCP allow/deny list 共同决定最终可见 schema。

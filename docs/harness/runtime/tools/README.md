# Runtime Tools

状态：Current

工具统一注册到 [`ToolRegistry`](/packages/runtime/src/tools.ts)，来源为 `native|mcp|script`，暴露方式为 `direct|deferred`。重名注册直接失败。

- [Tool Schema](tool_schema.md)
- [Tool Execution](tool_execution.md)

Coding tools 在 Bun 内原生执行；MCP 使用官方 v1 SDK；业务 Python 只通过 JSON bridge 调用。

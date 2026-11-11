// Public MCP API. Configuration, transport, lifecycle and tool adaptation live separately.
export * from "./mcp/types";
export * from "./mcp/config";
export * from "./mcp/connector";
export * from "./mcp/manager";
export { adaptMcpTools } from "./mcp/tool-adapter";
export { mcpNamespace, mcpServerPrefix, mcpToolName } from "./mcp/naming";

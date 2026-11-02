// Public MCP API. Configuration, transport, lifecycle and tool adaptation live separately.
export * from "./mcp/types";
export * from "./mcp/config";
export * from "./mcp/connector";
export * from "./mcp/manager";
export { adaptMcpTools, mcpServerPrefix, mcpToolName } from "./mcp/tool-adapter";

import type { JsonObject } from "@lxe/protocol";
import type { ToolExposure } from "../registry";

export type McpTransportKind = "stdio" | "streamable-http";
export type McpProtocolMode = "auto" | "legacy" | "2026-07-28";

export interface McpServerConfig {
  name: string;
  /** Supplied only by the host, never loaded from user MCP configuration. */
  callerMetadataKey?: string;
  platforms?: readonly string[];
  enabled: boolean;
  transport: McpTransportKind;
  protocolMode?: McpProtocolMode;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  envHeaders: Record<string, string>;
  bearerTokenEnvVar: string;
  connectorId: string;
  connectorName: string;
  connectorDescription: string;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools: Set<string>;
  disabledTools: Set<string>;
  exposure: ToolExposure;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface McpConnection {
  tools: McpRemoteTool[];
  /** Subscribe to transport closure; late subscribers are notified immediately. */
  onClose?(listener: () => void): () => void;
  protocolVersion?: string;
  protocolEra?: "modern" | "legacy";
  callTool(name: string, arguments_: JsonObject, signal?: AbortSignal, metadata?: JsonObject): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpCallResult {
  content: JsonObject[];
  structuredContent?: unknown;
  meta?: JsonObject;
  isError: boolean;
}

export interface McpConnector {
  connect(server: McpServerConfig, signal?: AbortSignal): Promise<McpConnection>;
}

export type McpConnectionState = "configured" | "disabled" | "connecting" | "ready" | "error" | "disconnected";

export interface McpServerStatus {
  state: McpConnectionState;
  connected: boolean;
  /** Last observed failure; a tool failure alone does not change connection state. */
  error: string;
  toolCount: number;
  tools: Array<{ rawName: string; modelName: string }>;
}

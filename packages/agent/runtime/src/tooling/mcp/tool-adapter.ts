import type { JsonObject } from "@lxe/protocol";
import { ToolExecutionError, unknownToolFailureDetails, type ToolDefinition } from "../registry";
import type { McpCallResult, McpConnection, McpRemoteTool, McpServerConfig } from "./types";
import { mapping, mcpFailureText, withTimeout } from "./support";

const safeName = (value: string, fallback: string): string => value.trim().replaceAll(/[^A-Za-z0-9_-]+/g, "_").replaceAll(/_+/g, "_").replaceAll(/^_+|_+$/g, "") || fallback;
export const mcpServerPrefix = (serverName: string): string => `mcp__${safeName(serverName, "mcp")}__`;
export const mcpToolName = (serverName: string, toolName: string): string => {
  const value = `${mcpServerPrefix(serverName)}${safeName(toolName, "tool")}`;
  if (new TextEncoder().encode(value).byteLength <= 64) return value;
  const suffix = `_${new Bun.CryptoHasher("sha1").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 10)}`;
  return `${value.slice(0, Math.max(1, 64 - suffix.length)).replaceAll(/[_-]+$/g, "")}${suffix}`;
};

const uniqueMcpToolName = (serverName: string, toolName: string, used: ReadonlySet<string>): string => {
  const candidate = mcpToolName(serverName, toolName);
  if (!used.has(candidate)) return candidate;
  for (let index = 0; ; index++) {
    const seed = `${serverName}\0${toolName}${index === 0 ? "" : `\0${index}`}`;
    const suffix = `_${new Bun.CryptoHasher("sha1").update(seed).digest("hex").slice(0, 10)}`;
    const name = `${candidate.slice(0, 64 - suffix.length).replaceAll(/[_-]+$/g, "")}${suffix}`;
    if (!used.has(name)) return name;
  }
};

const safeMcpContent = (result: McpCallResult): JsonObject[] => {
  const content = result.content.map((raw): JsonObject => {
    const block = mapping(raw);
    const type = String(block.type ?? "").trim();
    if (type === "text") return { type: "text", text: String(block.text ?? "") };
    if (type === "image" && typeof block.data === "string") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: String(block.mimeType ?? block.mime_type ?? "application/octet-stream"),
          data: block.data,
        },
      };
    }
    if (type === "resource") {
      const resource = mapping(block.resource);
      if (typeof resource.text === "string") return { type: "text", text: resource.text };
      return { type: "text", text: `[MCP resource: ${String(resource.uri ?? "unknown")}]` };
    }
    if (type === "audio") {
      return { type: "text", text: `[MCP audio: ${String(block.mimeType ?? "unknown")}, ${String(block.data ?? "").length} base64 chars]` };
    }
    if (type === "resource_link") {
      return { type: "text", text: `[MCP resource link: ${String(block.name ?? block.uri ?? "unknown")}] ${String(block.uri ?? "")}`.trim() };
    }
    const text = JSON.stringify(block);
    return { type: "text", text: `[MCP ${type || "unknown"} block] ${text.length > 8_000 ? `${text.slice(0, 8_000)} [${text.length - 8_000} chars omitted]` : text}` };
  });
  if (result.structuredContent !== undefined) {
    content.push({ type: "text", text: `[MCP structured content]\n${JSON.stringify(result.structuredContent)}` });
  }
  return content;
};

/** Adapt definitions and calls; registry ownership and connection lifetime belong to the manager. */
export function adaptMcpTools(
  server: McpServerConfig,
  tools: readonly McpRemoteTool[],
  callTool: McpConnection["callTool"],
  usedNames: ReadonlySet<string> = new Set(),
  onError: (observed: string) => void = () => {},
): ToolDefinition[] {
  const used = new Set(usedNames);
  const rawNames = new Set<string>();
  return tools.flatMap((tool): ToolDefinition[] => {
    if (!tool.name.trim() || server.disabledTools.has(tool.name)) return [];
    if (server.enabledTools.size > 0 && !server.enabledTools.has(tool.name)) return [];
    if (rawNames.has(tool.name)) throw new Error(`duplicate MCP tool name from ${server.name}: ${tool.name}`);
    rawNames.add(tool.name);
    const modelName = uniqueMcpToolName(server.name, tool.name, used);
    used.add(modelName);
    return [{
      name: modelName,
      rawName: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      source: "mcp",
      ...(server.platforms ? { platforms: server.platforms } : {}),
      exposure: server.exposure,
      connectorName: server.name,
      execute: async (input, context) => {
        try {
          if (server.platforms && (!context.platform || !server.platforms.includes(context.platform))) throw new Error("This MCP server is not available to this conversation source");
          const metadata = server.callerMetadataKey ? { [server.callerMetadataKey]: {
            session_id: context.session_id, turn_id: context.turn_id ?? "", tool_call_id: context.tool_call_id ?? "", platform: context.platform ?? "",
          } } : undefined;
          const result = await withTimeout(
            signal => callTool(tool.name, input, signal, metadata),
            server.toolTimeoutMs,
            `MCP tool ${server.name}/${tool.name}`,
            context.signal ?? context.handle.signal,
          );
          if (result.isError) {
            const preview = safeMcpContent(result).map(block => String(block.text ?? "")).filter(Boolean).join("\n");
            throw new Error(preview || `MCP tool ${server.name}/${tool.name} returned isError=true`, { cause: result });
          }
          return { content: safeMcpContent(result) };
        } catch (error) {
          const observed = mcpFailureText(error);
          onError(observed);
          if (context.handle.signal.aborted || context.signal?.aborted) throw error;
          const failure = new ToolExecutionError("unclassified", observed, {
            ...unknownToolFailureDetails(modelName, error), observed_message: observed,
          });
          failure.cause = error;
          throw failure;
        }
      },
    }];
  });
}

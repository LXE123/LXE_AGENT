import type { JsonObject } from "@lxe/protocol";
import { sanitizeLogValueWithPolicy } from "@lxe/core";
import { ToolExecutionError, unknownToolFailureDetails, type ToolDefinition } from "../registry";
import type { McpCallResult, McpConnection, McpRemoteTool, McpServerConfig } from "./types";
import { uniqueMcpToolName } from "./naming";
import { mapping, mcpFailureText, withTimeout } from "./support";

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
  const visible = tools.filter(tool => tool.name.trim() && !server.disabledTools.has(tool.name)
    && (!server.enabledTools.size || server.enabledTools.has(tool.name)));
  const modelNames = new Map<string, string>();
  // A server can return the same tools in another order after a reconnect.
  // Allocate collision suffixes in raw-name order, then preserve its listing order.
  for (const raw of visible.map(tool => tool.name).sort()) {
    if (modelNames.has(raw)) throw new Error(`duplicate MCP tool name from ${server.name}: ${raw}`);
    const modelName = uniqueMcpToolName(server.name, raw, used);
    used.add(modelName);
    modelNames.set(raw, modelName);
  }
  return visible.map((tool): ToolDefinition => {
    const modelName = modelNames.get(tool.name)!;
    return {
      name: modelName,
      rawName: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      source: "mcp",
      ...(server.platforms ? { platforms: server.platforms } : {}),
      exposure: server.exposure,
      connectorName: server.name,
      connectorDescription: server.connectorDescription,
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
          const scriptCall = context.exposureState?.scope === "codemode";
          if (result.isError) {
            const text = safeMcpContent(result).map(block => block.text).filter(Boolean).join("\n");
            const reason = text || `MCP tool ${server.name}/${tool.name} returned isError=true`;
            if (!scriptCall) throw new Error(reason, { cause: result });
            onError(mcpFailureText(reason));
          }
          if (scriptCall) {
            const { meta: _meta, ...payload } = result;
            // Scripts inspect complete results, including binary blocks and nested data.
            // Keep credential redaction for errors; the separate diagnostic above is bounded.
            return result.isError ? sanitizeLogValueWithPolicy(payload, {
              maxString: Infinity, maxItems: Infinity, maxDepth: Infinity,
            }) as McpCallResult : payload;
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
    };
  });
}

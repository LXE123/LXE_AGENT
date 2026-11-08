import { Client, StreamableHTTPClientTransport, type ClientOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { JsonObject } from "@lxe/protocol";
import type { Environment } from "@lxe/core";
import type { McpConnection, McpConnector, McpRemoteTool, McpServerConfig } from "./types";
import { resolveMcpHttpHeaders } from "./config";
import { mapping } from "./support";

type McpSdkClientPort = Pick<Client,
  "connect" | "close" | "onclose" | "listTools" | "callTool" | "getNegotiatedProtocolVersion" | "getProtocolEra"
> & Partial<Pick<Client, "getInstructions">>;

export class OfficialMcpConnector implements McpConnector {
  constructor(
    private readonly environment: Environment = process.env,
    private readonly clientFactory: (options: ClientOptions) => McpSdkClientPort = options => new Client({ name: "lxe-agent", version: "0.1.0" }, options),
  ) {}

  async connect(server: McpServerConfig, signal?: AbortSignal): Promise<McpConnection> {
    const headers = server.transport === "streamable-http" ? resolveMcpHttpHeaders(server, this.environment) : {};
    signal?.throwIfAborted();
    const mode = server.protocolMode ?? "auto";
    const client = this.clientFactory({
      versionNegotiation: {
        mode: mode === "2026-07-28" ? { pin: mode } : mode,
        probe: { timeoutMs: Math.max(1, Math.min(2_000, Math.floor(server.startupTimeoutMs / 2))), maxRetries: 0 },
      },
    });
    let closed = false;
    const closeListeners = new Set<() => void>();
    client.onclose = () => {
      closed = true;
      for (const listener of closeListeners) listener();
      closeListeners.clear();
    };
    const transport = server.transport === "stdio"
      ? new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...this.environment, ...server.env } as Record<string, string>,
        ...(server.cwd ? { cwd: server.cwd } : {}),
      })
      : new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers },
      });
    // During v2 discovery the transport is not yet attached to Client. Closing
    // only Client would let the sibling probe finish and spawn a session later.
    const closeOnAbort = (): void => {
      void transport.close().catch(() => undefined);
      void client.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      await client.connect(transport, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      // v2 aggregates pages, detects cursor loops and bounds the walk.
      const listed = await client.listTools(undefined, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      const tools: McpRemoteTool[] = listed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        // The SDK validates wire JSON but its extensible schema type uses unknown.
        inputSchema: tool.inputSchema as JsonObject,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema as JsonObject } : {}),
      }));
      const protocolVersion = client.getNegotiatedProtocolVersion();
      const instructions = client.getInstructions?.();
      const protocolEra = client.getProtocolEra();
      return {
        tools,
        ...(instructions ? { instructions } : {}),
        onClose: listener => {
          if (closed) listener();
          else closeListeners.add(listener);
          return () => { closeListeners.delete(listener); };
        },
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(protocolEra === undefined ? {} : { protocolEra }),
        callTool: async (name, arguments_, signal, metadata) => {
          const result = await client.callTool({ name, arguments: arguments_, ...(metadata ? { _meta: metadata } : {}) }, signal ? { signal } : {});
          const content = Array.isArray(result.content)
            ? result.content.map(mapping).filter((item) => Object.keys(item).length > 0) as JsonObject[]
            : [];
          const { _meta, isError, ...payload } = result;
          return { ...payload, content, ...(isError !== undefined ? { isError } : {}),
            ...(Object.keys(mapping(_meta)).length ? { meta: mapping(_meta) as JsonObject } : {}) };
        },
        close: () => client.close(),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
    }
  }
}

import { Client, extractWWWAuthenticateParams, SdkHttpError, StreamableHTTPClientTransport, type ClientOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { JsonObject } from "@lxe/protocol";
import type { Environment, Logger } from "@lxe/core";
import type { McpConnection, McpConnector, McpRemoteTool, McpServerConfig } from "./types";
import { resolveMcpHttpHeaders } from "./config";
import { mapping, mcpFailureText } from "./support";
import { McpConnectionDiagnostics } from "./connection-diagnostics";

type McpSdkClientPort = Pick<Client,
  "connect" | "close" | "onclose" | "listTools" | "callTool" | "getNegotiatedProtocolVersion" | "getProtocolEra"
> & Partial<Pick<Client, "getInstructions" | "getServerCapabilities">>;

export interface McpOAuthChallenge { url: string; resourceMetadataUrl?: string; scope?: string }

export class McpLoginRequired extends Error {
  constructor(readonly challenge: McpOAuthChallenge, readonly original: unknown) {
    super(mcpFailureText(original), { cause: original });
  }
}

export class OfficialMcpConnector implements McpConnector {
  constructor(
    private readonly environment: Environment = process.env,
    private readonly clientFactory: (options: ClientOptions) => McpSdkClientPort = options => new Client({ name: "lxe-agent", version: "0.1.0" }, options),
    private readonly accessToken?: (name: string, url: string, rejectedToken?: string) => string | undefined | Promise<string | undefined>,
    private readonly logger?: Logger,
  ) {}

  async connect(server: McpServerConfig, signal?: AbortSignal): Promise<McpConnection> {
    const headers = server.transport === "streamable-http" ? resolveMcpHttpHeaders(server, this.environment) : {};
    const oauth = server.transport === "streamable-http" && !new Headers(headers).has("authorization");
    let challenge: McpOAuthChallenge | undefined;
    signal?.throwIfAborted();
    const diagnostics = new McpConnectionDiagnostics(server, this.logger);
    for (const value of Object.values(headers)) {
      diagnostics.rememberSecret(value);
      if (/^Bearer /i.test(value)) diagnostics.rememberSecret(value.slice(7));
    }
    const credential = (rejectedToken?: string) => diagnostics.measure(rejectedToken ? "oauth_refresh" : "oauth_credentials", async () => {
      const token = await this.accessToken?.(server.name, server.url, rejectedToken);
      diagnostics.rememberSecret(token);
      return token;
    });
    const mode = server.protocolMode ?? "auto";
    const client = this.clientFactory({
      versionNegotiation: {
        mode: mode === "2026-07-28" ? { pin: mode } : mode,
        // A remote probe can take the available startup budget. Stdio needs time to spawn its legacy fallback.
        probe: { timeoutMs: server.transport === "streamable-http" ? server.startupTimeoutMs
          : Math.max(1, Math.min(2_000, Math.floor(server.startupTimeoutMs / 2))), maxRetries: 0 },
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
        fetch: async (input, init) => {
          if (!oauth || new URL(input).href !== new URL(server.url).href) return diagnostics.fetch(input, init);
          const send = (token?: string) => {
            const requestHeaders = new Headers(init?.headers);
            if (token) requestHeaders.set("Authorization", "Bearer " + token);
            return diagnostics.fetch(input, { ...init, headers: requestHeaders });
          };
          const token = await credential();
          let response = await send(token);
          if (response.status === 401) {
            const params = extractWWWAuthenticateParams(response);
            const rejectedChallenge = { url: server.url, ...(params.scope && { scope: params.scope }),
              ...(params.resourceMetadataUrl && { resourceMetadataUrl: params.resourceMetadataUrl.href }) };
            if (token && params.error !== "insufficient_scope") {
              init?.signal?.throwIfAborted();
              let replacement: string | undefined;
              try { replacement = await credential(token); }
              catch (error) {
                await response.body?.cancel();
                const failure = new Error("MCP HTTP 401; OAuth refresh failed: " + (error instanceof Error ? error.message : String(error)), { cause: error });
                // A rejected grant needs consent; a failed network request to the issuer does not.
                if (error instanceof McpLoginRequired) {
                  challenge = rejectedChallenge;
                  throw new McpLoginRequired(rejectedChallenge, failure);
                }
                throw failure;
              }
              if (replacement && replacement !== token) {
                await response.body?.cancel();
                response = await send(replacement);
              }
            }
            // Keep only an unresolved challenge, including one returned by the refreshed request.
            if (response.status === 401) {
              const final = extractWWWAuthenticateParams(response);
              challenge = { ...rejectedChallenge, ...(final.scope && { scope: final.scope }),
                ...(final.resourceMetadataUrl && { resourceMetadataUrl: final.resourceMetadataUrl.href }) };
            } else challenge = undefined;
          }
          return response;
        },
      });
    // Keep the SDK's exact stdio transport: its auto negotiation owns a disposable
    // probe subprocess. HTTP can expose individual RPC stages through Transport.
    const connectionTransport = server.transport === "streamable-http" ? diagnostics.httpTransport(transport) : transport;
    // During v2 discovery the transport is not yet attached to Client. Closing
    // only Client would let the sibling probe finish and spawn a session later.
    const closeOnAbort = (): void => {
      diagnostics.finish(signal?.reason, { aborted: true });
      void transport.close().catch(() => undefined);
      void client.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      await diagnostics.measure("connect", () => client.connect(connectionTransport, signal ? { signal } : undefined), { scope: "sdk" });
      signal?.throwIfAborted();
      // v2 aggregates pages, detects cursor loops and bounds the walk.
      const capabilities = client.getServerCapabilities?.();
      const listed = capabilities && !capabilities.tools ? { tools: [] }
        : await diagnostics.measure("tool_discovery", () => client.listTools(undefined, signal ? { signal } : undefined), { scope: "sdk" });
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
      diagnostics.finish(undefined, { tool_count: tools.length, protocol_version: protocolVersion, protocol_era: protocolEra });
      return {
        tools,
        ...(capabilities?.resources && { resources: true }),
        ...(instructions ? { instructions } : {}),
        onClose: listener => {
          if (closed) listener();
          else closeListeners.add(listener);
          return () => { closeListeners.delete(listener); };
        },
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(protocolEra === undefined ? {} : { protocolEra }),
        callTool: async (name, arguments_, signal, metadata) => {
          let result;
          try {
            result = await client.callTool({ name, arguments: arguments_, ...(metadata ? { _meta: metadata } : {}) }, signal ? { signal } : {});
          } catch (error) {
            if (oauth && error instanceof SdkHttpError && error.status === 401) {
              throw new McpLoginRequired(challenge ?? { url: server.url }, error);
            }
            throw error;
          }
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
      diagnostics.finish(error);
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      if (challenge) throw new McpLoginRequired(challenge, error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
    }
  }
}

import { randomUUID } from "node:crypto";
import { harnessFetch } from "../../network/fetch";
import { ProtocolError, SdkError, type Transport } from "@modelcontextprotocol/client";
import { createLogger, currentLogContext, sanitizeLogValueWithPolicy, type Logger, type LogFields } from "@lxe/core";
import type { McpServerConfig } from "./types";

/** Startup-only diagnostics. Never records request parameters, tool definitions or credentials. */
export class McpConnectionDiagnostics {
  private readonly logger: Logger;
  private readonly started = performance.now();
  private readonly pending = new Set<(error?: unknown) => void>();
  private readonly secrets = new Set<string>();
  private active = true;

  constructor(server: McpServerConfig, logger = createLogger("runtime.mcp.connection")) {
    this.logger = logger.child({ ...currentLogContext(), server_name: server.name, transport: server.transport,
      connection_attempt_id: randomUUID() });
    if (server.url) {
      const url = new URL(server.url);
      this.rememberSecret(url.username); this.rememberSecret(url.password);
      for (const value of url.searchParams.values()) this.rememberSecret(value);
    }
    this.logger.info("mcp_connection_started", { protocol_mode: server.protocolMode ?? "auto", startup_timeout_ms: server.startupTimeoutMs });
  }

  rememberSecret(value: string | undefined): void { if (this.active && value) this.secrets.add(value); }

  private errorFields(error: unknown): LogFields {
    const sanitized = sanitizeLogValueWithPolicy({ error,
      ...(error instanceof SdkError || error instanceof ProtocolError ? { error_code: error.code, error_data: error.data } : {}),
    }, { maxString: 8_000 });
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") {
        for (const secret of this.secrets) value = (value as string).replaceAll(secret, "[redacted]");
        return value;
      }
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
      return value;
    };
    return redact(sanitized) as LogFields;
  }

  begin(stage: string, fields: LogFields = {}): (error?: unknown) => void {
    if (!this.active) return () => {};
    const started = performance.now();
    this.logger.info("mcp_connection_stage_started", { stage, ...fields });
    const done = (error?: unknown) => {
      if (!this.pending.delete(done)) return;
      const result = { stage, ...fields, duration_ms: Math.round(performance.now() - started),
        ...(error === undefined ? {} : this.errorFields(error)) };
      if (error === undefined) this.logger.info("mcp_connection_stage_completed", result);
      else this.logger.warn("mcp_connection_stage_failed", result);
    };
    this.pending.add(done);
    return done;
  }

  async measure<T>(stage: string, operation: () => Promise<T>, fields: LogFields = {}): Promise<T> {
    const done = this.begin(stage, fields);
    try { const result = await operation(); done(); return result; }
    catch (error) { done(error); throw error; }
  }

  finish(error?: unknown, fields: LogFields = {}): void {
    if (!this.active) return;
    this.active = false;
    // Abort reports the actual timeout/cancellation reason before transport.close()
    // can replace it with a generic connection-closed error.
    for (const done of this.pending) done(error);
    const result = { duration_ms: Math.round(performance.now() - this.started), ...fields,
      ...(error === undefined ? {} : this.errorFields(error)) };
    if (error === undefined) this.logger.info("mcp_connection_completed", result);
    else this.logger.warn("mcp_connection_failed", result);
  }

  async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    if (!this.active) return harnessFetch(input, init);
    const started = performance.now();
    let rpcMethod: string | undefined;
    let rpcId: string | number | undefined;
    if (typeof init?.body === "string") {
      try {
        const message = JSON.parse(init.body);
        rpcMethod = message.method;
        rpcId = message.id;
      } catch { /* No request body is logged. */ }
    }
    const fields = { http_method: init?.method ?? "GET", rpc_method: rpcMethod, rpc_id: rpcId };
    this.logger.info("mcp_connection_http_started", fields);
    try {
      const response = await harnessFetch(input, init);
      if (this.active) this.logger.info("mcp_connection_http_response", { ...fields,
        headers_duration_ms: Math.round(performance.now() - started), http_status: response.status,
        content_type: response.headers.get("content-type") });
      return response;
    } catch (error) {
      if (this.active) this.logger.warn("mcp_connection_http_failed", { ...fields,
        duration_ms: Math.round(performance.now() - started), ...this.errorFields(error) });
      throw error;
    }
  }

  /** Observe the public HTTP Transport contract, including replies delivered later over SSE. */
  httpTransport(transport: Transport): Transport {
    const requests = new Map<string | number, (error?: unknown) => void>();
    const observed: Transport = {
      start: () => this.measure("transport_start", () => transport.start()),
      close: () => transport.close(),
      get sessionId() { return transport.sessionId; },
      get hasPerRequestStream() { return transport.hasPerRequestStream ?? false; },
      setProtocolVersion: version => transport.setProtocolVersion?.(version),
      setSupportedProtocolVersions: versions => transport.setSupportedProtocolVersions?.(versions),
      send: async (message, options) => {
        if (!this.active || !("method" in message)) return transport.send(message, options);
        const done = this.begin(message.method, { scope: "rpc", ...("id" in message ? { rpc_id: message.id } : {}) });
        if ("id" in message) requests.set(message.id, done);
        try {
          await transport.send(message, options);
          if (!("id" in message)) done();
        } catch (error) {
          if ("id" in message) requests.delete(message.id);
          done(error);
          throw error;
        }
      },
    };
    transport.onmessage = (message, extra) => {
      if ("id" in message && !("method" in message) && message.id != null) {
        requests.get(message.id)?.("error" in message ? message.error : undefined);
        requests.delete(message.id);
      }
      observed.onmessage?.(message, extra);
    };
    transport.onerror = error => {
      if (this.active) this.logger.warn("mcp_connection_transport_error", this.errorFields(error));
      observed.onerror?.(error);
    };
    transport.onclose = () => observed.onclose?.();
    return observed;
  }
}

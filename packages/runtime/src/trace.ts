import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonObject, JsonValue } from "@lxe/protocol";
import { createLogger, envFlag, envText, sanitizeLogValue, type Environment } from "@lxe/core";

const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?:home|Users|var|tmp)\/)[^\s"']+/gu;
const logger = createLogger("runtime.trace");

const traceValue = (value: unknown): JsonValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/u.test(value)) return `[base64 omitted: ${value.length} chars]`;
    const redacted = value.replaceAll(ABSOLUTE_PATH, "<path>");
    return redacted;
  }
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(traceValue);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, traceValue(item)])) as JsonObject;
};

export function sanitizeTraceValue(value: unknown, key = ""): JsonValue {
  return traceValue(sanitizeLogValue(value, key));
}

export interface RuntimeTracePort {
  record(kind: string, payload?: JsonObject): void;
  wire(kind: string, payload?: JsonObject): void;
}

export interface RuntimeTraceControllerPort {
  startTurn(sessionId: string, turnId: string): RuntimeTracePort;
}

class FileRuntimeTrace implements RuntimeTracePort {
  private readonly failed = new Set<string>();

  constructor(private readonly tracePath?: string, private readonly wirePath?: string) {}

  record(kind: string, payload: JsonObject = {}): void {
    this.write(this.tracePath, kind, payload);
  }

  wire(kind: string, payload: JsonObject = {}): void {
    this.write(this.wirePath, kind, payload);
  }

  private write(path: string | undefined, kind: string, payload: JsonObject): void {
    if (!path || this.failed.has(path)) return;
    try {
      appendFileSync(path, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        kind,
        payload: sanitizeTraceValue(payload),
      })}\n`, "utf8");
    } catch (error) {
      this.failed.add(path);
      logger.warn("runtime_trace_write_failed", { trace_kind: kind, trace_path: path, error });
    }
  }
}

export function configureRuntimeTracing(options: {
  projectRoot: string;
  environment: Environment;
}): RuntimeTraceControllerPort {
  const enabled = envFlag(options.environment, "LOCAL_LOGS_ENABLED", false);
  const traceEnabled = enabled && envFlag(options.environment, "AGENT_STREAM_TRACE_ENABLED", true);
  const wireEnabled = enabled && envFlag(options.environment, "AGENT_SSE_WIRE_TRACE_ENABLED", true);
  const traceRoot = resolve(options.projectRoot, envText(options.environment, "AGENT_STREAM_TRACE_DIR", "logs/agent_traces"));
  const wireRoot = resolve(options.projectRoot, envText(options.environment, "AGENT_SSE_WIRE_TRACE_DIR", "logs/sse_wire_traces"));
  return {
    startTurn: (sessionId, turnId) => {
      const now = new Date();
      const day = now.toISOString().slice(0, 10).replaceAll("-", "");
      const time = now.toTimeString().slice(0, 5).replace(":", "");
      const safeSession = sessionId.replaceAll(/[^A-Za-z0-9_-]+/gu, "_") || "session";
      const safeTurn = turnId.replaceAll(/[^A-Za-z0-9_-]+/gu, "_") || "turn";
      const directoryName = `${time}_${safeSession}`;
      const traceDirectory = join(traceRoot, day, directoryName);
      const wireDirectory = join(wireRoot, day, directoryName, safeTurn);
      let tracePath: string | undefined;
      let wirePath: string | undefined;
      if (traceEnabled) {
        try {
          mkdirSync(traceDirectory, { recursive: true });
          tracePath = join(traceDirectory, `${safeTurn}.jsonl`);
        } catch (error) {
          logger.warn("runtime_trace_initialize_failed", { trace_type: "turn", trace_path: traceDirectory, error });
        }
      }
      if (wireEnabled) {
        try {
          mkdirSync(wireDirectory, { recursive: true });
          wirePath = join(wireDirectory, "provider.jsonl");
        } catch (error) {
          logger.warn("runtime_trace_initialize_failed", { trace_type: "wire", trace_path: wireDirectory, error });
        }
      }
      return new FileRuntimeTrace(
        tracePath,
        wirePath,
      );
    },
  };
}

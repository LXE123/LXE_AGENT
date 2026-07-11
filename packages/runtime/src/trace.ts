import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonObject, JsonValue } from "@lxe/protocol";
import { envFlag, envInteger, envText, type Environment } from "@lxe/core";

const SECRET_KEYS = /(?:authorization|api[_-]?key|token|secret|password|cookie|signature|redacted[_-]?thinking|data)/iu;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?:home|Users|var|tmp)\/)[^\s"']+/gu;

export function sanitizeTraceValue(value: unknown, key = "", seen = new WeakSet<object>()): JsonValue {
  if (SECRET_KEYS.test(key)) return "***";
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/u.test(value)) return `[base64 omitted: ${value.length} chars]`;
    const redacted = value.replaceAll(ABSOLUTE_PATH, "<path>");
    if (redacted.length <= 8_000) return redacted;
    return `${redacted.slice(0, 3_900)}...[${redacted.length - 7_800} chars omitted]...${redacted.slice(-3_900)}`;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[recursive]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item, key, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, item]) => [childKey, sanitizeTraceValue(item, childKey, seen)])) as JsonObject;
}

export interface RuntimeTracePort {
  record(kind: string, payload?: JsonObject): void;
  wire(kind: string, payload?: JsonObject): void;
}

export interface RuntimeTraceControllerPort {
  startTurn(sessionId: string, turnId: string): RuntimeTracePort;
}

class FileRuntimeTrace implements RuntimeTracePort {
  constructor(private readonly tracePath?: string, private readonly wirePath?: string) {}

  record(kind: string, payload: JsonObject = {}): void {
    this.write(this.tracePath, kind, payload);
  }

  wire(kind: string, payload: JsonObject = {}): void {
    this.write(this.wirePath, kind, payload);
  }

  private write(path: string | undefined, kind: string, payload: JsonObject): void {
    if (!path) return;
    appendFileSync(path, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      kind,
      payload: sanitizeTraceValue(payload),
    })}\n`, "utf8");
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
  const retentionDays = envInteger(options.environment, "LOCAL_LOG_RETENTION_DAYS", 14, { min: 1, max: 3_650 });
  for (const root of [traceRoot, wireRoot]) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d{8}$/u.test(entry.name)) continue;
        const timestamp = Date.UTC(Number(entry.name.slice(0, 4)), Number(entry.name.slice(4, 6)) - 1, Number(entry.name.slice(6, 8)));
        if (timestamp < Date.now() - retentionDays * 86_400_000) rmSync(join(root, entry.name), { recursive: true, force: true });
      }
    } catch {
      // Missing or unreadable trace roots are recreated lazily.
    }
  }
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
      if (traceEnabled) mkdirSync(traceDirectory, { recursive: true });
      if (wireEnabled) mkdirSync(wireDirectory, { recursive: true });
      return new FileRuntimeTrace(
        traceEnabled ? join(traceDirectory, `${safeTurn}.jsonl`) : undefined,
        wireEnabled ? join(wireDirectory, "provider.jsonl") : undefined,
      );
    },
  };
}

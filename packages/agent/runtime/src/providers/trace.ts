import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JsonObject, JsonValue } from "@lxe/protocol";
import {
  createLogger,
  envFlag,
  envText,
  sanitizeLogValue,
  sanitizeLogValueWithPolicy,
  type Environment,
} from "@lxe/core";

const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?:home|Users|var|tmp)\/)[^\s"']+/gu;
const WIRE_STRING_LIMIT = 8_192;
const WIRE_COLLECTION_LIMIT = 10_000;
const logger = createLogger("runtime.trace");
const localDay = (date: Date): string =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
const localIso = (date = new Date()): string => {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = Math.abs(offsetMinutes);
  return [
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    `T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`,
    `${sign}${String(Math.floor(offset / 60)).padStart(2, "0")}:${String(offset % 60).padStart(2, "0")}`,
  ].join("");
};

const truncateWireText = (value: string): string => {
  if (value.length <= WIRE_STRING_LIMIT) return value;
  let marker = `...[omitted ${Math.max(1, value.length - WIRE_STRING_LIMIT)} chars]...`;
  let available = Math.max(2, WIRE_STRING_LIMIT - marker.length);
  let headLength = Math.max(1, Math.floor(available / 2));
  let tailLength = Math.max(1, available - headLength);
  const omitted = Math.max(1, value.length - headLength - tailLength);
  marker = `...[omitted ${omitted} chars]...`;
  available = Math.max(2, WIRE_STRING_LIMIT - marker.length);
  headLength = Math.max(1, Math.floor(available / 2));
  tailLength = Math.max(1, available - headLength);
  return `${value.slice(0, headLength)}${marker}${value.slice(-tailLength)}`;
};

const traceValue = (value: unknown): JsonValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/u.test(value)) return `[base64 omitted: ${value.length} chars]`;
    return value.replaceAll(ABSOLUTE_PATH, "<path>");
  }
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(traceValue);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, traceValue(item)])) as JsonObject;
};

export function sanitizeTraceValue(value: unknown, key = ""): JsonValue {
  return traceValue(sanitizeLogValue(value, key));
}

const normalizedKey = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "");
const textLength = (value: unknown): number => typeof value === "string" ? value.length : 0;

const prepareWireValue = (
  value: unknown,
  key = "",
  parentType = "",
  seen = new WeakSet<object>(),
): unknown => {
  const normalized = normalizedKey(key);
  if (normalized === "signature" || normalized === "signaturedelta") return "***";
  if (parentType === "redacted_thinking" && normalized === "data") {
    return `[redacted thinking data omitted: ${textLength(value)} chars]`;
  }
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncateWireText(value.replaceAll(ABSOLUTE_PATH, "<path>"));
  if (typeof value !== "object") return value;
  if (value instanceof Error || value instanceof Date || value instanceof URL) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (value instanceof Map || value instanceof Set) return value;
  if (seen.has(value)) return "[recursive]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => prepareWireValue(item, "", parentType, seen));
    const source = value as Record<string, unknown>;
    const type = String(source.type ?? parentType).trim().toLowerCase();
    const imageSource = type === "base64"
      && String(source.media_type ?? source.mimeType ?? "").trim().toLowerCase().startsWith("image/");
    return Object.fromEntries(Object.entries(source).map(([childKey, item]) => {
      if (imageSource && normalizedKey(childKey) === "data") {
        return [childKey, `[image base64 omitted: ${textLength(item)} chars]`];
      }
      return [childKey, prepareWireValue(item, childKey, type, seen)];
    }));
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  } finally {
    seen.delete(value);
  }
};

export function sanitizeWireTraceValue(value: unknown): JsonValue {
  return sanitizeLogValueWithPolicy(prepareWireValue(value), {
    maxDepth: 32,
    maxItems: WIRE_COLLECTION_LIMIT,
    maxString: WIRE_STRING_LIMIT,
    maxStackString: WIRE_STRING_LIMIT,
  }) as JsonValue;
}

const sanitizeRawWireData = (value: string): string => {
  try {
    return JSON.stringify(sanitizeWireTraceValue(JSON.parse(value)));
  } catch {
    return truncateWireText(value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
      .replace(
        /((?:"?)(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|cookie|password|signature)(?:"?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1\"***\"",
      ));
  }
};

export interface RuntimeWireTraceAttemptContext {
  step: number;
  attempt: number;
  provider: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
}

export interface RuntimeWireTraceAttempt {
  requestStart(requestHeaders: JsonObject, requestPayload: JsonObject): void;
  responseStart(statusCode: number, responseHeaders: JsonObject): void;
  event(eventName: string, payload: unknown): void;
  parseError(eventName: string, rawData: string, error: unknown): void;
  end(ok: boolean, error?: string): void;
}

export interface RuntimeTracePort {
  record(kind: string, payload?: JsonObject): void;
  startProviderAttempt(context: RuntimeWireTraceAttemptContext): RuntimeWireTraceAttempt | undefined;
}

export interface RuntimeTraceControllerPort {
  startTurn(sessionId: string, turnId: string): RuntimeTracePort;
}

interface WireTraceBaseRecord extends JsonObject {
  ts: string;
  kind: string;
  session_id: string;
  turn_id: string;
  step: number;
  attempt: number;
  provider: string;
}

class FileWireTraceAttempt implements RuntimeWireTraceAttempt {
  private failed = false;
  private requestStarted = false;
  private responseStarted = false;
  private ended = false;
  private eventCount = 0;

  constructor(
    private readonly path: string,
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly context: RuntimeWireTraceAttemptContext,
  ) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      this.failed = true;
      logger.warn("wire_trace_initialize_failed", {
        trace_path: path,
        step: context.step,
        attempt: context.attempt,
        provider: context.provider,
        error,
      });
    }
  }

  requestStart(requestHeaders: JsonObject, requestPayload: JsonObject): void {
    if (this.ended || this.requestStarted) return;
    this.requestStarted = true;
    this.write({
      ...this.base("request_start"),
      endpoint: sanitizeWireTraceValue(this.context.endpoint),
      model: sanitizeWireTraceValue(this.context.model),
      timeout_s: Math.max(0, Math.round(this.context.timeoutMs / 1_000)),
      request_headers: sanitizeWireTraceValue(requestHeaders),
      request_payload: sanitizeWireTraceValue(requestPayload),
    });
  }

  responseStart(statusCode: number, responseHeaders: JsonObject): void {
    if (this.ended || this.responseStarted) return;
    this.responseStarted = true;
    this.write({
      ...this.base("response_start"),
      status_code: Math.max(0, Math.trunc(statusCode)),
      response_headers: sanitizeWireTraceValue(responseHeaders),
    });
  }

  event(eventName: string, payload: unknown): void {
    if (this.ended) return;
    try {
      const data = JSON.stringify(sanitizeWireTraceValue(payload)) ?? "null";
      this.eventCount += 1;
      this.write({
        ...this.base("wire_event"),
        event: sanitizeWireTraceValue(eventName.trim() || "message"),
        data,
      });
    } catch (error) {
      this.parseError(eventName, "", error);
    }
  }

  parseError(eventName: string, rawData: string, error: unknown): void {
    if (this.ended) return;
    this.write({
      ...this.base("parse_error"),
      event: sanitizeWireTraceValue(eventName.trim() || "message"),
      data: sanitizeRawWireData(rawData),
      error: sanitizeWireTraceValue(error instanceof Error ? error.message : String(error)),
    });
  }

  end(ok: boolean, error = ""): void {
    if (this.ended) return;
    this.ended = true;
    this.write({
      ...this.base("request_end"),
      ok,
      event_count: this.eventCount,
      error: sanitizeWireTraceValue(error.trim()),
    });
  }

  private base(kind: string): WireTraceBaseRecord {
    return {
      ts: localIso(),
      kind,
      session_id: this.sessionId,
      turn_id: this.turnId,
      step: this.context.step,
      attempt: this.context.attempt,
      provider: this.context.provider,
    };
  }

  private write(record: JsonObject): void {
    if (this.failed) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      this.failed = true;
      logger.warn("wire_trace_write_failed", {
        trace_path: this.path,
        trace_kind: record.kind,
        step: this.context.step,
        attempt: this.context.attempt,
        provider: this.context.provider,
        error,
      });
    }
  }
}

class FileRuntimeTrace implements RuntimeTracePort {
  private traceFailed = false;

  constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly tracePath?: string,
    private readonly wireDirectory?: string,
  ) {}

  record(kind: string, payload: JsonObject = {}): void {
    if (!this.tracePath || this.traceFailed) return;
    try {
      appendFileSync(this.tracePath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        kind,
        payload: sanitizeTraceValue(payload),
      })}\n`, "utf8");
    } catch (error) {
      this.traceFailed = true;
      logger.warn("runtime_trace_write_failed", { trace_kind: kind, trace_path: this.tracePath, error });
    }
  }

  startProviderAttempt(context: RuntimeWireTraceAttemptContext): RuntimeWireTraceAttempt | undefined {
    if (!this.wireDirectory) return undefined;
    const safeStep = Math.max(0, Math.trunc(context.step));
    const safeAttempt = Math.max(1, Math.trunc(context.attempt));
    return new FileWireTraceAttempt(
      join(this.wireDirectory, `step_${safeStep}_attempt_${safeAttempt}.jsonl`),
      this.sessionId,
      this.turnId,
      { ...context, step: safeStep, attempt: safeAttempt },
    );
  }
}

export function configureRuntimeTracing(options: {
  projectRoot: string;
  environment: Environment;
}): RuntimeTraceControllerPort {
  const enabled = envFlag(options.environment, "LOCAL_LOGS_ENABLED", false);
  const traceEnabled = enabled && envFlag(options.environment, "AGENT_STREAM_TRACE_ENABLED", true);
  const wireEnabled = enabled && envFlag(options.environment, "AGENT_SSE_WIRE_TRACE_ENABLED", true);
  const traceRoot = resolve(options.projectRoot, envText(options.environment, "AGENT_STREAM_TRACE_DIR", "var/logs/agent_traces"));
  const wireRoot = resolve(options.projectRoot, envText(options.environment, "AGENT_SSE_WIRE_TRACE_DIR", "var/logs/sse_wire_traces"));
  return {
    startTurn: (sessionId, turnId) => {
      const now = new Date();
      const day = localDay(now);
      const time = now.toTimeString().slice(0, 5).replace(":", "");
      const safeSession = sessionId.replaceAll(/[^A-Za-z0-9_-]+/gu, "_") || "session";
      const safeTurn = turnId.replaceAll(/[^A-Za-z0-9_-]+/gu, "_") || "turn";
      const directoryName = `${time}_${safeSession}`;
      const traceDirectory = join(traceRoot, day, directoryName);
      const wireDirectory = join(wireRoot, day, directoryName, safeTurn);
      let tracePath: string | undefined;
      if (traceEnabled) {
        try {
          mkdirSync(traceDirectory, { recursive: true });
          tracePath = join(traceDirectory, `${safeTurn}.jsonl`);
        } catch (error) {
          logger.warn("runtime_trace_initialize_failed", { trace_type: "turn", trace_path: traceDirectory, error });
        }
      }
      return new FileRuntimeTrace(
        sessionId,
        turnId,
        tracePath,
        wireEnabled ? wireDirectory : undefined,
      );
    },
  };
}

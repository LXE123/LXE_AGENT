import type { JsonObject, JsonValue } from "@lxe/protocol";

export interface FeishuApiEnvelope {
  code: number;
  msg: string;
  data: JsonObject;
  logId: string;
}

const object = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export const safeFeishuMessage = (value: JsonValue | undefined): string =>
  String(value ?? "")
    .replace(/(token|secret|password|api[-_]?key|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

export function parseFeishuEnvelope(result: JsonObject, operation: string): FeishuApiEnvelope {
  const rawCode = result.code;
  const code = typeof rawCode === "number" || (typeof rawCode === "string" && rawCode.trim())
    ? Number(rawCode)
    : Number.NaN;
  if (!Number.isFinite(code) || !Number.isInteger(code)) {
    throw new Error(`malformed Feishu response for ${operation}: missing numeric code`);
  }
  return {
    code,
    msg: safeFeishuMessage(result.msg),
    data: object(result.data),
    logId: String(result.log_id ?? "").trim(),
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export class FeishuApiHttpError extends Error {
  readonly method: string;
  readonly path: string;
  readonly http_status: number;
  readonly api_code: number;
  readonly log_id: string;
  readonly operation: string;

  constructor(options: {
    method: string;
    path: string;
    httpStatus: number;
    apiCode: number;
    logId: string;
    operation: string;
    message: string;
    cause?: Error;
  }) {
    super(options.message, options.cause ? { cause: options.cause } : undefined);
    this.name = "FeishuApiHttpError";
    this.method = options.method;
    this.path = options.path;
    this.http_status = options.httpStatus;
    this.api_code = options.apiCode;
    this.log_id = options.logId;
    this.operation = options.operation;
  }
}

export function normalizeFeishuTransportError(
  method: string,
  path: string,
  cause: unknown,
  operation = "api_request",
): Error {
  const source = record(cause);
  const response = record(source.response);
  const payload = record(response.data);
  const status = Number(response.status);
  if (!Number.isInteger(status) || status <= 0) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  const rawCode = payload.code;
  const code = typeof rawCode === "number" || (typeof rawCode === "string" && rawCode.trim())
    ? Number(rawCode)
    : Number.NaN;
  const message = safeFeishuMessage(String(payload.msg ?? payload.message ?? ""));
  const logId = String(payload.log_id ?? "").trim();
  const details = [
    `HTTP ${status}`,
    ...(Number.isFinite(code) ? [`code ${code}`] : []),
  ].join(", ");
  return new FeishuApiHttpError({
    method: String(method).toUpperCase(),
    path,
    httpStatus: status,
    apiCode: Number.isFinite(code) ? code : -1,
    logId,
    operation,
    message: `Feishu API ${String(method).toUpperCase()} ${path} failed: ${details}${message ? `: ${message}` : ""}`,
    ...(cause instanceof Error ? { cause } : {}),
  });
}

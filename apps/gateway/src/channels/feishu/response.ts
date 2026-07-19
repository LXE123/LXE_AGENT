import type { JsonObject, JsonValue } from "@lxe/protocol";
import { inspectHttpError } from "@lxe/core";

export interface FeishuApiEnvelope {
  code: number;
  msg: string;
  data: JsonObject;
  logId: string;
}

const object = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export const safeFeishuMessage = (value: unknown): string =>
  String(value ?? "")
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
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
  readonly api_subcode: number;
  readonly log_id: string;
  readonly operation: string;

  constructor(options: {
    method: string;
    path: string;
    httpStatus: number;
    apiCode: number;
    apiSubcode?: number;
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
    this.api_subcode = options.apiSubcode ?? -1;
    this.log_id = options.logId;
    this.operation = options.operation;
  }
}

export class FeishuApiResponseError extends Error {
  readonly api_code: number;
  readonly api_subcode: number;
  readonly log_id: string;
  readonly operation: string;

  constructor(options: { apiCode: number; logId: string; operation: string; message: string }) {
    super(options.message);
    this.name = "FeishuApiResponseError";
    this.api_code = options.apiCode;
    this.api_subcode = Number(/ErrCode:\s*(\d+)/iu.exec(options.message)?.[1] ?? -1);
    this.log_id = options.logId;
    this.operation = options.operation;
  }
}

export function feishuErrorFields(cause: unknown): JsonObject {
  if (cause instanceof FeishuApiHttpError) {
    return {
      error_name: cause.name,
      observed_message: safeFeishuMessage(cause.message),
      http_status: cause.http_status,
      api_code: cause.api_code,
      api_subcode: cause.api_subcode,
      log_id: cause.log_id,
      operation: cause.operation,
    };
  }
  if (cause instanceof FeishuApiResponseError) {
    return {
      error_name: cause.name,
      observed_message: safeFeishuMessage(cause.message),
      api_code: cause.api_code,
      api_subcode: cause.api_subcode,
      log_id: cause.log_id,
      operation: cause.operation,
    };
  }
  const observed = inspectHttpError(cause);
  const payload = observed.responseData;
  const errorDetail = record(payload.error);
  const rawCode = payload.code;
  const apiCode = typeof rawCode === "number" && Number.isFinite(rawCode)
    ? rawCode
    : typeof rawCode === "string" && rawCode.trim()
      ? rawCode.trim()
      : undefined;
  const providerMessage = safeFeishuMessage(payload.msg ?? payload.message);
  const rawSubcode = errorDetail.subcode ?? errorDetail.code;
  const apiSubcode = typeof rawSubcode === "number" && Number.isFinite(rawSubcode)
    ? rawSubcode
    : typeof rawSubcode === "string" && rawSubcode.trim()
      ? rawSubcode.trim()
      : /ErrCode:\s*(\d+)/iu.exec(providerMessage)?.[1];
  const logId = String(payload.log_id ?? errorDetail.log_id ?? "").trim();
  return {
    error_name: cause instanceof Error ? cause.name : "Error",
    observed_message: providerMessage || safeFeishuMessage(observed.message),
    ...(observed.httpStatus ? { http_status: observed.httpStatus } : {}),
    ...(apiCode !== undefined ? { api_code: apiCode } : {}),
    ...(apiSubcode !== undefined ? { api_subcode: apiSubcode } : {}),
    ...(logId ? { log_id: logId } : {}),
  };
}

export function normalizeFeishuTransportError(
  method: string,
  path: string,
  cause: unknown,
  operation = "api_request",
): Error {
  const observed = inspectHttpError(cause);
  const payload = observed.responseData;
  const errorDetail = record(payload.error);
  const status = observed.httpStatus;
  if (!status) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  const rawCode = payload.code;
  const code = typeof rawCode === "number" || (typeof rawCode === "string" && rawCode.trim())
    ? Number(rawCode)
    : Number.NaN;
  const message = safeFeishuMessage(String(payload.msg ?? payload.message ?? ""));
  const subcodeMatch = /ErrCode:\s*(\d+)/i.exec(message);
  const apiSubcode = subcodeMatch ? Number(subcodeMatch[1]) : -1;
  const logId = String(payload.log_id ?? errorDetail.log_id ?? "").trim();
  const details = [
    `HTTP ${status}`,
    ...(Number.isFinite(code) ? [`code ${code}`] : []),
  ].join(", ");
  return new FeishuApiHttpError({
    method: String(method).toUpperCase(),
    path,
    httpStatus: status,
    apiCode: Number.isFinite(code) ? code : -1,
    apiSubcode: Number.isInteger(apiSubcode) ? apiSubcode : -1,
    logId,
    operation,
    message: `Feishu API ${String(method).toUpperCase()} ${path} failed: ${details}${message ? `: ${message}` : ""}`,
    ...(cause instanceof Error ? { cause } : {}),
  });
}

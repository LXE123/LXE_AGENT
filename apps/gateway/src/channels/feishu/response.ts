import type { AgentDiagnostic, JsonObject, JsonValue } from "@lxe/protocol";
import { inspectHttpError } from "@lxe/core";

export interface FeishuApiEnvelope {
  code: number;
  msg: string;
  data: JsonObject;
  logId: string;
}

const object = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

const FEISHU_BEARER_SECRET = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/-]+=*/giu;
const FEISHU_NAMED_SECRET = /(token|secret|password|api[-_]?key|authorization|cookie)\s*[=:]\s*[^\s,;]+/giu;

export interface SafeFeishuObservation {
  text: string;
  redacted: boolean;
  truncated: boolean;
}

export const safeFeishuObservation = (value: unknown, limit = 4_000): SafeFeishuObservation => {
  const original = String(value ?? "").trim();
  const withBearerRedacted = original.replace(FEISHU_BEARER_SECRET, "$1 [redacted]");
  const sanitized = withBearerRedacted.replace(FEISHU_NAMED_SECRET, "$1=[redacted]");
  const maximum = Math.max(1, Math.trunc(limit));
  return {
    text: sanitized.slice(0, maximum),
    redacted: sanitized !== original || sanitized.includes("[redacted]"),
    truncated: sanitized.length > maximum,
  };
};

export const safeFeishuMessage = (value: unknown): string =>
  safeFeishuObservation(value, 500).text.replace(/\s+/gu, " ").trim();

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
    msg: safeFeishuObservation(result.msg).text,
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

export function createFeishuDiagnostic(
  cause: unknown,
  options: {
    operation: string;
    stage: string;
    endpoint?: string;
    causeKnown?: boolean;
    verifiedReason?: string;
    mappingId?: string;
  },
): AgentDiagnostic {
  const fields = feishuErrorFields(cause);
  const errorName = cause instanceof Error ? cause.name : String(fields.error_name ?? "Error");
  const inspected = inspectHttpError(cause);
  const responsePayload = record(inspected.responseData);
  const providerObservation = String(responsePayload.msg ?? responsePayload.message ?? "").trim();
  const rawError = providerObservation
    || (cause instanceof Error && cause.message.trim() ? cause.message : String(fields.observed_message ?? cause));
  const observed = safeFeishuObservation(rawError);
  const httpStatus = Number(fields.http_status);
  const providerCode = fields.api_code;
  const providerSubcode = fields.api_subcode;
  const logId = String(fields.log_id ?? "").trim();
  const causeKnown = options.causeKnown === true;
  return {
    type: "operation_failure",
    provider: "feishu",
    operation: options.operation.trim().slice(0, 128) || "unknown_feishu_operation",
    stage: options.stage.trim().slice(0, 64) || "unknown",
    error_name: errorName.trim().slice(0, 128) || "Error",
    observed_error: observed.text || errorName || "undefined",
    redacted: observed.redacted,
    truncated: observed.truncated,
    cause_known: causeKnown,
    ...(causeKnown && options.verifiedReason?.trim()
      ? { verified_reason: options.verifiedReason.trim().slice(0, 256) }
      : {}),
    ...(causeKnown && options.mappingId?.trim()
      ? { mapping_id: options.mappingId.trim().slice(0, 128) }
      : {}),
    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
      ? { http_status: httpStatus }
      : {}),
    ...(typeof providerCode === "number" && Number.isInteger(providerCode) && providerCode >= 0
      ? { provider_code: providerCode }
      : typeof providerCode === "string" && providerCode.trim()
        ? { provider_code: providerCode.trim().slice(0, 128) }
        : {}),
    ...(typeof providerSubcode === "number" && Number.isInteger(providerSubcode) && providerSubcode >= 0
      ? { provider_subcode: providerSubcode }
      : typeof providerSubcode === "string" && providerSubcode.trim()
        ? { provider_subcode: providerSubcode.trim().slice(0, 128) }
        : {}),
    ...(logId ? { log_id: logId.slice(0, 256) } : {}),
    ...(options.endpoint?.trim() ? { endpoint: options.endpoint.trim().slice(0, 512) } : {}),
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

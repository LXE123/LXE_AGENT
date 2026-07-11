import type { JsonObject, JsonValue } from "@lxe/protocol";

export interface FeishuApiEnvelope {
  code: number;
  msg: string;
  data: JsonObject;
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
  return { code, msg: safeFeishuMessage(result.msg), data: object(result.data) };
}

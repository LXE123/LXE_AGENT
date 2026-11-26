/** HTTP error presentation only: never decides authentication, retry, or connection state. */
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const marker = "… [truncated]";
export const limitCloudText = (text: string, maximum: number): string => {
  const characters = Array.from(text);
  return characters.length <= maximum ? text : characters.slice(0, maximum - Array.from(marker).length).join("") + marker;
};
export function sanitizeCloudText(text: string, secrets: readonly string[] = []): string {
  let clean = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) clean = clean.replaceAll(secret, "[redacted]");
  return clean.replace(/\blxe_(?:(?:dev|client|identity)_[A-Za-z0-9]+\.|(?:erp_run|erp_handoff|erp_session|run|handoff|session)_)[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
}
export type CloudErrorDetail = { code: string | undefined; userMessage: string | undefined; diagnostic: string };
export function parseCloudError(body: string, secrets: readonly string[] = []): CloudErrorDetail {
  let detail: Record<string, unknown> | undefined;
  try { detail = object(object(JSON.parse(body))?.detail); } catch { /* Legacy text/HTML bodies use HTTP fallback. */ }
  const code = typeof detail?.code === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(detail.code) ? detail.code : undefined;
  const userMessage = typeof detail?.user_message === "string" ? sanitizeCloudText(detail.user_message, secrets) : "";
  return { code, userMessage: userMessage ? limitCloudText(userMessage, 300) : undefined,
    diagnostic: limitCloudText(sanitizeCloudText(body, secrets), 500) };
}
export function cloudErrorMessage(detail: CloudErrorDetail, httpStatus: number, fallback: string): string {
  if (detail.userMessage) return detail.userMessage;
  if (httpStatus === 409 && detail.code === "device_permission_contract_incompatible") return "当前 Agent 版本过旧，请升级后重试";
  return fallback;
}
export class CloudHttpError extends Error {
  constructor(readonly detail: CloudErrorDetail, readonly httpStatus: number, fallback: string) {
    super(cloudErrorMessage(detail, httpStatus, fallback));
    this.name = "CloudHttpError";
  }
}

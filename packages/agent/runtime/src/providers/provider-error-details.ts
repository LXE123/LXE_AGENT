import { sanitizeWireTraceValue } from "./wire-trace";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function safeProviderErrorText(text: string, secrets: string[] = []): string {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("***");
  // JSON error bodies can echo credentials too; quoted keys are not covered by
  // the generic log text sanitizer. Redact before its explicit size limit.
  text = text.replace(/((?:["']?)(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|cookie|password)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1"***"');
  return String(sanitizeWireTraceValue(text));
}

/** Walk SDK HTTP errors, parsed/string bodies and network cause chains. */
function errorParts(error: unknown): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [], seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5) return;
    if (typeof value === "string") {
      try { visit(JSON.parse(value), depth + 1); } catch { /* Plain text is retained separately. */ }
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const part = object(value);
    parts.push(part);
    for (const key of ["error", "body", "response", "data", "cause", "incomplete_details"]) visit(part[key], depth + 1);
  };
  visit(error, 0);
  return parts;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export function providerErrorText(error: unknown): string {
  const texts: string[] = [];
  const add = (value: unknown): void => {
    if (value === undefined || value === null) return;
    const text = stringify(value).trim();
    if (text && !texts.some(existing => existing.includes(text))) texts.push(text);
  };
  const parts = errorParts(error);
  for (const part of parts) {
    add(part.message);
    for (const key of ["code", "type", "param", "reason"]) {
      if (typeof part[key] === "string") add(`${key}: ${part[key]}`);
    }
    for (const key of ["body", "error"]) {
      const body = part[key];
      if (body !== undefined && !(body instanceof Error)) add(body);
    }
  }
  if (!texts.length) add(error instanceof Error ? error.message || error.name : error);
  return texts.join("\n") || "Provider request failed without error details";
}

export interface ProviderErrorDetails {
  code?: string | undefined;
  type?: string | undefined;
  requestId?: string | undefined;
  retryAfterMs?: number | undefined;
  incompleteReason?: string | undefined;
}

export function providerErrorDetails(error: unknown, now = Date.now()): ProviderErrorDetails {
  const parts = errorParts(error);
  const first = (key: string): string | undefined => parts.map(part => part[key])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const header = (name: string): string | undefined => {
    for (const part of parts) {
      if (part.headers instanceof Headers) {
        const value = part.headers.get(name);
        if (value !== null) return value;
      } else {
        for (const [key, value] of Object.entries(object(part.headers))) {
          if (key.toLowerCase() === name && typeof value === "string") return value;
        }
      }
    }
    return undefined;
  };
  let retryAfterMs: number | undefined;
  const milliseconds = header("retry-after-ms"), retryAfter = header("retry-after");
  if (milliseconds?.trim() && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) {
    retryAfterMs = Number(milliseconds);
  } else if (retryAfter?.trim()) {
    const delay = /^\d+(?:\.\d+)?$/u.test(retryAfter.trim())
      ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(delay)) retryAfterMs = Math.max(0, delay);
  }
  return {
    code: first("code"), type: parts.map(part => part.type)
      .find((value): value is string => typeof value === "string" && value !== "error" && !value.startsWith("response.")),
    requestId: first("request_id") ?? first("requestID") ?? header("x-request-id"),
    retryAfterMs,
    incompleteReason: parts.map(part => object(part.incomplete_details).reason)
      .find((value): value is string => typeof value === "string"),
  };
}

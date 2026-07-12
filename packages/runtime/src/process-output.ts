import iconv from "iconv-lite";
import type { JsonObject } from "@lxe/protocol";

const FALLBACK_ENCODINGS = ["gbk", "cp936", "cp437", "cp850", "windows-1252", "latin1"] as const;
const CONTROL_KEYS = [
  "session",
  "status",
  "pid",
  "exit_code",
  "duration_sec",
  "total_lines",
  "showing",
  "truncated",
  "message",
  "error",
] as const;
const OUTPUT_KEYS = new Set(["output", "new_output"]);

export function decodeProcessOutput(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { /* Try the Windows/native executable fallbacks below. */ }
  const source = Buffer.from(bytes);
  for (const encoding of FALLBACK_ENCODINGS) {
    try {
      const decoded = iconv.decode(source, encoding);
      if (iconv.encode(decoded, encoding).equals(source)) return decoded;
    } catch { /* Unsupported or invalid encoding; continue in main-compatible order. */ }
  }
  return new TextDecoder().decode(bytes);
}

export function combineProcessStreams(stdout: Uint8Array, stderr: Uint8Array): string {
  const out = decodeProcessOutput(stdout);
  const error = decodeProcessOutput(stderr);
  if (out && error) return `${out.trimEnd()}\n[stderr]\n${error.trimStart()}`;
  return out || error;
}

export function appendLimitedBytes(
  existing: Uint8Array,
  addition: Uint8Array,
  limit: number,
): { bytes: Uint8Array; truncated: boolean } {
  if (addition.byteLength === 0) return { bytes: existing, truncated: false };
  if (existing.byteLength >= limit) return { bytes: existing, truncated: true };
  const allowed = limit - existing.byteLength;
  const selected = addition.subarray(0, allowed);
  return {
    bytes: Buffer.concat([existing, selected]),
    truncated: selected.byteLength < addition.byteLength,
  };
}

export function appendTailBytes(existing: Uint8Array, addition: Uint8Array, limit: number): Uint8Array {
  const combined = Buffer.concat([existing, addition]);
  return combined.subarray(Math.max(0, combined.byteLength - limit));
}

const plainScalar = (value: unknown): string => {
  if (value === true) return "true";
  if (value === false) return "false";
  if (value === null) return "null";
  return String(value);
};

const appendScalar = (lines: string[], label: string, value: unknown, indent = 0): void => {
  if (value === undefined || value === null) return;
  const text = plainScalar(value);
  if (!text.trim()) return;
  const prefix = " ".repeat(Math.max(0, indent));
  if (!text.includes("\n")) {
    lines.push(`${prefix}${label}: ${text}`);
    return;
  }
  lines.push(`${prefix}${label}:`);
  const childPrefix = " ".repeat(Math.max(0, indent + 2));
  lines.push(...text.split(/\r?\n/u).map((line) => `${childPrefix}${line}`));
};

const appendValue = (lines: string[], value: unknown, indent = 0): void => {
  const prefix = " ".repeat(Math.max(0, indent));
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== null && typeof item === "object") {
        lines.push(`${prefix}${key}:`);
        appendValue(lines, item, indent + 2);
      } else appendScalar(lines, key, item, indent);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        lines.push(`${prefix}-`);
        appendValue(lines, item, indent + 2);
      } else {
        const text = plainScalar(item);
        if (!text.includes("\n")) lines.push(`${prefix}- ${text}`);
        else {
          lines.push(`${prefix}-`);
          lines.push(...text.split(/\r?\n/u).map((line) => `${" ".repeat(indent + 2)}${line}`));
        }
      }
    }
    return;
  }
  lines.push(`${prefix}${plainScalar(value)}`);
};

const parsedJsonText = (value: unknown): JsonObject | unknown[] | undefined => {
  if (typeof value !== "string") return undefined;
  let candidate = value.trim();
  if (!candidate || ["(no output)", "(no new output)"].includes(candidate)) return undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "string" && /^[\[{]/u.test(parsed.trim())) {
        candidate = parsed.trim();
        continue;
      }
      if (parsed !== null && typeof parsed === "object") return parsed as JsonObject | unknown[];
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export function formatCommandPayload(payload: JsonObject): string {
  const lines: string[] = [];
  for (const key of CONTROL_KEYS) {
    if (key in payload) appendScalar(lines, key, payload[key]);
  }
  const outputKey = "new_output" in payload ? "new_output" : "output" in payload ? "output" : "";
  if (outputKey) {
    const value = payload[outputKey];
    const parsed = parsedJsonText(value);
    lines.push(`${outputKey}:`);
    if (parsed !== undefined) appendValue(lines, parsed, 2);
    else lines.push(String(value ?? "") || "(no output)");
  }
  for (const [key, value] of Object.entries(payload)) {
    if ((CONTROL_KEYS as readonly string[]).includes(key) || OUTPUT_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object") {
      lines.push(`${key}:`);
      appendValue(lines, value, 2);
    } else appendScalar(lines, key, value);
  }
  return lines.join("\n").trim();
}

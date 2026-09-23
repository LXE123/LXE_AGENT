const MAX_LINE_CHARS = 2_048;
const STAGE = /^[a-z][a-z0-9_]{0,63}$/u;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f]|https?:\/\/|\b(?:bearer|token|password|cookie|authorization|secret|api[_ -]?key)\b|[A-Za-z0-9_-]{40,}/iu;

export interface ProgressEnvelope {
  stage: string;
  message: string;
}

/** Parse one business CLI progress record, exposing only bounded display fields. */
export function progressEnvelope(line: string, command: string): ProgressEnvelope | undefined {
  if (!line || line.length > MAX_LINE_CHARS || !command) return undefined;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.protocol_version !== "1" || record.type !== "progress" || record.command !== command) return undefined;
  if (typeof record.stage !== "string" || !STAGE.test(record.stage)) return undefined;
  if (typeof record.message !== "string" || !record.message.trim() || record.message.length > 120
    || UNSAFE_TEXT.test(record.message)) return undefined;
  // Extra data is never forwarded. Reject free-form fields so credentials cannot
  // be laundered through a progress record, even if the display text is safe.
  for (const [key, field] of Object.entries(record)) {
    if (["protocol_version", "type", "command", "stage", "message"].includes(key)) continue;
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || typeof field !== "number"
      || !Number.isSafeInteger(field) || field < 0 || field > 100_000) return undefined;
  }
  return { stage: record.stage, message: record.message };
}

/** Decode stdout incrementally without retaining oversized or malformed lines. */
export class ProgressEnvelopeDecoder {
  private readonly decoder = new TextDecoder();
  private line = "";
  private overflow = false;

  constructor(private readonly command: string) {}

  push(chunk: Uint8Array): ProgressEnvelope[] {
    const messages: ProgressEnvelope[] = [];
    for (const character of this.decoder.decode(chunk, { stream: true })) {
      if (character === "\n") {
        if (!this.overflow) {
          const message = progressEnvelope(this.line.replace(/\r$/u, ""), this.command);
          if (message) messages.push(message);
        }
        this.line = "";
        this.overflow = false;
      } else if (!this.overflow) {
        if (this.line.length < MAX_LINE_CHARS) this.line += character;
        else { this.line = ""; this.overflow = true; }
      }
    }
    return messages;
  }
}

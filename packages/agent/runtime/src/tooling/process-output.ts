import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import iconv from "iconv-lite";
import type { JsonObject } from "@lxe/protocol";

const CONTROL_KEYS = [
  "exec_id",
  "session",
  "status",
  "pid",
  "exit_code",
  "duration_sec",
  "truncated",
  "omitted_bytes",
  "output_path",
  "message",
  "error",
] as const;
const OUTPUT_KEYS = new Set(["output", "new_output"]);

export type OutputStream = "stdout" | "stderr";

export interface OutputChunk {
  seq: number;
  stream: OutputStream;
  bytes: Uint8Array;
}

const utf8Strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true });

/**
 * Drops the partial UTF-8 sequences that appear when a byte buffer is cut at an
 * arbitrary offset (ring eviction, tail slicing, interleaved stream runs). Without
 * this a single split character makes strict UTF-8 decoding fail for the whole
 * buffer, which used to hand the entire output to a single-byte fallback codepage.
 */
export function trimPartialUtf8(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.byteLength && start < 3 && (bytes[start]! & 0xc0) === 0x80) start += 1;
  let end = bytes.byteLength;
  for (let back = 1; back <= 4 && end - back >= start; back += 1) {
    const byte = bytes[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (width > back) end -= back;
    break;
  }
  return start === 0 && end === bytes.byteLength ? bytes : bytes.subarray(start, end);
}

/**
 * UTF-8 first, then GBK for native Windows executables. Single-byte codepages are
 * deliberately absent: they round-trip every possible byte sequence, so including
 * them turned any non-UTF-8 byte into confident mojibake for the whole buffer.
 * When nothing decodes cleanly the lossy UTF-8 result keeps U+FFFD visible instead
 * of inventing readable-looking text.
 */
export function decodeProcessOutput(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "";
  try {
    return utf8Strict().decode(bytes);
  } catch { /* Not clean UTF-8; try boundary repair and GBK below. */ }
  const trimmed = trimPartialUtf8(bytes);
  if (trimmed.byteLength > 0 && trimmed.byteLength !== bytes.byteLength) {
    try {
      return utf8Strict().decode(trimmed);
    } catch { /* Genuinely not UTF-8; try GBK below. */ }
  }
  const source = Buffer.from(bytes);
  try {
    const decoded = iconv.decode(source, "gbk");
    if (iconv.encode(decoded, "gbk").equals(source)) return decoded;
  } catch { /* GBK unavailable or invalid; fall through to lossy UTF-8. */ }
  return new TextDecoder().decode(bytes);
}

interface OutputRun {
  stream: OutputStream;
  bytes: Uint8Array;
}

const coalesceRuns = (chunks: readonly OutputChunk[]): OutputRun[] => {
  const runs: OutputRun[] = [];
  for (const chunk of chunks) {
    if (chunk.bytes.byteLength === 0) continue;
    const last = runs.at(-1);
    if (last && last.stream === chunk.stream) {
      last.bytes = Buffer.concat([last.bytes, chunk.bytes]);
      continue;
    }
    runs.push({ stream: chunk.stream, bytes: chunk.bytes });
  }
  return runs;
};

export function chunksAreStdoutOnly(chunks: readonly OutputChunk[]): boolean {
  return chunks.every((chunk) => chunk.stream === "stdout" || chunk.bytes.byteLength === 0);
}

/**
 * Renders chunks in arrival order so the model sees the real interleaving of the two
 * streams. Stream markers only appear once stderr is actually involved, keeping the
 * common stdout-only result free of decoration (and JSON-parseable).
 */
export function renderProcessChunks(chunks: readonly OutputChunk[]): string {
  const runs = coalesceRuns(chunks);
  if (runs.length === 0) return "";
  if (runs.every((run) => run.stream === "stdout")) return decodeProcessOutput(runs[0]!.bytes);
  return runs
    .map((run) => `[${run.stream}]\n${decodeProcessOutput(run.bytes).replace(/\s+$/u, "")}`)
    .join("\n");
}

export interface ProcessOutputStoreOptions {
  /** Bytes kept in memory, and therefore the most the model can be shown at once. */
  retainBytes: number;
  /** Where the full transcript is written once retainBytes is exceeded. */
  spillPath?: string;
  /** Upper bound on the spill file so a runaway process cannot fill the disk. */
  spillLimitBytes?: number;
}

export interface ProcessOutputSlice {
  text: string;
  cursor: number;
  missed: boolean;
}

const DEFAULT_SPILL_LIMIT_BYTES = 20 * 1024 * 1024;
const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Holds a bounded tail of process output in memory and streams everything past that
 * bound to a file. The model always gets the end of the output, where failures and
 * summaries live, plus a path it can grep or read with offset/limit.
 */
export class ProcessOutputStore {
  private readonly chunks: OutputChunk[] = [];
  private readonly retainBytes: number;
  private readonly spillLimitBytes: number;
  private nextSeq = 0;
  private retainedBytes = 0;
  private total = 0;
  private dropped = 0;
  private sink: ReturnType<ReturnType<typeof Bun.file>["writer"]> | undefined;
  private resolvedSpillPath = "";
  private spillWritten = 0;
  private spillExhausted = false;
  private spillUnavailable = false;

  constructor(private readonly options: ProcessOutputStoreOptions) {
    this.retainBytes = Math.max(1, Math.trunc(options.retainBytes));
    this.spillLimitBytes = Math.max(
      1,
      Math.trunc(options.spillLimitBytes ?? DEFAULT_SPILL_LIMIT_BYTES),
    );
  }

  get totalBytes(): number { return this.total; }
  get droppedBytes(): number { return this.dropped; }
  get truncated(): boolean { return this.dropped > 0; }
  get spillPath(): string { return this.resolvedSpillPath; }
  get cursor(): number { return this.nextSeq; }

  append(stream: OutputStream, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.total += bytes.byteLength;
    const crossesRetention = !this.sink && !this.spillUnavailable && this.total > this.retainBytes;
    this.chunks.push({ seq: this.nextSeq, stream, bytes });
    this.nextSeq += 1;
    this.retainedBytes += bytes.byteLength;
    // Retention and spilling share one threshold, so the transcript is opened before
    // the first eviction and therefore never misses the head of the output.
    if (crossesRetention) this.openSpill();
    else this.writeSpill(bytes);
    this.evict();
  }

  renderRetained(): string {
    return renderProcessChunks(this.chunks);
  }

  renderTail(limitBytes: number): string {
    const limit = Math.max(1, Math.trunc(limitBytes));
    const selected: OutputChunk[] = [];
    let budget = limit;
    for (let index = this.chunks.length - 1; index >= 0 && budget > 0; index -= 1) {
      const chunk = this.chunks[index]!;
      const bytes = chunk.bytes.byteLength <= budget
        ? chunk.bytes
        : chunk.bytes.subarray(chunk.bytes.byteLength - budget);
      selected.unshift({ seq: chunk.seq, stream: chunk.stream, bytes });
      budget -= bytes.byteLength;
    }
    return renderProcessChunks(selected);
  }

  renderSince(cursor: number): ProcessOutputSlice {
    const pending = this.chunks.filter((chunk) => chunk.seq >= cursor);
    const firstRetained = this.chunks[0]?.seq ?? cursor;
    return {
      text: renderProcessChunks(pending),
      cursor: this.nextSeq,
      missed: firstRetained > cursor,
    };
  }

  async close(): Promise<void> {
    const sink = this.sink;
    this.sink = undefined;
    if (!sink) return;
    try {
      await sink.end();
    } catch { /* The transcript is best-effort; a failed flush must not fail the command. */ }
  }

  private openSpill(): void {
    const path = String(this.options.spillPath ?? "").trim();
    if (!path) {
      this.spillUnavailable = true;
      return;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.sink = Bun.file(path).writer();
      this.resolvedSpillPath = path;
      for (const chunk of this.chunks) this.writeSpill(chunk.bytes);
    } catch {
      this.spillUnavailable = true;
      this.sink = undefined;
      this.resolvedSpillPath = "";
    }
  }

  private writeSpill(bytes: Uint8Array): void {
    if (!this.sink || this.spillExhausted) return;
    const remaining = this.spillLimitBytes - this.spillWritten;
    if (remaining <= 0) {
      this.spillExhausted = true;
      return;
    }
    const slice = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
    try {
      this.sink.write(slice);
      // The path is handed to the model while the command is still running, so the
      // transcript has to be readable now rather than only after the sink is closed.
      const flushed: unknown = this.sink.flush();
      if (flushed instanceof Promise) void flushed.catch(() => undefined);
    } catch {
      this.spillExhausted = true;
      return;
    }
    this.spillWritten += slice.byteLength;
    if (slice.byteLength < bytes.byteLength) this.spillExhausted = true;
  }

  private evict(): void {
    while (this.retainedBytes > this.retainBytes && this.chunks.length > 0) {
      const front = this.chunks[0]!;
      const excess = this.retainedBytes - this.retainBytes;
      if (front.bytes.byteLength <= excess) {
        this.chunks.shift();
        this.retainedBytes -= front.bytes.byteLength;
        this.dropped += front.bytes.byteLength;
        continue;
      }
      front.bytes = front.bytes.subarray(excess);
      this.retainedBytes -= excess;
      this.dropped += excess;
    }
  }
}

/** Best-effort removal of transcripts left behind by earlier runs or crashes. */
export function sweepSpillDirectory(directory: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".log")) continue;
      const path = join(directory, name);
      try {
        if (now - statSync(path).mtimeMs > SPILL_RETENTION_MS) unlinkSync(path);
      } catch { /* Concurrent removal or a locked file; skip it. */ }
    }
  } catch { /* The directory does not exist yet; nothing to sweep. */ }
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

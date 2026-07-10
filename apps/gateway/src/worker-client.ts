import { randomUUID } from "node:crypto";
import {
  validateWorkerEnvelope,
  type JsonObject,
  type WorkerEnvelope,
} from "@lxe/protocol";

export interface WorkerProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  writeStdin(data: Uint8Array): void | Promise<void>;
  closeStdin(): void;
  kill(): void | Promise<void>;
  forceKill(): void | Promise<void>;
}

export class WorkerResponseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestKind: string,
  ) {
    super(message);
  }
}

export interface WorkerClientOptions {
  process: WorkerProcess;
  id?: () => string;
  onEvent?: (event: WorkerEnvelope) => void | Promise<void>;
  onFatal: (error: Error) => void;
  logStderr?: (line: string) => void;
  maxLineBytes?: number;
}

interface PendingRequest {
  requestKind: string;
  expectedKind: string;
  runId: string | null;
  resolve: (payload: JsonObject) => void;
  reject: (error: Error) => void;
}

const EVENT_KINDS = new Set([
  "runtime.emit",
  "runtime.typing",
  "runtime.heartbeat_wake",
  "runtime.turn.completed",
]);

const encoder = new TextEncoder();

const protocolError = (message: string): Error => new Error(`worker protocol failure: ${message}`);

const containsUnpairedSurrogate = (value: unknown): boolean => {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(containsUnpairedSurrogate);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) => containsUnpairedSurrogate(key) || containsUnpairedSurrogate(item),
    );
  }
  return false;
};

export class WorkerClient {
  private readonly process: WorkerProcess;
  private readonly id: () => string;
  private readonly onEvent: ((event: WorkerEnvelope) => void | Promise<void>) | undefined;
  private readonly onFatal: (error: Error) => void;
  private readonly logStderr: (line: string) => void;
  private readonly maxLineBytes: number;
  private readonly pending = new Map<string, PendingRequest>();
  private nextInputSeq = 0;
  private nextOutputSeq = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private started = false;
  private failed = false;
  private expectedExit = false;

  constructor(options: WorkerClientOptions) {
    this.process = options.process;
    this.id = options.id ?? (() => randomUUID().replaceAll("-", ""));
    this.onEvent = options.onEvent;
    this.onFatal = options.onFatal;
    this.logStderr = options.logStderr ?? (() => undefined);
    this.maxLineBytes = Math.max(1_024, Math.trunc(options.maxLineBytes ?? 4 * 1_024 * 1_024));
  }

  get isFailed(): boolean {
    return this.failed;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.readStdout();
    void this.readStderr();
    void this.watchExit();
  }

  request(kind: string, payload: JsonObject, options: { runId?: string } = {}): Promise<JsonObject> {
    if (!this.started) throw new Error("worker client is not started");
    if (this.failed || this.expectedExit) return Promise.reject(new Error("worker client is closed"));
    const messageId = this.id();
    const runId = String(options.runId ?? "").trim() || null;
    const envelope: WorkerEnvelope = {
      protocol_version: "1",
      message_id: messageId,
      reply_to: null,
      run_id: runId,
      seq: this.nextInputSeq,
      kind: String(kind ?? "").trim(),
      payload,
    };
    if (!validateWorkerEnvelope(envelope)) {
      return Promise.reject(protocolError("attempted to write an invalid envelope"));
    }
    this.nextInputSeq += 1;

    const result = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(messageId, {
        requestKind: envelope.kind,
        expectedKind: `${envelope.kind}.result`,
        runId,
        resolve,
        reject,
      });
    });
    this.writeTail = this.writeTail
      .then(async () => {
        await this.process.writeStdin(encoder.encode(`${JSON.stringify(envelope)}\n`));
      })
      .catch((cause: unknown) => {
        this.fail(protocolError(`stdin write failed: ${String(cause)}`));
      });
    return result;
  }

  expectExit(): void {
    if (this.expectedExit) return;
    this.expectedExit = true;
    this.rejectPending(new Error("worker client closed before the request completed"));
  }

  async flushWrites(): Promise<void> {
    await this.writeTail;
  }

  closeStdin(): void {
    this.expectExit();
    this.process.closeStdin();
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const reader = this.process.stdout.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (encoder.encode(buffer).byteLength > this.maxLineBytes && !buffer.includes("\n")) {
          throw protocolError(`stdout line exceeds ${this.maxLineBytes} bytes`);
        }
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (encoder.encode(line).byteLength > this.maxLineBytes) {
            throw protocolError(`stdout line exceeds ${this.maxLineBytes} bytes`);
          }
          if (line.length > 0) {
            if (!line.trim()) throw protocolError("stdout contains a whitespace-only line");
            await this.handleLine(line);
          }
        }
        if (encoder.encode(buffer).byteLength > this.maxLineBytes) {
          throw protocolError(`stdout line exceeds ${this.maxLineBytes} bytes`);
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) throw protocolError("stdout ended with a partial line");
      if (!this.expectedExit) throw protocolError("worker stdout reached EOF");
    } catch (cause) {
      this.fail(cause instanceof Error ? cause : protocolError(String(cause)));
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const reader = this.process.stderr.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          this.logStderr(buffer.slice(0, newline).replace(/\r$/, ""));
          buffer = buffer.slice(newline + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer) this.logStderr(buffer);
    } catch (cause) {
      this.logStderr(`worker stderr reader failed: ${String(cause)}`);
    } finally {
      reader.releaseLock();
    }
  }

  private async watchExit(): Promise<void> {
    try {
      const code = await this.process.exited;
      if (!this.expectedExit) this.fail(protocolError(`worker exited with code ${code}`));
    } catch (cause) {
      if (!this.expectedExit) this.fail(protocolError(`worker exit wait failed: ${String(cause)}`));
    }
  }

  private async handleLine(line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (cause) {
      throw protocolError(`stdout is not valid JSON: ${String(cause)}`);
    }
    if (containsUnpairedSurrogate(raw)) {
      throw protocolError("stdout contains an invalid Unicode surrogate");
    }
    if (!validateWorkerEnvelope(raw)) {
      const details = validateWorkerEnvelope.errors?.map((item) => item.message).join(", ") || "invalid envelope";
      throw protocolError(details);
    }
    const envelope = raw as WorkerEnvelope;
    if (envelope.seq !== this.nextOutputSeq) {
      throw protocolError(`expected sequence ${this.nextOutputSeq}, received ${envelope.seq}`);
    }
    this.nextOutputSeq += 1;

    if (EVENT_KINDS.has(envelope.kind)) {
      await this.onEvent?.(envelope);
      return;
    }
    const replyTo = envelope.reply_to;
    if (!replyTo) throw protocolError(`unsolicited worker kind: ${envelope.kind}`);
    const pending = this.pending.get(replyTo);
    if (!pending) throw protocolError(`reply references unknown message_id: ${replyTo}`);
    if (envelope.run_id !== pending.runId) {
      throw protocolError(`reply run_id mismatch for message_id: ${replyTo}`);
    }
    if (envelope.kind === "error") {
      const code = String(envelope.payload.code ?? "handler_error");
      const message = String(envelope.payload.message ?? "worker request failed");
      const requestKind = String(envelope.payload.request_kind ?? "");
      if (requestKind !== pending.requestKind) {
        throw protocolError(
          `error request_kind mismatch: expected ${pending.requestKind}, received ${requestKind}`,
        );
      }
      this.pending.delete(replyTo);
      pending.reject(new WorkerResponseError(code, message, requestKind));
      return;
    }
    if (envelope.kind !== pending.expectedKind) {
      throw protocolError(`expected ${pending.expectedKind}, received ${envelope.kind}`);
    }
    this.pending.delete(replyTo);
    pending.resolve(envelope.payload);
  }

  private fail(error: Error): void {
    if (this.failed || this.expectedExit) return;
    this.failed = true;
    this.rejectPending(error);
    try {
      this.onFatal(error);
    } catch {
      // A supervisor observer must not create a second failure path.
    }
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }
}

import type { JsonObject, WorkerEnvelope } from "@lxe/protocol";
import type { WorkerProcess } from "./worker-client";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ScriptedWorkerProcess implements WorkerProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly requests: WorkerEnvelope[] = [];
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private stderrController!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number) => void;
  private nextOutputSeq = 0;
  private finished = false;
  stdinClosed = false;
  gracefulKills = 0;
  forceKills = 0;

  constructor(
    readonly pid: number,
    private readonly handler: (
      request: WorkerEnvelope,
      process: ScriptedWorkerProcess,
    ) => void | Promise<void>,
    private readonly exitOnStdinClose = true,
  ) {
    this.stdout = new ReadableStream({
      start: (controller) => {
        this.stdoutController = controller;
      },
    });
    this.stderr = new ReadableStream({
      start: (controller) => {
        this.stderrController = controller;
      },
    });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  async writeStdin(value: Uint8Array): Promise<void> {
    if (this.stdinClosed) throw new Error("stdin is closed");
    for (const line of decoder.decode(value).split("\n")) {
      if (!line) continue;
      const request = JSON.parse(line) as WorkerEnvelope;
      this.requests.push(request);
      await this.handler(request, this);
    }
  }

  closeStdin(): void {
    this.stdinClosed = true;
    if (this.exitOnStdinClose) queueMicrotask(() => this.exit(0));
  }

  kill(): void {
    this.gracefulKills += 1;
    this.exit(143);
  }

  forceKill(): void {
    this.forceKills += 1;
    this.exit(137);
  }

  reply(request: WorkerEnvelope, payload: JsonObject, kind = `${request.kind}.result`): void {
    this.emit({
      protocol_version: "1",
      message_id: `response-${this.nextOutputSeq}`,
      reply_to: request.message_id,
      run_id: request.run_id,
      seq: this.nextOutputSeq,
      kind,
      payload,
    });
  }

  error(request: WorkerEnvelope, code: string, message = code): void {
    this.reply(request, { code, message, request_kind: request.kind }, "error");
  }

  event(kind: string, payload: JsonObject, runId: string | null = null): void {
    this.emit({
      protocol_version: "1",
      message_id: `event-${this.nextOutputSeq}`,
      reply_to: null,
      run_id: runId,
      seq: this.nextOutputSeq,
      kind,
      payload,
    });
  }

  emit(envelope: WorkerEnvelope): void {
    this.nextOutputSeq = envelope.seq + 1;
    this.stdoutController.enqueue(encoder.encode(`${JSON.stringify(envelope)}\n`));
  }

  log(line: string): void {
    this.stderrController.enqueue(encoder.encode(`${line}\n`));
  }

  exit(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.stdoutController.close();
    this.stderrController.close();
    this.resolveExit(code);
  }
}

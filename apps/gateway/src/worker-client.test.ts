import { describe, expect, test } from "bun:test";
import type { JsonObject, WorkerEnvelope } from "@lxe/protocol";
import {
  WorkerClient,
  WorkerResponseError,
  type WorkerProcess,
} from "./worker-client";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeWorkerProcess implements WorkerProcess {
  readonly pid = 4242;
  readonly writes: WorkerEnvelope[] = [];
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private stderrController!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number) => void;
  stdinClosed = false;
  killed = false;
  forceKilled = false;
  private stdoutClosed = false;

  constructor() {
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

  async writeStdin(data: Uint8Array): Promise<void> {
    for (const line of decoder.decode(data).split("\n")) {
      if (line) this.writes.push(JSON.parse(line) as WorkerEnvelope);
    }
  }

  closeStdin(): void {
    this.stdinClosed = true;
  }

  kill(): void {
    this.killed = true;
  }

  forceKill(): void {
    this.forceKilled = true;
  }

  emit(envelope: WorkerEnvelope): void {
    this.stdoutController.enqueue(encoder.encode(`${JSON.stringify(envelope)}\n`));
  }

  emitRaw(text: string): void {
    this.stdoutController.enqueue(encoder.encode(text));
  }

  emitBytes(value: Uint8Array): void {
    this.stdoutController.enqueue(value);
  }

  emitStderr(text: string): void {
    this.stderrController.enqueue(encoder.encode(text));
  }

  closeStdout(): void {
    if (this.stdoutClosed) return;
    this.stdoutClosed = true;
    this.stdoutController.close();
  }

  exit(code = 0): void {
    this.closeStdout();
    this.stderrController.close();
    this.resolveExit(code);
  }
}

const response = (
  request: WorkerEnvelope,
  seq: number,
  payload: JsonObject,
  kind = `${request.kind}.result`,
): WorkerEnvelope => ({
  protocol_version: "1",
  message_id: `worker-${seq}`,
  reply_to: request.message_id,
  run_id: request.run_id,
  seq,
  kind,
  payload,
});

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Bun.sleep(0);
};

describe("WorkerClient", () => {
  test("correlates concurrent hello and health replies from sequence zero", async () => {
    const process = new FakeWorkerProcess();
    const fatals: Error[] = [];
    const client = new WorkerClient({ process, onFatal: (error) => fatals.push(error) });
    client.start();

    const helloPromise = client.request("worker.hello", {});
    const healthPromise = client.request("health", {});
    await tick();
    expect(process.writes.map((item) => item.kind)).toEqual(["worker.hello", "health"]);

    process.emit(response(process.writes[1]!, 0, { ready: true }));
    process.emit(response(process.writes[0]!, 1, { protocol_version: "1" }));

    expect(await healthPromise).toEqual({ ready: true });
    expect(await helloPromise).toEqual({ protocol_version: "1" });
    expect(fatals).toEqual([]);
    process.exit();
  });

  test.each([
    ["first sequence is not zero", (request: WorkerEnvelope) => response(request, 1, {})],
    ["sequence gap", (request: WorkerEnvelope) => response(request, 0, {})],
    ["stdout pollution", () => "INFO worker ready\n"],
  ])("fails the protocol on %s", async (_label, build) => {
    const process = new FakeWorkerProcess();
    const fatals: Error[] = [];
    const client = new WorkerClient({ process, onFatal: (error) => fatals.push(error) });
    client.start();

    const first = client.request("health", {});
    await tick();
    const firstOutput = build(process.writes[0]!);
    if (typeof firstOutput === "string") process.emitRaw(firstOutput);
    else process.emit(firstOutput);

    if (_label === "sequence gap") {
      await first;
      const second = client.request("health", {});
      await tick();
      process.emit(response(process.writes[1]!, 2, {}));
      await expect(second).rejects.toThrow("sequence");
    } else {
      await expect(first).rejects.toThrow();
    }
    await tick();
    expect(fatals).toHaveLength(1);
    process.exit();
  });

  test("preserves unsolicited event order while replies are concurrent", async () => {
    const process = new FakeWorkerProcess();
    const events: string[] = [];
    const client = new WorkerClient({
      process,
      onFatal: (error) => {
        throw error;
      },
      onEvent: async (event) => {
        events.push(`${event.kind}:${String(event.payload.value)}`);
        await Promise.resolve();
      },
    });
    client.start();
    const request = client.request("health", {});
    await tick();
    process.emit({
      protocol_version: "1",
      message_id: "event-0",
      reply_to: null,
      run_id: "run-1",
      seq: 0,
      kind: "runtime.emit",
      payload: { value: "first" },
    });
    process.emit({
      protocol_version: "1",
      message_id: "event-1",
      reply_to: null,
      run_id: "run-1",
      seq: 1,
      kind: "runtime.typing",
      payload: { value: "second" },
    });
    process.emit(response(process.writes[0]!, 2, { ready: true }));

    expect(await request).toEqual({ ready: true });
    expect(events).toEqual(["runtime.emit:first", "runtime.typing:second"]);
    process.exit();
  });

  test("returns structured worker errors to the matching request", async () => {
    const process = new FakeWorkerProcess();
    const client = new WorkerClient({ process, onFatal: () => undefined });
    client.start();
    const request = client.request("session.rebind", { session_id: "missing" });
    await tick();
    process.emit(
      response(
        process.writes[0]!,
        0,
        {
          code: "session_not_found",
          message: "session not found: missing",
          request_kind: "session.rebind",
        },
        "error",
      ),
    );
    try {
      await request;
      throw new Error("request unexpectedly resolved");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerResponseError);
      expect((error as WorkerResponseError).code).toBe("session_not_found");
      expect((error as WorkerResponseError).requestKind).toBe("session.rebind");
    }
    process.exit();
  });

  test("treats an error reply for a different request kind as fatal", async () => {
    const process = new FakeWorkerProcess();
    const fatals: Error[] = [];
    const client = new WorkerClient({ process, onFatal: (error) => fatals.push(error) });
    client.start();
    const request = client.request("health", {});
    const outcome = request.catch((error: unknown) => error);
    await tick();
    process.emit(
      response(
        process.writes[0]!,
        0,
        { code: "invalid_request", message: "bad", request_kind: "worker.hello" },
        "error",
      ),
    );

    expect(await outcome).toBeInstanceOf(Error);
    expect(fatals[0]?.message).toContain("request_kind mismatch");
    process.exit();
  });

  test("accepts valid non-BMP Unicode but rejects an unpaired surrogate", async () => {
    const validProcess = new FakeWorkerProcess();
    const validFatals: Error[] = [];
    const validClient = new WorkerClient({
      process: validProcess,
      onFatal: (error) => validFatals.push(error),
    });
    validClient.start();
    const valid = validClient.request("health", {});
    await tick();
    validProcess.emit(response(validProcess.writes[0]!, 0, { text: "中文😀" }));
    expect(await valid).toEqual({ text: "中文😀" });
    expect(validFatals).toEqual([]);
    validProcess.exit();

    const invalidProcess = new FakeWorkerProcess();
    const invalidClient = new WorkerClient({ process: invalidProcess, onFatal: () => undefined });
    invalidClient.start();
    const invalid = invalidClient.request("health", {});
    const outcome = invalid.catch((error: unknown) => error);
    await tick();
    invalidProcess.emit(response(invalidProcess.writes[0]!, 0, { text: "\ud800" }));
    expect(await outcome).toBeInstanceOf(Error);
    invalidProcess.exit();
  });

  test("rejects the correlated request when the reply kind is unexpected", async () => {
    const process = new FakeWorkerProcess();
    const fatals: Error[] = [];
    const client = new WorkerClient({ process, onFatal: (error) => fatals.push(error) });
    client.start();
    const request = client.request("health", {});
    const outcome = request.then(
      () => undefined,
      (error: unknown) => error,
    );
    await tick();
    process.emit(response(process.writes[0]!, 0, {}, "worker.hello.result"));

    const settled = await Promise.race([outcome, Bun.sleep(50).then(() => "timeout")]);
    expect(settled).not.toBe("timeout");
    expect(settled).toBeInstanceOf(Error);
    expect(fatals).toHaveLength(1);
    process.exit();
  });

  test("fails an oversized partial stdout line before unbounded buffering", async () => {
    const process = new FakeWorkerProcess();
    const fatals: Error[] = [];
    const client = new WorkerClient({
      process,
      onFatal: (error) => fatals.push(error),
      maxLineBytes: 1_024,
    });
    client.start();
    const request = client.request("health", {});
    const outcome = request.catch((error: unknown) => error);
    await tick();
    process.emitRaw("x".repeat(1_025));

    expect(await outcome).toBeInstanceOf(Error);
    expect(fatals[0]?.message).toContain("exceeds 1024 bytes");
    process.exit();
  });

  test.each([
    [
      "duplicate sequence",
      (process: FakeWorkerProcess) => {
        process.emit(response(process.writes[0]!, 0, {}));
        process.emit({
          protocol_version: "1",
          message_id: "duplicate",
          reply_to: null,
          run_id: null,
          seq: 0,
          kind: "runtime.emit",
          payload: {},
        });
      },
    ],
    ["invalid UTF-8", (process: FakeWorkerProcess) => process.emitBytes(new Uint8Array([0xff, 0x0a]))],
    ["partial EOF line", (process: FakeWorkerProcess) => process.emitRaw('{"protocol_version":')],
    ["unknown event", (process: FakeWorkerProcess) => process.emit({
      protocol_version: "1",
      message_id: "unknown-event",
      reply_to: null,
      run_id: null,
      seq: 0,
      kind: "runtime.future_event",
      payload: {},
    })],
    ["protocol mismatch", (process: FakeWorkerProcess) => process.emitRaw(`${JSON.stringify({
      ...response(process.writes[0]!, 0, {}),
      protocol_version: "2",
    })}\n`)],
  ] as const)("rejects pending requests exactly once for %s", async (label, emitFailure) => {
    const process = new FakeWorkerProcess();
    const fatals: Error[] = [];
    const client = new WorkerClient({ process, onFatal: (error) => fatals.push(error) });
    client.start();
    const first = client.request("health", {});
    const second = client.request("health", {});
    const firstOutcome = first.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    const secondOutcome = second.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await tick();
    emitFailure(process);
    if (label === "partial EOF line") process.closeStdout();

    const [firstResult, secondResult] = await Promise.all([firstOutcome, secondOutcome]);
    if (label === "duplicate sequence") {
      expect(firstResult.value).toEqual({});
      expect(firstResult.error).toBeUndefined();
    } else {
      expect(firstResult.error).toBeInstanceOf(Error);
    }
    expect(secondResult.error).toBeInstanceOf(Error);
    await tick();
    expect(fatals).toHaveLength(1);
    if (label !== "partial EOF line") process.exit(7);
  });

  test("forwards stderr lines without interpreting them as protocol", async () => {
    const process = new FakeWorkerProcess();
    const logs: string[] = [];
    const client = new WorkerClient({
      process,
      onFatal: () => undefined,
      logStderr: (line) => logs.push(line),
    });
    client.start();
    process.emitStderr("INFO 中文 log\ncontinued");
    process.exit();
    await tick();
    expect(logs).toEqual(["INFO 中文 log", "continued"]);
  });

  test("deliberate close rejects and removes every unrelated pending RPC exactly once", async () => {
    const process = new FakeWorkerProcess();
    const fatals: Error[] = [];
    const client = new WorkerClient({ process, onFatal: (error) => fatals.push(error) });
    client.start();
    let settlements = 0;
    const dashboard = client.request("dashboard.query", { operation: "session.get" }).catch((error) => {
      settlements += 1;
      return error;
    });
    const maintenance = client.request("maintenance.run", { operation: "data_server_sync" }).catch(
      (error) => {
        settlements += 1;
        return error;
      },
    );
    await tick();

    client.closeStdin();
    expect(await dashboard).toBeInstanceOf(Error);
    expect(await maintenance).toBeInstanceOf(Error);
    await tick();
    expect(settlements).toBe(2);
    expect(fatals).toEqual([]);
  });

  test("treats a whitespace-only stdout line as pollution", async () => {
    const process = new FakeWorkerProcess();
    const fatals: Error[] = [];
    const client = new WorkerClient({ process, onFatal: (error) => fatals.push(error) });
    client.start();
    const request = client.request("health", {}).catch((error: unknown) => error);
    await tick();
    process.emitRaw("  \t\r\n");

    const outcome = await Promise.race([request, Bun.sleep(50).then(() => "timeout")]);
    expect(outcome).toBeInstanceOf(Error);
    expect(fatals[0]?.message).toContain("whitespace");
    process.exit();
  });
});

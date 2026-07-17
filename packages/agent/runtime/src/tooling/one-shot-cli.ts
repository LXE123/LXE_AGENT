import type { JsonObject } from "@lxe/protocol";

export interface CliTerminalResult {
  protocol_version: "1";
  type: "result";
  command: string;
  ok: boolean;
  data: JsonObject;
  files: string[];
  error?: { code: string; message: string };
}

export interface OneShotCliRunnerPort {
  execute(arguments_: string[], signal: AbortSignal, timeoutMs?: number): Promise<CliTerminalResult>;
}

export interface OneShotCliRunnerOptions {
  command: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string | undefined>;
  onStderr?: (line: string) => void;
}

const failureSuffix = (exitCode: number, stderr: string): string => {
  const rawDetail = stderr.trim();
  const detail = rawDetail.length > 4_096 ? `…${rawDetail.slice(-4_096)}` : rawDetail;
  return ` (exit ${exitCode})${detail ? `: ${detail}` : ""}`;
};

const readLimited = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`CLI output exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const terminateTree = async (pid: number): Promise<void> => {
  if (process.platform !== "win32") return;
  const taskkill = Bun.which("taskkill");
  if (!taskkill) return;
  const killer = Bun.spawn([taskkill, "/PID", String(pid), "/T", "/F"], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  await killer.exited;
};

export class OneShotCliRunner implements OneShotCliRunnerPort {
  constructor(private readonly options: OneShotCliRunnerOptions) {}

  async execute(arguments_: string[], signal: AbortSignal, timeoutMs?: number): Promise<CliTerminalResult> {
    if (signal.aborted) throw new DOMException("CLI cancelled", "AbortError");
    const child = Bun.spawn([...this.options.command, ...arguments_], {
      cwd: this.options.cwd,
      env: {
        ...globalThis.process.env,
        ...this.options.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      maxBuffer: Math.max(1, this.options.maxOutputBytes),
      windowsHide: true,
    });
    let timedOut = false;
    let termination: Promise<void> | undefined;
    const terminate = (): Promise<void> => {
      if (termination) return termination;
      termination = (async () => {
        await terminateTree(child.pid);
        try {
          child.kill();
        } catch {
          // The child already exited.
        }
        await child.exited.catch(() => undefined);
      })();
      return termination;
    };
    const onAbort = (): void => { void terminate(); };
    signal.addEventListener("abort", onAbort, { once: true });
    const effectiveTimeoutMs = Math.max(1, Math.trunc(timeoutMs ?? this.options.timeoutMs));
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, effectiveTimeoutMs);
    try {
      const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
        readLimited(child.stdout, this.options.maxOutputBytes),
        readLimited(child.stderr, this.options.maxOutputBytes),
        child.exited,
      ]);
      if (timedOut) throw new Error(`CLI timed out after ${effectiveTimeoutMs}ms`);
      if (signal.aborted) throw new DOMException("CLI cancelled", "AbortError");
      const stderr = new TextDecoder().decode(stderrBytes);
      for (const line of stderr.split(/\r?\n/u).filter(Boolean)) this.options.onStderr?.(line);
      const lines = new TextDecoder().decode(stdoutBytes).split(/\r?\n/u).filter((line) => line.trim());
      if (lines.length === 0) {
        throw new Error(`lxeskill produced no JSONL result${failureSuffix(exitCode, stderr)}`);
      }
      let records: Array<Record<string, unknown>>;
      try {
        records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`invalid lxeskill JSONL output: ${error}${failureSuffix(exitCode, stderr)}`);
      }
      if (records.some((record) => record.protocol_version !== "1" || !["progress", "result"].includes(String(record.type)))) {
        throw new Error(`invalid lxeskill JSONL record${failureSuffix(exitCode, stderr)}`);
      }
      const terminals = records.filter((record) => record.type === "result");
      if (terminals.length !== 1 || records.at(-1) !== terminals[0]) {
        throw new Error(
          `lxeskill stdout must contain exactly one terminal result as its final record${failureSuffix(exitCode, stderr)}`,
        );
      }
      const terminal = terminals[0] as unknown as CliTerminalResult;
      if (!terminal.data || typeof terminal.data !== "object" || !Array.isArray(terminal.files)) {
        throw new Error("invalid lxeskill terminal result");
      }
      if (exitCode === 0 && !terminal.ok) throw new Error("lxeskill returned a failed result with exit code 0");
      if (exitCode !== 0 && terminal.ok) throw new Error(`lxeskill exited with ${exitCode} after reporting success`);
      if (exitCode !== 0 && terminal.error) {
        return {
          ...terminal,
          error: {
            ...terminal.error,
            message: `${terminal.error.message}${failureSuffix(exitCode, stderr)}`,
          },
        };
      }
      return terminal;
    } catch (error) {
      await terminate();
      if (timedOut) throw new Error(`CLI timed out after ${effectiveTimeoutMs}ms`);
      if (signal.aborted) throw new DOMException("CLI cancelled", "AbortError");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

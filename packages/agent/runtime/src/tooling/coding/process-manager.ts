import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger, runWithLogContext } from "@lxe/core";
import type { JsonObject, WorkspaceContext } from "@lxe/protocol";
import type { ExecShellAdapter } from "../exec-shell";
import { ProcessOutputStore, sweepSpillDirectory } from "../process-output";
import type { ProcessStatus } from "./public-types";

interface ProcessEntry {
  id: string;
  toolCallId: string;
  command: string;
  cwd: string;
  sessionId: string;
  turnId: string;
  responseRouteId: string;
  workspace: WorkspaceContext;
  startedAt: number;
  recency: number;
  endedAt?: number;
  process: ReturnType<typeof Bun.spawn>;
  status: ProcessStatus;
  exitCode: number | null;
  output: ProcessOutputStore;
  outputCursor: number;
  completion: Promise<void>;
  finalObserved: boolean;
  notifyOnExit: boolean;
  notificationSent: boolean;
  notification?: Promise<void>;
  observationTail: Promise<void>;
  terminationEvents: Set<"process_killed" | "process_force_killed">;
}

const SPILL_DIRECTORY_SEGMENTS = ["var", "tmp", "exec"] as const;
const MAX_EXEC_RECORDS_PER_SESSION = 64;
const PROTECTED_RECENT_EXEC_RECORDS = 8;

export class CodingProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly sweptSpillRoots = new Set<string>();
  private readonly logger = createLogger("runtime.coding_process");
  private nextRecency = 0;

  constructor(private readonly options: {
    maxOutputBytes: number;
    tailBytes: number;
    shell: ExecShellAdapter;
  }) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    const incomplete = [...this.entries.values()].filter((entry) => entry.endedAt === undefined);
    await Promise.allSettled(incomplete.map(async (entry) => {
      if (entry.status === "running") entry.status = "killed";
      await this.terminateObserved(entry, "process_force_killed");
    }));
    await Promise.allSettled(incomplete.map((entry) => entry.completion));
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.output.close()));
  }

  async terminateSession(sessionId: string): Promise<void> {
    const entries = [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId && entry.endedAt === undefined);
    await Promise.allSettled(entries.map(async (entry) => {
      if (entry.status === "running") entry.status = "killed";
      await this.terminateObserved(entry, "process_force_killed");
      await entry.completion;
    }));
  }

  snapshots(sessionId?: string): JsonObject[] {
    return [...this.entries.values()]
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((entry) => this.snapshot(entry));
  }

  async execute(request: {
    command: string;
    cwd: string;
    sessionId: string;
    responseRouteId: string;
    workspace: WorkspaceContext;
    yieldMs: number;
    signal: AbortSignal;
    toolCallId: string;
    turnId?: string;
    env?: Record<string, string>;
  }): Promise<JsonObject> {
    this.throwIfAborted(request.signal);
    await this.enforceCapacity(request.sessionId);
    this.throwIfAborted(request.signal);
    const id = `exec_${randomUUID().replaceAll("-", "")}`;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      const spawn = this.options.shell.spawnSpec(request.command);
      child = Bun.spawn(spawn.argv, {
        cwd: request.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: spawn.detached,
        windowsHide: true,
        env: {
          ...this.options.shell.childEnvironment(request.workspace.worktree, {
            sessionId: request.sessionId,
            responseRouteId: request.responseRouteId,
            turnId: request.turnId ?? "",
            execSessionId: id,
          }),
          ...request.env,
        },
      });
    } catch (error) {
      runWithLogContext({
        session_id: request.sessionId,
        turn_id: request.turnId ?? "",
        response_route_id: request.responseRouteId,
        task_id: id,
      }, () => this.logger.error("process_spawn_failed", {
        task_id: id,
        cwd: request.cwd,
        error,
      }));
      return {
        status: "failed",
        exec_id: id,
        error: error instanceof Error && error.message ? `${error.name}: ${error.message}` : String(error),
      };
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || typeof stdout === "number" || !stderr || typeof stderr === "number") {
      try { child.kill(); } catch { /* failed process has no usable stream to clean up */ }
      runWithLogContext(this.logContext({
        id,
        sessionId: request.sessionId,
        turnId: request.turnId ?? "",
        responseRouteId: request.responseRouteId,
      }), () => this.logger.error("process_spawn_failed", {
        task_id: id,
        cwd: request.cwd,
        error: new Error("spawned process did not expose stdout/stderr pipes"),
      }));
      return { status: "failed", exec_id: id, error: "spawned process did not expose stdout/stderr pipes" };
    }
    const spillDirectory = join(request.workspace.worktree, ...SPILL_DIRECTORY_SEGMENTS);
    if (!this.sweptSpillRoots.has(spillDirectory)) {
      this.sweptSpillRoots.add(spillDirectory);
      sweepSpillDirectory(spillDirectory);
    }
    const entry: ProcessEntry = {
      id,
      toolCallId: request.toolCallId,
      command: request.command,
      cwd: request.cwd,
      sessionId: request.sessionId,
      turnId: request.turnId ?? "",
      responseRouteId: request.responseRouteId,
      workspace: request.workspace,
      startedAt: Date.now() / 1_000,
      recency: this.touch(),
      process: child,
      status: "running",
      exitCode: null,
      output: new ProcessOutputStore({
        retainBytes: this.options.maxOutputBytes,
        spillPath: join(spillDirectory, `${id}.log`),
      }),
      outputCursor: 0,
      completion: Promise.resolve(),
      finalObserved: false,
      notifyOnExit: false,
      notificationSent: false,
      observationTail: Promise.resolve(),
      terminationEvents: new Set(),
    };
    this.entries.set(id, entry);
    runWithLogContext(this.logContext(entry), () => {
      this.logger.info("process_started", this.processFields(entry));
    });
    const pump = async (
      stream: ReadableStream<Uint8Array>,
      source: "stdout" | "stderr",
    ): Promise<void> => {
      const reader = stream.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        entry.output.append(source, chunk.value);
      }
    };
    const stdoutTask = pump(stdout, "stdout");
    const stderrTask = pump(stderr, "stderr");
    entry.completion = runWithLogContext(this.logContext(entry), async () => {
      const exitCode = await child.exited;
      await Promise.allSettled([stdoutTask, stderrTask]);
      await entry.output.close();
      entry.exitCode = exitCode;
      entry.endedAt = Date.now() / 1_000;
      if (entry.status === "running") entry.status = exitCode === 0 ? "completed" : "failed";
      this.logger.info("process_completed", this.processFields(entry));
      await this.notifyCompletion(entry);
    });

    await this.observe(entry, request.yieldMs, request.signal);
    if (entry.endedAt !== undefined) {
      entry.finalObserved = true;
      return this.completedPayload(entry);
    }
    entry.notifyOnExit = true;
    runWithLogContext(this.logContext(entry), () => {
      this.logger.info("process_yielded", this.processFields(entry));
    });
    return this.runningPayload(entry, true);
  }

  async wait(request: {
    execId: string;
    sessionId: string;
    yieldMs: number;
    terminate: boolean;
    signal: AbortSignal;
  }): Promise<JsonObject> {
    const entry = this.entries.get(request.execId);
    if (!entry || entry.sessionId !== request.sessionId || entry.finalObserved) {
      return { error: `exec ${request.execId} 不存在或已经关闭。` };
    }
    return this.withObservation(entry, async () => {
      if (entry.finalObserved) return { error: `exec ${request.execId} 不存在或已经关闭。` };
      entry.recency = this.touch();
      if (request.terminate && entry.endedAt === undefined) {
        entry.status = "killed";
        await this.terminateObserved(entry, "process_killed");
        await entry.completion;
      } else if (entry.endedAt === undefined) {
        await this.observe(entry, request.yieldMs, request.signal);
      }
      const terminal = entry.endedAt !== undefined;
      const slice = entry.output.renderSince(entry.outputCursor);
      const payload: JsonObject = {
        exec_id: entry.id,
        status: terminal ? entry.status : "running",
        new_output: slice.text || "(no new output)",
      };
      if (terminal) {
        payload.exit_code = entry.exitCode;
        payload.duration_sec = this.duration(entry);
        entry.finalObserved = true;
      }
      this.describeTruncation(entry, payload, slice.missed);
      entry.outputCursor = slice.cursor;
      return payload;
    });
  }

  private async observe(entry: ProcessEntry, yieldMs: number, signal: AbortSignal): Promise<void> {
    if (entry.endedAt !== undefined || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(done, yieldMs);
      function done(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
      void entry.completion.finally(done);
    });
  }

  private async withObservation<T>(entry: ProcessEntry, observe: () => Promise<T>): Promise<T> {
    const previous = entry.observationTail;
    let release!: () => void;
    entry.observationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await observe();
    } finally {
      release();
    }
  }

  private duration(entry: ProcessEntry): number {
    return Math.max(0, (entry.endedAt ?? Date.now() / 1_000) - entry.startedAt);
  }

  /**
   * Truncation is reported both as structured fields and as an inline marker at the
   * cut point, so the model cannot read a shortened output as if it were complete.
   */
  private describeTruncation(entry: ProcessEntry, payload: JsonObject, applies: boolean): void {
    if (!entry.output.truncated) return;
    payload.truncated = true;
    payload.omitted_bytes = entry.output.droppedBytes;
    if (entry.output.spillPath) payload.output_path = entry.output.spillPath;
    if (!applies) return;
    const outputKey = "new_output" in payload ? "new_output" : "output";
    payload[outputKey] = `${this.truncationMarker(entry)}\n${String(payload[outputKey] ?? "")}`;
  }

  private truncationMarker(entry: ProcessEntry): string {
    const omitted = entry.output.droppedBytes;
    if (!entry.output.spillPath) {
      return `[... 已省略开头 ${omitted} 字节；只保留了输出末尾 ...]`;
    }
    return [
      `[... 已省略开头 ${omitted} 字节，只保留了输出末尾。`,
      `完整输出在 ${entry.output.spillPath}`,
      "——用 grep 检索或 read 带 offset/limit 查看需要的片段，不要整个读回。 ...]",
    ].join("\n");
  }

  private completedPayload(entry: ProcessEntry): JsonObject {
    const payload: JsonObject = {
      status: entry.status,
      exec_id: entry.id,
      exit_code: entry.exitCode,
      output: entry.output.renderRetained().trim() || "(no output)",
      duration_sec: this.duration(entry),
    };
    this.describeTruncation(entry, payload, true);
    return payload;
  }

  private runningPayload(entry: ProcessEntry, advanceCursor: boolean): JsonObject {
    const slice = entry.output.renderSince(entry.outputCursor);
    const payload: JsonObject = {
      status: entry.status,
      exec_id: entry.id,
      pid: entry.process.pid,
      duration_sec: this.duration(entry),
      message: `命令仍在运行。使用 wait(exec_id='${entry.id}') 查看新输出或终止命令。`,
      output: slice.text || "(暂无输出)",
    };
    this.describeTruncation(entry, payload, slice.missed);
    if (advanceCursor) entry.outputCursor = slice.cursor;
    return payload;
  }

  private snapshot(entry: ProcessEntry): JsonObject {
    const endedAt = entry.endedAt ?? null;
    return {
      exec_id: entry.id,
      tool_call_id: entry.toolCallId,
      session_id: entry.sessionId,
      origin_turn_id: entry.turnId,
      status: entry.status,
      pid: entry.process.pid,
      command: entry.command,
      cwd: entry.cwd,
      started_at: entry.startedAt,
      ended_at: endedAt,
      duration_sec: this.duration(entry),
      exit_code: entry.exitCode,
      truncated: entry.output.truncated,
      output_path: entry.output.spillPath,
      output_tail: entry.output.renderTail(this.options.tailBytes),
    };
  }

  private notifyCompletion(entry: ProcessEntry): Promise<void> {
    if (!entry.notifyOnExit || entry.notificationSent || !this.onComplete) return Promise.resolve();
    if (!entry.notification) {
      entry.notification = runWithLogContext(this.logContext(entry), async () => {
        if (!entry.notifyOnExit || entry.notificationSent || !this.onComplete) return;
        entry.notificationSent = true;
        try {
          await this.onComplete(this.snapshot(entry));
        } catch (error) {
          this.logger.warn("process_notification_failed", { ...this.processFields(entry), error });
        }
      });
    }
    return entry.notification;
  }

  private async enforceCapacity(sessionId: string): Promise<void> {
    while (true) {
      const ordered = [...this.entries.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .sort((left, right) => right.recency - left.recency);
      if (ordered.length < MAX_EXEC_RECORDS_PER_SESSION) return;
      const candidates = ordered.slice(PROTECTED_RECENT_EXEC_RECORDS);
      const victim = [...candidates].reverse().find((entry) => entry.endedAt !== undefined)
        ?? candidates.at(-1);
      if (!victim) throw new Error(`exec capacity reached for session ${sessionId}`);
      if (victim.endedAt === undefined) {
        if (victim.status === "running") victim.status = "killed";
        await this.terminateObserved(victim, "process_force_killed");
        await victim.completion;
      }
      this.entries.delete(victim.id);
      await victim.output.close();
      this.logger.warn("process_evicted", this.processFields(victim));
    }
  }

  private touch(): number {
    this.nextRecency += 1;
    return this.nextRecency;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException("exec observation cancelled", "AbortError");
  }

  private logContext(entry: Pick<ProcessEntry, "sessionId" | "turnId" | "responseRouteId" | "id">) {
    return {
      session_id: entry.sessionId,
      turn_id: entry.turnId,
      response_route_id: entry.responseRouteId,
      task_id: entry.id,
    };
  }

  private processFields(entry: ProcessEntry): JsonObject {
    return {
      pid: entry.process.pid,
      task_id: entry.id,
      status: entry.status,
      duration_ms: Math.max(0, Math.round(((entry.endedAt ?? Date.now() / 1_000) - entry.startedAt) * 1_000)),
      exit_code: entry.exitCode,
      truncated: entry.output.truncated,
      output_bytes: entry.output.totalBytes,
      cwd: entry.cwd,
    };
  }

  private terminateObserved(
    entry: ProcessEntry,
    event: "process_killed" | "process_force_killed",
  ): Promise<void> {
    return runWithLogContext(this.logContext(entry), async () => {
      if (!entry.terminationEvents.has(event)) {
        entry.terminationEvents.add(event);
        this.logger.warn(event, this.processFields(entry));
      }
      await this.options.shell.terminate(entry.process, event === "process_force_killed");
    });
  }

  onComplete: ((snapshot: JsonObject) => Promise<void> | void) | undefined;
}

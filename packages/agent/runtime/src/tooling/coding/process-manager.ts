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
  terminalCause?: "natural" | "terminated";
  exitCode: number | null;
  output: ProcessOutputStore;
  outputCursor: number;
  acceptingOutput: boolean;
  outputIncomplete: boolean;
  outputIncompleteReason?: "stream_drain_timeout" | "stream_read_error";
  completion: Promise<void>;
  finalObserved: boolean;
  notifyOnExit: boolean;
  notificationSent: boolean;
  notification?: Promise<void>;
  observationLocked: boolean;
  observationQueue: Array<{ priority: boolean; resolve: (release: () => void) => void }>;
  terminationEvents: Set<"process_killed" | "process_force_killed">;
  terminationTasks: Map<"process_killed" | "process_force_killed", Promise<void>>;
}

interface CancellableOutputReader {
  cancel(reason?: unknown): Promise<void>;
}

const SPILL_DIRECTORY_SEGMENTS = ["var", "tmp", "exec"] as const;
const MAX_EXEC_RECORDS_PER_SESSION = 64;
const PROTECTED_RECENT_EXEC_RECORDS = 8;
const OUTPUT_DRAIN_DEADLINE_MS = 2_000;

export class CodingProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly sweptSpillRoots = new Set<string>();
  private readonly admissionTails = new Map<string, Promise<void>>();
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
    await Promise.allSettled(incomplete.map((entry) =>
      this.requestTermination(entry, "process_force_killed")));
    await Promise.allSettled(incomplete.map((entry) => entry.completion));
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.output.close()));
  }

  async terminateSession(sessionId: string): Promise<void> {
    const entries = [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId && entry.endedAt === undefined);
    await Promise.allSettled(entries.map(async (entry) => {
      await this.requestTermination(entry, "process_force_killed");
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
    const started = await this.withAdmission(request.sessionId, async () => {
      await this.enforceCapacity(request.sessionId);
      this.throwIfAborted(request.signal);
      return this.spawnEntry(request);
    });
    if ("failure" in started) return started.failure;
    const entry = started.entry;

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

  private spawnEntry(request: {
    command: string;
    cwd: string;
    sessionId: string;
    responseRouteId: string;
    workspace: WorkspaceContext;
    signal: AbortSignal;
    toolCallId: string;
    turnId?: string;
    env?: Record<string, string>;
  }): { entry: ProcessEntry } | { failure: JsonObject } {
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
      return { failure: {
        status: "failed", exec_id: id,
        error: error instanceof Error && error.message ? `${error.name}: ${error.message}` : String(error),
      } };
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
      return { failure: {
        status: "failed", exec_id: id, error: "spawned process did not expose stdout/stderr pipes",
      } };
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
      acceptingOutput: true,
      outputIncomplete: false,
      completion: Promise.resolve(),
      finalObserved: false,
      notifyOnExit: false,
      notificationSent: false,
      observationLocked: false,
      observationQueue: [],
      terminationEvents: new Set(),
      terminationTasks: new Map(),
    };
    this.entries.set(id, entry);
    runWithLogContext(this.logContext(entry), () => {
      this.logger.info("process_started", this.processFields(entry));
    });
    const createPump = (
      stream: ReadableStream<Uint8Array>,
      source: "stdout" | "stderr",
    ) => {
      const reader = stream.getReader();
      const task = (async (): Promise<void> => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (entry.acceptingOutput) entry.output.append(source, chunk.value);
        }
      })();
      return { reader, task };
    };
    const pumps = [createPump(stdout, "stdout"), createPump(stderr, "stderr")];
    // Attach rejection handlers immediately; a pipe can fail before the child exits.
    const outputDrain = Promise.allSettled(pumps.map((pump) => pump.task));
    entry.completion = runWithLogContext(this.logContext(entry), async () => {
      const exitCode = await child.exited;
      entry.terminalCause ??= "natural";
      entry.exitCode = exitCode;
      await this.drainOutput(entry, pumps.map((pump) => pump.reader), outputDrain);
      await entry.output.close();
      entry.endedAt = Date.now() / 1_000;
      entry.status = entry.terminalCause === "terminated"
        ? "killed"
        : exitCode === 0 ? "completed" : "failed";
      this.logger.info("process_completed", this.processFields(entry));
      await this.notifyCompletion(entry);
    });
    return { entry };
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
    // Termination is claimed and issued before waiting for the observation lock.
    // This wakes an active long poll and gives the terminating observation priority
    // over ordinary observations that were already queued behind it.
    const termination = request.terminate && entry.endedAt === undefined
      ? this.requestTermination(entry, "process_killed")
      : undefined;
    return this.withObservation(entry, async () => {
      if (entry.finalObserved && !request.terminate) {
        return { error: `exec ${request.execId} 不存在或已经关闭。` };
      }
      entry.recency = this.touch();
      if (request.terminate) {
        await termination;
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
      this.describeOutputCompleteness(entry, payload);
      this.describeTruncation(entry, payload, slice.missed);
      entry.outputCursor = slice.cursor;
      return payload;
    }, request.terminate);
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

  private async withObservation<T>(
    entry: ProcessEntry,
    observe: () => Promise<T>,
    priority = false,
  ): Promise<T> {
    const release = await this.acquireObservation(entry, priority);
    try {
      return await observe();
    } finally {
      release();
    }
  }

  private acquireObservation(entry: ProcessEntry, priority: boolean): Promise<() => void> {
    const release = (): void => {
      const next = entry.observationQueue.shift();
      if (next) next.resolve(release);
      else entry.observationLocked = false;
    };
    if (!entry.observationLocked) {
      entry.observationLocked = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      const waiter = { priority, resolve };
      if (!priority) {
        entry.observationQueue.push(waiter);
        return;
      }
      const firstOrdinary = entry.observationQueue.findIndex((item) => !item.priority);
      if (firstOrdinary < 0) entry.observationQueue.push(waiter);
      else entry.observationQueue.splice(firstOrdinary, 0, waiter);
    });
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
    const transcriptDescription = entry.outputIncomplete
      ? "排空截止前捕获的输出"
      : "完整输出";
    return [
      `[... 已省略开头 ${omitted} 字节，只保留了输出末尾。`,
      `${transcriptDescription}在 ${entry.output.spillPath}`,
      "——用 grep 检索或 read 带 offset/limit 查看需要的片段，不要整个读回。 ...]",
    ].join("\n");
  }

  private describeOutputCompleteness(entry: ProcessEntry, payload: JsonObject): void {
    if (!entry.outputIncomplete) return;
    payload.output_incomplete = true;
    payload.output_incomplete_reason = entry.outputIncompleteReason ?? "stream_read_error";
    payload.output_warning = entry.outputIncompleteReason === "stream_drain_timeout"
      ? "进程退出后输出管道未在 2 秒内关闭；结果只包含截止排空期限前捕获的输出。"
      : "读取进程输出流时发生错误；结果只包含成功捕获的输出。";
  }

  private completedPayload(entry: ProcessEntry): JsonObject {
    const payload: JsonObject = {
      status: entry.status,
      exec_id: entry.id,
      exit_code: entry.exitCode,
      output: entry.output.renderRetained().trim() || "(no output)",
      duration_sec: this.duration(entry),
    };
    this.describeOutputCompleteness(entry, payload);
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
      output_incomplete: entry.outputIncomplete,
      output_incomplete_reason: entry.outputIncompleteReason ?? "",
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

  private async drainOutput(
    entry: ProcessEntry,
    readers: CancellableOutputReader[],
    drained: Promise<PromiseSettledResult<void>[]>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), OUTPUT_DRAIN_DEADLINE_MS);
    });
    const results = await Promise.race([drained, deadline]);
    if (timer) clearTimeout(timer);
    if (results === undefined) {
      entry.acceptingOutput = false;
      entry.outputIncomplete = true;
      entry.outputIncompleteReason = "stream_drain_timeout";
      this.logger.warn("process_output_drain_timeout", {
        ...this.processFields(entry),
        drain_deadline_ms: OUTPUT_DRAIN_DEADLINE_MS,
      });
      for (const reader of readers) {
        void reader.cancel("process output drain deadline reached").catch(() => undefined);
      }
      return;
    }
    entry.acceptingOutput = false;
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length === 0) return;
    entry.outputIncomplete = true;
    entry.outputIncompleteReason = "stream_read_error";
    this.logger.warn("process_output_read_failed", {
      ...this.processFields(entry),
      errors: failures.map((failure) => failure.reason),
    });
  }

  private async withAdmission<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.admissionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.admissionTails.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.admissionTails.get(sessionId) === current) this.admissionTails.delete(sessionId);
    }
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
        await this.requestTermination(victim, "process_force_killed");
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

  private requestTermination(
    entry: ProcessEntry,
    event: "process_killed" | "process_force_killed",
  ): Promise<void> {
    if (entry.endedAt !== undefined || entry.terminalCause === "natural") return entry.completion;
    entry.terminalCause ??= "terminated";
    const existing = entry.terminationTasks.get(event);
    if (existing) return existing;
    const task = runWithLogContext(this.logContext(entry), async () => {
      if (!entry.terminationEvents.has(event)) {
        entry.terminationEvents.add(event);
        this.logger.warn(event, this.processFields(entry));
      }
      await this.options.shell.terminate(entry.process, event === "process_force_killed");
    });
    entry.terminationTasks.set(event, task);
    return task;
  }

  onComplete: ((snapshot: JsonObject) => Promise<void> | void) | undefined;
}

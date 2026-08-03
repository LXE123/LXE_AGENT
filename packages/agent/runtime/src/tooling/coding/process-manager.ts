import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger, runWithLogContext } from "@lxe/core";
import type { JsonObject, WorkspaceContext } from "@lxe/protocol";
import type { RuntimeHandle } from "../../engine/types";
import type { ExecShellAdapter } from "../exec-shell";
import { ProcessOutputStore, sweepSpillDirectory } from "../process-output";
import type {
  ProcessCompletionConsumeReason,
  ProcessCompletionConsumeRequest,
  ProcessStatus,
} from "./public-types";

interface ProcessEntry {
  id: string;
  command: string;
  cwd: string;
  sessionId: string;
  turnId: string;
  responseRouteId: string;
  workspace: WorkspaceContext;
  startedAt: number;
  endedAt?: number;
  process: ReturnType<typeof Bun.spawn>;
  explicitBackground: boolean;
  status: ProcessStatus;
  exitCode: number | null;
  output: ProcessOutputStore;
  pollCursor: number;
  completion: Promise<void>;
  consumption?: Promise<void>;
  completionConsumed: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  notifyOnExit: boolean;
  terminationEvents: Set<"process_killed" | "process_force_killed">;
}

const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

const SPILL_DIRECTORY_SEGMENTS = ["var", "tmp", "exec"] as const;

export class CodingProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly sweptSpillRoots = new Set<string>();
  private readonly logger = createLogger("runtime.coding_process");

  constructor(private readonly options: {
    maxOutputBytes: number;
    tailBytes: number;
    ttlSeconds: number;
    shell: ExecShellAdapter;
  }) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    const incomplete = [...this.entries.values()].filter((entry) => entry.endedAt === undefined);
    await Promise.allSettled(incomplete.map((entry) => {
      if (entry.status === "running") entry.status = "killed";
      return this.terminateObserved(entry, "process_force_killed");
    }));
    await Promise.allSettled(incomplete.map((entry) => entry.completion));
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.output.close()));
  }

  snapshots(): JsonObject[] {
    this.sweep();
    return [...this.entries.values()].sort((left, right) => right.startedAt - left.startedAt).map((entry) => this.snapshot(entry));
  }

  async execute(request: {
    command: string;
    cwd: string;
    sessionId: string;
    responseRouteId: string;
    workspace: WorkspaceContext;
    background: boolean;
    yieldMs: number;
    timeoutMs?: number;
    handle: RuntimeHandle;
    turnId?: string;
    env?: Record<string, string>;
  }): Promise<JsonObject> {
    this.sweep();
    const id = `exec_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
        session: id,
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
      return { status: "failed", session: id, error: "spawned process did not expose stdout/stderr pipes" };
    }
    const spillDirectory = join(request.workspace.worktree, ...SPILL_DIRECTORY_SEGMENTS);
    if (!this.sweptSpillRoots.has(spillDirectory)) {
      this.sweptSpillRoots.add(spillDirectory);
      sweepSpillDirectory(spillDirectory);
    }
    const entry: ProcessEntry = {
      id,
      command: request.command,
      cwd: request.cwd,
      sessionId: request.sessionId,
      turnId: request.turnId ?? "",
      responseRouteId: request.responseRouteId,
      workspace: request.workspace,
      startedAt: Date.now() / 1_000,
      process: child,
      explicitBackground: request.background,
      status: "running" as ProcessStatus,
      exitCode: null,
      output: new ProcessOutputStore({
        retainBytes: this.options.maxOutputBytes,
        spillPath: join(spillDirectory, `${id}.log`),
      }),
      pollCursor: 0,
      completion: Promise.resolve(),
      completionConsumed: false,
      notifyOnExit: request.background,
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
      if (entry.timeout) clearTimeout(entry.timeout);
      this.logger.info("process_completed", this.processFields(entry));
      if (entry.notifyOnExit && this.onComplete) {
        try {
          await this.onComplete(this.snapshot(entry));
        } catch (error) {
          this.logger.warn("process_notification_failed", { ...this.processFields(entry), error });
        }
      }
    });
    if (!request.background && request.timeoutMs) {
      entry.timeout = setTimeout(() => {
        if (entry.status !== "running") return;
        entry.status = "timeout";
        void runWithLogContext(this.logContext(entry), async () => {
          this.logger.warn("process_timeout", this.processFields(entry));
          await this.options.shell.terminate(entry.process, false);
        });
      }, request.timeoutMs);
    }
    if (request.background) {
      runWithLogContext(this.logContext(entry), () => {
        this.logger.info("process_yielded_to_background", this.processFields(entry));
      });
      return this.runningPayload(entry);
    }

    const unregister = request.handle.registerProcess({
      kill: () => this.terminateObserved(entry, "process_killed"),
      forceKill: () => this.terminateObserved(entry, "process_force_killed"),
    });
    const abort = (): void => {
      entry.status = "killed";
      void this.terminateObserved(entry, "process_killed");
    };
    request.handle.signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([entry.completion, Bun.sleep(request.yieldMs)]);
      if (entry.status === "running") {
        entry.notifyOnExit = true;
        runWithLogContext(this.logContext(entry), () => {
          this.logger.info("process_yielded_to_background", this.processFields(entry));
        });
      }
      return entry.status === "running" ? this.runningPayload(entry) : this.completedPayload(entry);
    } finally {
      request.handle.signal.removeEventListener("abort", abort);
      unregister();
    }
  }

  async process(input: JsonObject, sessionId: string): Promise<JsonObject> {
    const action = inputText(input, "action").trim();
    if (action === "list") {
      this.sweep();
      const sessions = [...this.entries.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .sort((left, right) => right.startedAt - left.startedAt)
        .map((entry) => ({
          session: entry.id,
          command: entry.command.slice(0, 100),
          status: entry.status,
          pid: entry.process.pid,
          duration_sec: this.duration(entry),
        }));
      return { sessions, message: sessions.length === 0 ? "没有活跃或最近的会话。" : "" };
    }
    const id = inputText(input, "session").trim();
    const entry = this.entries.get(id);
    if (!id) return { error: "需要指定 session 参数。" };
    if (!entry || entry.sessionId !== sessionId) return { error: `会话 ${id} 不存在。` };
    if (action === "poll") {
      // Wake as soon as the command produces something rather than sleeping out the
      // whole window: a process that prints immediately and then keeps running used
      // to cost a full 5 seconds per poll.
      const deadline = Date.now() + 5_000;
      while (
        entry.status === "running"
        && entry.output.cursor === entry.pollCursor
        && Date.now() < deadline
      ) {
        await Promise.race([entry.completion, Bun.sleep(50)]);
      }
      const slice = entry.output.renderSince(entry.pollCursor);
      const payload: JsonObject = {
        session: entry.id,
        status: entry.status,
        new_output: slice.text || "(no new output)",
      };
      if (entry.status !== "running") {
        payload.exit_code = entry.exitCode;
        payload.duration_sec = this.duration(entry);
      }
      this.describeTruncation(entry, payload, slice.missed);
      // Only mark the slice delivered once consumption succeeded, so a failing
      // completion notification leaves the output readable on the next poll.
      if (entry.status !== "running") await this.consumeCompletion(entry, "process.poll");
      entry.pollCursor = slice.cursor;
      return payload;
    }
    if (action === "kill") {
      if (entry.status === "running") {
        entry.status = "killed";
        await this.terminateObserved(entry, "process_killed");
        await entry.completion;
      }
      await this.consumeCompletion(entry, "process.kill");
      if (entry.status !== "killed") return { message: `会话 ${id} 已经结束（${entry.status}）。` };
      return { status: "killed", session: id };
    }
    return { error: `未知 action: ${action}` };
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
      session: entry.id,
      exit_code: entry.exitCode,
      output: entry.output.renderRetained().trim() || "(no output)",
      duration_sec: this.duration(entry),
    };
    this.describeTruncation(entry, payload, true);
    return payload;
  }

  private runningPayload(entry: ProcessEntry): JsonObject {
    const message = entry.explicitBackground
      ? `命令仍在运行。除非用户明确要求，否则不要用 process(action='poll', session='${entry.id}') 查看进度。`
      : `命令仍在运行，完成后会自动通知你，请继续处理其他工作，不要轮询等待。只有需要查看中间进度时才用 process(action='poll', session='${entry.id}')。`;
    const payload: JsonObject = {
      status: entry.status,
      session: entry.id,
      pid: entry.process.pid,
      message,
      tail: entry.output.renderTail(this.options.tailBytes) || "(暂无输出)",
    };
    this.describeTruncation(entry, payload, false);
    return payload;
  }

  private snapshot(entry: ProcessEntry): JsonObject {
    const endedAt = entry.endedAt ?? null;
    return {
      task_id: entry.id,
      session: entry.id,
      session_id: entry.sessionId,
      response_route_id: entry.responseRouteId,
      session_title: "",
      origin_turn_id: entry.turnId,
      card_id: "",
      status: entry.status,
      pid: entry.process.pid,
      command: entry.command,
      cwd: entry.cwd,
      workspace: entry.workspace,
      started_at: entry.startedAt,
      ended_at: endedAt,
      duration_sec: this.duration(entry),
      background: entry.status === "running",
      exit_code: entry.exitCode,
      truncated: entry.output.truncated,
      output_path: entry.output.spillPath,
      output_tail: entry.output.renderTail(this.options.tailBytes),
    };
  }

  private async consumeCompletion(
    entry: ProcessEntry,
    reason: ProcessCompletionConsumeReason,
  ): Promise<void> {
    if (entry.status === "running" || entry.completionConsumed) return;
    await entry.completion;
    if (entry.completionConsumed) return;
    let consumption = entry.consumption;
    if (!consumption) {
      consumption = runWithLogContext(this.logContext(entry), async () => {
        if (entry.completionConsumed || entry.status === "running") return;
        if (entry.notifyOnExit && this.onConsume) {
          await this.onConsume({
            session_id: entry.sessionId,
            task_id: entry.id,
            status: entry.status,
            reason,
          });
        }
        entry.completionConsumed = true;
        entry.notifyOnExit = false;
      });
      entry.consumption = consumption;
      void consumption.finally(() => {
        if (entry.consumption === consumption) delete entry.consumption;
      }).catch(() => undefined);
    }
    await consumption;
  }

  private sweep(): void {
    const cutoff = Date.now() / 1_000 - this.options.ttlSeconds;
    for (const [id, entry] of this.entries) {
      if (entry.status !== "running" && (entry.endedAt ?? Number.POSITIVE_INFINITY) < cutoff) this.entries.delete(id);
    }
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
  onConsume: ((request: ProcessCompletionConsumeRequest) => Promise<void> | void) | undefined;
}

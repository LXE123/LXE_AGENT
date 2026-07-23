import { randomUUID } from "node:crypto";
import { createLogger, runWithLogContext } from "@lxe/core";
import type { JsonObject, WorkspaceContext } from "@lxe/protocol";
import type { RuntimeHandle } from "../../engine/types";
import type { ExecShellAdapter } from "../exec-shell";
import {
  appendLimitedBytes,
  appendTailBytes,
  combineProcessStreams,
  decodeProcessOutput,
} from "../process-output";
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
  stdout: Uint8Array;
  stderr: Uint8Array;
  pendingStdout: Uint8Array;
  pendingStderr: Uint8Array;
  stdoutTail: Uint8Array;
  stderrTail: Uint8Array;
  truncated: boolean;
  completion: Promise<void>;
  consumption?: Promise<void>;
  completionConsumed: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  notifyOnExit: boolean;
  terminationEvents: Set<"process_killed" | "process_force_killed">;
}

const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

const processLines = (value: string): string[] => {
  if (!value) return [];
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

export class CodingProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly logger = createLogger("runtime.coding_process");

  constructor(private readonly options: {
    maxOutputBytes: number;
    maxPendingBytes: number;
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
        stdin: "pipe",
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
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      pendingStdout: new Uint8Array(),
      pendingStderr: new Uint8Array(),
      stdoutTail: new Uint8Array(),
      stderrTail: new Uint8Array(),
      truncated: false,
      completion: Promise.resolve(),
      completionConsumed: false,
      notifyOnExit: request.background,
      terminationEvents: new Set(),
    };
    this.entries.set(id, entry);
    runWithLogContext(this.logContext(entry), () => {
      this.logger.info("process_started", this.processFields(entry));
    });
    const append = (value: Uint8Array, isStderr: boolean): void => {
      if (isStderr) {
        const output = appendLimitedBytes(entry.stderr, value, this.options.maxOutputBytes);
        const pending = appendLimitedBytes(entry.pendingStderr, value, this.options.maxPendingBytes);
        entry.stderr = output.bytes;
        entry.pendingStderr = pending.bytes;
        entry.stderrTail = appendTailBytes(entry.stderrTail, value, this.options.tailBytes);
        entry.truncated ||= output.truncated || pending.truncated;
        return;
      }
      const output = appendLimitedBytes(entry.stdout, value, this.options.maxOutputBytes);
      const pending = appendLimitedBytes(entry.pendingStdout, value, this.options.maxPendingBytes);
      entry.stdout = output.bytes;
      entry.pendingStdout = pending.bytes;
      entry.stdoutTail = appendTailBytes(entry.stdoutTail, value, this.options.tailBytes);
      entry.truncated ||= output.truncated || pending.truncated;
    };
    const pump = async (stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> => {
      const reader = stream.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        append(chunk.value, isStderr);
      }
    };
    const stdoutTask = pump(stdout, false);
    const stderrTask = pump(stderr, true);
    entry.completion = runWithLogContext(this.logContext(entry), async () => {
      const exitCode = await child.exited;
      await Promise.allSettled([stdoutTask, stderrTask]);
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
      if (entry.status === "running" && entry.pendingStdout.byteLength === 0 && entry.pendingStderr.byteLength === 0) {
        await Promise.race([entry.completion, Bun.sleep(5_000)]);
      }
      const payload: JsonObject = {
        session: entry.id,
        status: entry.status,
        new_output: combineProcessStreams(entry.pendingStdout, entry.pendingStderr) || "(no new output)",
      };
      if (entry.status !== "running") {
        payload.exit_code = entry.exitCode;
        payload.duration_sec = this.duration(entry);
      }
      if (entry.truncated) payload.truncated = true;
      if (entry.status !== "running") await this.consumeCompletion(entry, "process.poll");
      entry.pendingStdout = new Uint8Array();
      entry.pendingStderr = new Uint8Array();
      return payload;
    }
    if (action === "log") {
      const stdoutLines = processLines(decodeProcessOutput(entry.stdout));
      const stderrLines = processLines(decodeProcessOutput(entry.stderr));
      const offset = Math.max(0, Number(input.offset ?? 1) - 1);
      const limit = Math.max(1, Math.min(Number(input.limit ?? 2_000), 10_000));
      const totalLines = Math.max(stdoutLines.length, stderrLines.length);
      const showingEnd = Math.min(totalLines, offset + limit);
      const output = combineProcessStreams(
        new TextEncoder().encode(stdoutLines.slice(offset, offset + limit).join("\n")),
        new TextEncoder().encode(stderrLines.slice(offset, offset + limit).join("\n")),
      ) || "(no output)";
      const payload: JsonObject = {
        session: entry.id,
        total_lines: totalLines,
        showing: totalLines ? `${offset + 1}-${showingEnd}` : "0-0",
        output,
      };
      if (showingEnd < totalLines) payload.message = `还有 ${totalLines - showingEnd} 行。用 offset=${showingEnd + 1} 继续。`;
      if (entry.truncated) payload.truncated = true;
      if (entry.status !== "running") await this.consumeCompletion(entry, "process.log");
      return payload;
    }
    if (action === "write") {
      const text = inputText(input, "text");
      if (!text) return { error: "write 操作需要 text 参数。" };
      if (entry.status !== "running") return { error: `会话 ${id} 已结束，无法写入。` };
      const stdin = entry.process.stdin;
      if (!stdin || typeof stdin === "number") return { error: `会话 ${id} 不支持写入。` };
      try {
        stdin.write(`${text}\n`);
        return { status: "ok", session: id, message: `已写入 ${Buffer.byteLength(`${text}\n`)} 字节。` };
      } catch (error) {
        return { error: `写入失败: ${error instanceof Error ? error.message : String(error)}` };
      }
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
    if (action === "remove") {
      if (entry.status === "running") {
        entry.status = "killed";
        await this.terminateObserved(entry, "process_killed");
        await entry.completion;
      }
      await this.consumeCompletion(entry, "process.remove");
      this.entries.delete(id);
      return { status: "removed", session: id };
    }
    return { error: `未知 action: ${action}` };
  }

  private duration(entry: ProcessEntry): number {
    return Math.max(0, (entry.endedAt ?? Date.now() / 1_000) - entry.startedAt);
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

  private completedPayload(entry: ProcessEntry): JsonObject {
    return {
      status: entry.status,
      session: entry.id,
      exit_code: entry.exitCode,
      output: combineProcessStreams(entry.stdout, entry.stderr).trim() || "(no output)",
      duration_sec: this.duration(entry),
      ...(entry.truncated ? { truncated: true } : {}),
    };
  }

  private runningPayload(entry: ProcessEntry): JsonObject {
    const message = entry.explicitBackground
      ? `命令仍在运行。除非用户明确要求，否则不要用 process(action='poll', session='${entry.id}') 查看进度。`
      : `命令仍在运行，完成后会自动通知你，请继续处理其他工作，不要轮询等待。只有需要查看中间进度时才用 process(action='poll', session='${entry.id}')。`;
    return {
      status: entry.status,
      session: entry.id,
      pid: entry.process.pid,
      message,
      tail: combineProcessStreams(entry.stdoutTail, entry.stderrTail) || "(暂无输出)",
      ...(entry.truncated ? { truncated: true } : {}),
    };
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
      truncated: entry.truncated,
      output_tail: combineProcessStreams(entry.stdoutTail, entry.stderrTail),
    };
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
      truncated: entry.truncated,
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

import { describe, expect, test } from "bun:test";
import type { AgentJob, JsonObject } from "@lxe/protocol";
import { validateAgentJob } from "@lxe/protocol";
import {
  HeartbeatWakeQueue,
  RuntimeRequestError,
  RunHandle,
  SessionScheduler,
  type RuntimePort,
} from "../../src/orchestration/scheduler";
import { testWorkspace } from "../workspace";

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const job = (sessionId: string, jobId: string, overrides: Partial<AgentJob> = {}): AgentJob => ({
  job_id: jobId,
  session_id: sessionId,
  session_key: `key:${sessionId}`,
  response_route_id: `route:${jobId}`,
  user_id: "user",
  conversation_id: "chat",
  is_group: false,
  message_id: `message:${jobId}`,
  user_input: `input:${jobId}`,
  job_kind: "turn",
  sender_nick: "tester",
  source: { platform: "feishu", chat_id: "chat", chat_type: "dm", user_id: "user" },
  raw_data: { keep: "yes", system_events: [{ id: "old" }] },
  user_content_blocks: [],
  workspace: testWorkspace,
  ...overrides,
});

class RecordingRuntime implements RuntimePort {
  readonly started: AgentJob[] = [];
  readonly cancelled: string[] = [];
  readonly steered: Array<{ runId: string; text: string }> = [];

  async startTurn(value: AgentJob): Promise<void> {
    this.started.push(value);
  }
  async cancelTurn(handle: RunHandle): Promise<void> {
    this.cancelled.push(handle.runId);
  }
  async steerTurn(handle: RunHandle, message: { text: string }): Promise<void> {
    this.steered.push({ runId: handle.runId, text: message.text });
  }
}

const completion = (
  runId: string,
  sessionId: string,
  payload: JsonObject = { status: "completed", session_id: sessionId, job_id: runId },
) => ({ kind: "runtime.turn.completed", run_id: runId, payload });

describe("RunHandle", () => {
  test("aborts registered processes and exposes one cancellation signal", async () => {
    const handle = new RunHandle(job("s1", "j1"));
    const calls: string[] = [];
    const unregister = handle.registerProcess({
      kill: () => { calls.push("kill"); },
      forceKill: async () => { calls.push("force"); },
    });
    expect(handle.signal.aborted).toBe(false);
    await handle.abort();
    expect(handle.signal.aborted).toBe(true);
    expect(handle.cancelled).toBe(true);
    expect(calls).toEqual(["kill"]);
    await handle.forceAbort();
    expect(calls).toEqual(["kill", "force"]);
    unregister();
  });
});

describe("SessionScheduler", () => {
  test("keeps a rejected start active until the Runtime terminates it while unhealthy", async () => {
    const startFailures: Array<{ runId: string; error: unknown }> = [];
    const runtime = new RecordingRuntime();
    runtime.startTurn = async (value: AgentJob): Promise<void> => {
      runtime.started.push(value);
      if (value.job_id === "j1") throw new Error("runtime unavailable");
    };
    const scheduler = new SessionScheduler({
      runtime,
      maxConcurrency: 1,
      onStartFailure: (handle, error) => startFailures.push({ runId: handle.runId, error }),
    });
    await scheduler.enqueue(job("s1", "j1"));
    await scheduler.enqueue(job("s1", "j2"));
    await tick();

    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1"]);
    expect(scheduler.activeRun("s1")?.jobId).toBe("j1");
    expect(startFailures).toHaveLength(1);

    scheduler.setRuntimeReady(false);
    expect(scheduler.terminateActiveRun("j1", "s1")).toBe(true);
    expect(scheduler.terminateActiveRun("j1", "s1")).toBe(false);
    expect(scheduler.activeRun("s1")).toBeUndefined();
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1"]);

    scheduler.setRuntimeReady(true);
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1", "j2"]);
  });

  test("does not dispatch queued jobs until runtime readiness is restored", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    scheduler.setRuntimeReady(false);
    await scheduler.enqueue(job("s1", "j1"));
    await tick();
    expect(runtime.started).toEqual([]);
    expect(scheduler.hasInflightWork("s1")).toBe(true);

    scheduler.setRuntimeReady(true);
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1"]);
  });

  test("serializes a session while running distinct sessions up to the global cap", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 2 });
    await scheduler.enqueue(job("s1", "j1"));
    await scheduler.enqueue(job("s1", "j2"));
    await scheduler.enqueue(job("s2", "j3"));
    await scheduler.enqueue(job("s3", "j4"));
    await tick();

    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1", "j3"]);
    expect(scheduler.activeRun("s1")?.jobId).toBe("j1");
    expect(scheduler.hasInflightWork("s1")).toBe(true);

    expect(scheduler.handleRuntimeEvent(completion("j1", "s1"))).toBe(true);
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1", "j3", "j4"]);
    expect(scheduler.handleRuntimeEvent(completion("j3", "s2"))).toBe(true);
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1", "j3", "j4", "j2"]);
  });

  test("does not release on start acknowledgement and ignores stale or mismatched completions", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    await scheduler.enqueue(job("s1", "j1"));
    await scheduler.enqueue(job("s1", "j2"));
    await tick();

    scheduler.handleStartAcknowledged("j1");
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1"]);
    expect(scheduler.handleRuntimeEvent(completion("stale", "s1"))).toBe(false);
    expect(scheduler.handleRuntimeEvent(completion("j1", "wrong"))).toBe(false);
    expect(
      scheduler.handleRuntimeEvent({
        kind: "runtime.turn.completed",
        run_id: "j1",
        payload: { status: "completed" },
      }),
    ).toBe(false);
    expect(scheduler.handleRuntimeEvent({ kind: "runtime.emit", run_id: "j1", payload: {} })).toBe(false);
    expect(scheduler.activeRun("s1")?.jobId).toBe("j1");

    expect(scheduler.handleRuntimeEvent(completion("j1", "s1"))).toBe(true);
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1", "j2"]);
  });

  test("requeues non-cancelled remaining steering at the front with compatible job semantics", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({
      runtime,
      maxConcurrency: 1,
      id: () => "requeued-id",
    });
    await scheduler.enqueue(job("s1", "j1"));
    await scheduler.enqueue(job("s1", "already-queued"));
    await tick();

    const payload: JsonObject = {
      status: "completed",
      session_id: "s1",
      job_id: "j1",
      remaining_steering: [
        { text: " first ", response_route_id: "route-steer-1", message_id: "message-steer-1" },
        { text: "second", response_route_id: "route-steer-2", message_id: "message-steer-2" },
      ],
    };
    expect(scheduler.handleRuntimeEvent(completion("j1", "s1", payload))).toBe(true);
    await tick();

    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1", "requeued-id"]);
    const requeued = runtime.started[1]!;
    expect(requeued).toEqual({
      ...job("s1", "j1"),
      job_id: "requeued-id",
      response_route_id: "route-steer-2",
      message_id: "message-steer-2",
      user_input: "first\n\nsecond",
      raw_data: { keep: "yes" },
      user_content_blocks: [],
    });
  });

  test("drops remaining steering for cancelled completions", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1, id: () => "must-not-run" });
    await scheduler.enqueue(job("s1", "j1"));
    await tick();
    scheduler.handleRuntimeEvent(
      completion("j1", "s1", {
        status: "cancelled",
        session_id: "s1",
        job_id: "j1",
        remaining_steering: [{ text: "lost" }],
      }),
    );
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1"]);
  });

  test("stop clears pending jobs and cancels only the active matching run", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    await scheduler.enqueue(job("s1", "j1"));
    await scheduler.enqueue(job("s1", "j2"));
    await tick();

    expect(scheduler.clearPending("s1")).toBe(1);
    expect(await scheduler.requestStop("s1")).toBe(true);
    expect(runtime.cancelled).toEqual(["j1"]);
    expect(await scheduler.requestStop("missing")).toBe(false);
    scheduler.handleRuntimeEvent(completion("j1", "s1", { status: "cancelled", session_id: "s1" }));
    await tick();
    expect(runtime.started.map((item) => item.job_id)).toEqual(["j1"]);
  });

  test("steers only an active run through the runtime port", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    await scheduler.enqueue(job("s1", "j1"));
    await tick();
    expect(
      await scheduler.steerActive("s1", {
        text: " new direction ",
        response_route_id: "route-new",
        message_id: "message-new",
      }),
    ).toBe(true);
    expect(runtime.steered).toEqual([{ runId: "j1", text: "new direction" }]);
    expect(await scheduler.steerActive("missing", { text: "x" })).toBe(false);
  });

  test.each(["run_closing", "run_not_found"])(
    "falls back when steering receives protocol error %s",
    async (code: string) => {
      const runtime = new RecordingRuntime();
      runtime.steerTurn = async (): Promise<void> => {
        throw new RuntimeRequestError(code, "run closed");
      };
      const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
      await scheduler.enqueue(job("s1", "j1"));
      await tick();
      expect(await scheduler.steerActive("s1", { text: "fallback" })).toBe(false);
    },
  );

  test.each(["run_closing", "run_not_found"])(
    "does not mark cancellation accepted for protocol error %s",
    async (code: string) => {
      const runtime = new RecordingRuntime();
      runtime.cancelTurn = async (): Promise<void> => {
        throw new RuntimeRequestError(code, "run closed");
      };
      const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1, id: () => "requeued" });
      await scheduler.enqueue(job("s1", "j1"));
      await tick();
      expect(await scheduler.requestStop("s1")).toBe(false);
      expect(scheduler.activeRun("s1")?.cancelRequested).toBe(false);

      scheduler.handleRuntimeEvent(
        completion("j1", "s1", {
          status: "completed",
          session_id: "s1",
          remaining_steering: [{ text: "keep me" }],
        }),
      );
      await tick();
      expect(runtime.started.map((item) => item.job_id)).toEqual(["j1", "requeued"]);
    },
  );

  test("coalesces concurrent and repeated accepted stop requests", async () => {
    const runtime = new RecordingRuntime();
    let resolveCancel!: () => void;
    const cancelAccepted = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    let calls = 0;
    runtime.cancelTurn = async (): Promise<void> => {
      calls += 1;
      await cancelAccepted;
    };
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    await scheduler.enqueue(job("s1", "j1"));
    await tick();
    const first = scheduler.requestStop("s1");
    const second = scheduler.requestStop("s1");
    await tick();
    expect(calls).toBe(1);
    resolveCancel();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await scheduler.requestStop("s1")).toBe(true);
    expect(calls).toBe(1);
  });

  test("propagates unexpected cancel errors without poisoning the handle", async () => {
    const runtime = new RecordingRuntime();
    runtime.cancelTurn = async (): Promise<void> => {
      throw new Error("transport bug");
    };
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    await scheduler.enqueue(job("s1", "j1"));
    await tick();
    await expect(scheduler.requestStop("s1")).rejects.toThrow("transport bug");
    expect(scheduler.activeRun("s1")?.cancelRequested).toBe(false);
  });
});

describe("HeartbeatWakeQueue", () => {
  test("coalesces by session and creates scheduler jobs with compatible fields", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 2 });
    const wakes = new HeartbeatWakeQueue({
      scheduler,
      hasPendingEvents: async () => true,
      loadSession: async () => ({
        session_id: "s1",
        workspace: testWorkspace,
        source: {
          platform: "feishu",
          chat_id: "chat",
          chat_type: "group",
          user_id: "open",
          user_id_alt: "union",
          user_name: "Tester",
        },
      }),
      isSuspended: () => false,
      id: () => "heartbeat-id",
    });
    wakes.request({ session_id: "s1", reason: "retry", response_route_id: "route-old" });
    wakes.request({ session_id: "s1", reason: "exec-event", response_route_id: "" });
    expect(wakes.pendingCount).toBe(1);
    await wakes.flush();
    await tick();

    expect(runtime.started).toEqual([
      {
        job_id: "heartbeat-id",
        session_id: "s1",
        session_key: "agent:main:feishu:group:chat:union",
        response_route_id: "route-old",
        user_id: "union",
        conversation_id: "chat",
        is_group: true,
        message_id: "",
        user_input: "",
        job_kind: "heartbeat",
        sender_nick: "Tester",
        source: {
          platform: "feishu",
          chat_id: "chat",
          chat_type: "group",
          user_id: "open",
          user_id_alt: "union",
          user_name: "Tester",
        },
        raw_data: {
          heartbeat_reason: "exec-event",
          session_key: "agent:main:feishu:group:chat:union",
          source: {
            platform: "feishu",
            chat_id: "chat",
            chat_type: "group",
            user_id: "open",
            user_id_alt: "union",
            user_name: "Tester",
          },
        },
        user_content_blocks: [],
        workspace: testWorkspace,
      },
    ]);
    expect(validateAgentJob(runtime.started[0])).toBe(true);
  });

  test("drops suspended/no-event sessions and defers busy sessions as retry", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    await scheduler.enqueue(job("busy", "active"));
    await tick();
    const wakes = new HeartbeatWakeQueue({
      scheduler,
      hasPendingEvents: async (sessionId) => sessionId !== "empty",
      loadSession: async (sessionId) => ({
        session_id: sessionId,
        workspace: testWorkspace,
        source: { platform: "feishu", chat_id: sessionId, chat_type: "dm", user_id: "user" },
      }),
      isSuspended: (sessionId) => sessionId === "suspended",
      id: () => "heartbeat",
    });
    wakes.request({ session_id: "suspended", reason: "exec-event" });
    wakes.request({ session_id: "empty", reason: "exec-event" });
    wakes.request({ session_id: "busy", reason: "exec-event" });
    await wakes.flush();
    expect(wakes.pendingCount).toBe(1);
    expect(wakes.peek("busy")?.reason).toBe("retry");
    expect(runtime.started.map((item) => item.job_id)).toEqual(["active"]);
  });

  test("drops a deferred heartbeat after the active turn consumes its last event", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    await scheduler.enqueue(job("busy", "active"));
    await tick();
    let hasPendingEvent = true;
    const wakes = new HeartbeatWakeQueue({
      scheduler,
      hasPendingEvents: async () => hasPendingEvent,
      loadSession: async () => ({
        session_id: "busy",
        source: { platform: "feishu", chat_id: "busy", chat_type: "dm", user_id: "user" },
        workspace: testWorkspace,
      }),
      isSuspended: () => false,
      id: () => "unexpected-heartbeat",
    });
    wakes.request({ session_id: "busy", reason: "exec-event" });
    await wakes.flush();
    expect(wakes.peek("busy")?.reason).toBe("retry");

    hasPendingEvent = false;
    expect(scheduler.handleRuntimeEvent(completion("active", "busy"))).toBe(true);
    await wakes.flush();
    await tick();

    expect(wakes.pendingCount).toBe(0);
    expect(runtime.started.map((item) => item.job_id)).toEqual(["active"]);
  });

  test("drops an invalid source without aborting other wakes in the batch", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 2 });
    const wakes = new HeartbeatWakeQueue({
      scheduler,
      hasPendingEvents: async () => true,
      loadSession: async (sessionId) => ({
        session_id: sessionId,
        workspace: testWorkspace,
        source:
          sessionId === "invalid"
            ? { platform: "feishu", chat_type: "dm", user_id: "user" }
            : { platform: "feishu", chat_id: "valid", chat_type: "dm", user_id: "user" },
      }),
      isSuspended: () => false,
      id: () => "heartbeat-valid",
    });
    wakes.request({ session_id: "invalid" });
    wakes.request({ session_id: "valid" });
    await expect(wakes.flush()).resolves.toBe("none");
    await tick();
    expect(runtime.started.map((item) => item.session_id)).toEqual(["valid"]);
  });

  test("signals reschedule when a wake arrives during a running batch", async () => {
    const runtime = new RecordingRuntime();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 2 });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const wakes = new HeartbeatWakeQueue({
      scheduler,
      hasPendingEvents: async (sessionId) => {
        if (sessionId === "first") {
          firstEntered();
          await firstBlocked;
        }
        return true;
      },
      loadSession: async (sessionId) => ({
        session_id: sessionId,
        workspace: testWorkspace,
        source: { platform: "feishu", chat_id: sessionId, chat_type: "dm", user_id: "user" },
      }),
      isSuspended: () => false,
      id: () => `heartbeat-${runtime.started.length + 1}`,
    });

    wakes.request({ session_id: "first" });
    const firstFlush = wakes.flush();
    await entered;
    wakes.request({ session_id: "second" });
    expect(await wakes.flush()).toBe("normal");
    expect(wakes.pendingCount).toBe(1);

    releaseFirst();
    expect(await firstFlush).toBe("normal");
    expect(wakes.pendingCount).toBe(1);
    expect(await wakes.flush()).toBe("none");
    await tick();
    expect(runtime.started.map((item) => item.session_id)).toEqual(["first", "second"]);
  });
});

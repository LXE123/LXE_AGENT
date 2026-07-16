import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentJob } from "@lxe/protocol";
import { ProcessAgentRuntime } from "../../src/orchestration/process-runtime";
import { RunHandle } from "../../src/orchestration/scheduler";

const runtimes: ProcessAgentRuntime[] = [];
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ProcessAgentRuntime", () => {
  test("uses stream-json stdio and keeps request responses correlated", async () => {
    const states: string[] = [];
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: process.env,
      resourceRoot: process.cwd(),
      dataRoot: process.cwd(),
      workspaceRoot: process.cwd(),
      onStatus: (status) => states.push(status.state),
    });
    runtimes.push(runtime);

    await runtime.start();
    expect(runtime.isReady).toBe(true);
    expect(await runtime.remoteHealth()).toMatchObject({ ready: true, fake: true });
    expect(await runtime.dashboardRequest({ method: "GET", path: "/api/models" }))
      .toEqual({ status: 200, body: { path: "/api/models" } });
    await runtime.stop();

    expect(runtime.status().state).toBe("stopped");
    expect(states).toContain("starting");
    expect(states).toContain("ready");
  });

  test("recovers an unexpectedly crashed agent process", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const root = mkdtempSync(join(tmpdir(), "lxe-agent-process-"));
    temporaryRoots.push(root);
    const crashMarker = join(root, "crashed.once");
    const states: string[] = [];
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_AGENT_CRASH_MARKER: crashMarker },
      resourceRoot: process.cwd(),
      dataRoot: root,
      workspaceRoot: root,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [10, 20],
      onStatus: (status) => states.push(status.state),
    });
    runtimes.push(runtime);
    await runtime.start();

    await expect(runtime.dashboardRequest({ method: "GET", path: "/api/crash" })).rejects.toThrow("exited");
    expect(existsSync(crashMarker)).toBe(true);
    const deadline = performance.now() + 3_000;
    while (states.filter((state) => state === "ready").length < 2 && performance.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(states).toContain("error");
    expect(states.filter((state) => state === "ready")).toHaveLength(2);
    expect(runtime.isReady).toBe(true);
    expect(await runtime.remoteHealth()).toMatchObject({ ready: true, fake: true });
  }, 10_000);

  test("forwards steering and deduplicates cancellation for an active turn", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: process.env,
      resourceRoot: process.cwd(),
      dataRoot: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    runtimes.push(runtime);
    await runtime.start();
    const job: AgentJob = {
      job_id: "job-1",
      session_id: "session-1",
      session_key: "session-1",
      response_route_id: "route-1",
      user_id: "user-1",
      conversation_id: "conversation-1",
      is_group: false,
      message_id: "message-1",
      user_input: "hello",
      job_kind: "turn",
      sender_nick: "tester",
      source: {},
      raw_data: {},
      user_content_blocks: [],
    };
    const handle = new RunHandle(job);
    const turn = runtime.runTurn(job, handle);
    await Bun.sleep(10);

    await runtime.steerTurn(handle, {
      text: "steer",
      response_route_id: "route-1",
      message_id: "message-2",
    });
    await runtime.cancelTurn(handle);
    await handle.abort();

    expect(await turn).toMatchObject({ status: "cancelled" });
    expect(await runtime.remoteHealth()).toMatchObject({ cancel_count: 1 });
  });
});

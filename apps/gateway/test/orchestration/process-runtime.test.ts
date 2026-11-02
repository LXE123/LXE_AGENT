import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentJob } from "@lxe/protocol";
import { AgentProtocolError, type AgentEvent } from "@lxe/desktop-protocol";
import { ProcessAgentRuntime } from "../../src/orchestration/process-runtime";
import { RunHandle } from "../../src/orchestration/scheduler";
import { testWorkspace, workspaceFor } from "../workspace";

const runtimes: ProcessAgentRuntime[] = [];
const temporaryRoots: string[] = [];
const waitFor = async (
  predicate: () => boolean,
  label: string,
  details: () => string,
  timeoutMs = 8_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error(`timed out waiting for ${label}: ${details()}`);
};
const removeTemporaryRoot = async (root: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code) || attempt >= 19) throw error;
      await Bun.sleep(50);
    }
  }
};
const resourcePaths = (root: string) => ({
  skillsRoot: join(root, "skills"),
  userSkillsRoot: join(root, "user-skills"),
  llmConfigRoot: join(root, "config", "llm"),
});
const agentJob = (): AgentJob => ({
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
  diagnostics: [],
  workspace: testWorkspace,
});

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const root of temporaryRoots.splice(0)) await removeTemporaryRoot(root);
});

describe("ProcessAgentRuntime", () => {
  test.skipIf(process.platform!=="win32")("Windows forced shutdown waits for the runtime and its owned child",async()=>{
    const root=mkdtempSync(join(tmpdir(),"lxe-update-process-tree-"));temporaryRoots.push(root);
    const pidFile=join(root,"owned.pid");
    const runtime=new ProcessAgentRuntime({command:process.execPath,arguments:[resolve(import.meta.dirname,"fixtures/fake-agent-cli.mjs")],cwd:process.cwd(),environment:{...process.env,FAKE_OWNED_CHILD_PID:pidFile,FAKE_IGNORE_SHUTDOWN:"1"},...resourcePaths(process.cwd()),dataRoot:root,legacyWorkspace:testWorkspace,shutdownTimeoutMs:50});
    runtimes.push(runtime);await runtime.start();const pid=Number(readFileSync(pidFile,"utf8"));
    try { expect(()=>process.kill(pid,0)).not.toThrow();await runtime.stop();expect(runtime.hasProcess).toBe(false);expect(()=>process.kill(pid,0)).toThrow(); }
    finally { try { process.kill(pid,"SIGKILL"); } catch {} }
  });
  test("an error from a live child preserves ownership until actual exit", async () => {
    const runtime=new ProcessAgentRuntime({command:process.execPath,arguments:[resolve(import.meta.dirname,"fixtures/fake-agent-cli.mjs")],cwd:process.cwd(),environment:process.env,...resourcePaths(process.cwd()),dataRoot:process.cwd(),legacyWorkspace:testWorkspace});
    runtimes.push(runtime);await runtime.start();
    const child=(runtime as any).child;
    child.emit("error",new Error("kill EPERM: fixture signal denied"));
    expect(runtime.hasProcess).toBe(true);expect(runtime.status().pid).toBe(child.pid);
    expect(runtime.status().message).toContain("kill EPERM");
    await runtime.stop();expect(runtime.hasProcess).toBe(false);
  });
  test("forwards Desktop stream batches through their dedicated callback", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const batches: Array<Extract<AgentEvent, { type: "conversation.stream.delta" }>["payload"]> = [];
    const events: AgentEvent[] = [];
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_DESKTOP_STREAM_EVENT: "1" },
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
      onDesktopStream: (batch) => { batches.push(batch); },
      onEvent: (event) => { events.push(event); },
    });
    runtimes.push(runtime);
    await runtime.start();
    const deadline = performance.now() + 2_000;
    while (batches.length === 0 && performance.now() < deadline) await Bun.sleep(10);

    expect(batches).toEqual([expect.objectContaining({
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
      seq: 1,
    })]);
    expect(events.some((event) => event.type === "conversation.stream.delta")).toBe(true);
  });

  test("forwards content-free persisted session change events", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const events: AgentEvent[] = [];
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_SESSION_CHANGE_EVENT: "1" },
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
      onEvent: (event) => { events.push(event); },
    });
    runtimes.push(runtime);
    await runtime.start();
    const deadline = performance.now() + 2_000;
    while (!events.some((event) => event.type === "session.changed") && performance.now() < deadline) {
      await Bun.sleep(10);
    }

    const change = events.find((event): event is Extract<AgentEvent, { type: "session.changed" }> =>
      event.type === "session.changed");
    expect(change).toEqual({

      type: "session.changed",
      thread_id: "session-1",
      payload: { changes: ["messages"] },
    });
    expect(JSON.stringify(change)).not.toContain("content");
  });

  test("uses stream-json stdio and keeps request responses correlated", async () => {
    const states: string[] = [];
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: process.env,
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
      onStatus: (status) => states.push(status.state),
    });
    runtimes.push(runtime);

    await runtime.start();
    expect(runtime.isReady).toBe(true);
    expect(runtime.status()).toMatchObject({
      logging: {
        local_file_enabled: true,
        file_path: "/tmp/runtime.log",
      },
    });
    expect(runtime.status()).not.toHaveProperty("lxeskillAvailable");
    expect(runtime.status()).not.toHaveProperty("lxeskillMessage");
    expect(await runtime.dashboardCall({ operation: "models.list", input: {} }))
      .toEqual({ items: [], total: 0 });
    expect(await runtime.resolveArtifact("session-1", "artifact-1")).toBe("/tmp/report.xlsx");
    expect(await runtime.resolveArtifact("session-2", "artifact-1")).toBeUndefined();
    expect(await runtime.resolveImagePreview("session-1", "image_view", "v")).toEqual({ source: "history", image: {
      type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" },
    } });
    expect(await runtime.resolveImagePreview("session-1", "attachment", "file")).toEqual({ source: "current_file", path: "/tmp/source.png" });
    expect(await runtime.resolveImagePreview("other", "image_view", "v")).toBeUndefined();
    // Await pipe I/O before entering Bun's matcher; rejects.toThrow can stall it on Windows.
    const previewError = await runtime.resolveImagePreview("session-1", "attachment", "malformed")
      .catch((error: unknown) => error);
    expect(previewError).toBeInstanceOf(Error);
    expect((previewError as Error).message).toContain("malformed image preview source");
    await runtime.stop();

    expect(runtime.status().state).toBe("stopped");
    expect(states).toContain("starting");
    expect(states).toContain("ready");
  });

  test("starts fail-closed and updates Skill permissions without restarting", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const root = mkdtempSync(join(tmpdir(), "lxe-agent-permission-"));
    temporaryRoots.push(root);
    const permissionPath = join(root, "permissions.json");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_SKILL_PERMISSION_PATH: permissionPath },
      ...resourcePaths(process.cwd()),
      dataRoot: root,
      legacyWorkspace: workspaceFor(root),
    });
    runtimes.push(runtime);

    await runtime.start();
    expect(JSON.parse(readFileSync(permissionPath, "utf8"))).toEqual([]);
    await runtime.updateSkillPermissions(["amazon_fba", "default", "default"]);
    expect(JSON.parse(readFileSync(permissionPath, "utf8"))).toEqual(["amazon_fba", "default"]);
    await runtime.updateManagedLlmCredential({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      api_key: "managed-secret",
      credential_revision: "f".repeat(64),
      fetched_at: 123,
      invalid_revision: "",
    });
    expect(runtime.isReady).toBe(true);
  });

  test("propagates an agent logging sink failure without changing process health", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const statuses: ReturnType<ProcessAgentRuntime["status"]>[] = [];
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_LOGGING_FAILURE_EVENT: "1" },
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
      onStatus: (status) => statuses.push(status),
    });
    runtimes.push(runtime);

    await runtime.start();
    await runtime.dashboardCall({ operation: "models.list", input: {} });
    await waitFor(
      () => runtime.status().logging?.disabled_reason === "sink_failed",
      "logging sink failure status",
      () => JSON.stringify(runtime.status().logging),
    );

    expect(runtime.status()).toMatchObject({
      state: "ready",
      logging: {
        local_file_enabled: false,
        disabled_reason: "sink_failed",
        last_error: "disk unavailable",
      },
    });
    expect(statuses.some((status) => status.logging?.disabled_reason === "sink_failed")).toBe(true);
  }, 15_000);

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
      ...resourcePaths(process.cwd()),
      dataRoot: root,
      legacyWorkspace: workspaceFor(root),
      requestTimeoutMs: 2_000,
      restartDelaysMs: [10, 20],
      onStatus: (status) => states.push(status.state),
    });
    runtimes.push(runtime);
    await runtime.start();

    await expect(runtime.dashboardCall({ operation: "models.list", input: {} })).rejects.toThrow("exited");
    expect(existsSync(crashMarker)).toBe(true);
    await waitFor(
      () => states.filter((state) => state === "ready").length >= 2,
      "agent process restart",
      () => `observed states: ${states.join(", ")}`,
    );

    expect(states).toContain("error");
    expect(states.filter((state) => state === "ready")).toHaveLength(2);
    expect(runtime.isReady).toBe(true);
    expect(await runtime.dashboardCall({ operation: "models.list", input: {} }))
      .toEqual({ items: [], total: 0 });
  }, 10_000);

  test("rejects incomplete or malformed run_turn results", async () => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const cases = [
      ["missing_steering", "remaining_steering must be an array"],
      ["malformed_steering", "message_id must be a string"],
      ["negative_counter", "input_tokens must be a non-negative safe integer"],
    ] as const;

    for (const [resultMode, expectedMessage] of cases) {
      const runtime = new ProcessAgentRuntime({
        command: process.execPath,
        arguments: [fixture],
        cwd: process.cwd(),
        environment: { ...process.env, FAKE_RUN_TURN_RESULT: resultMode },
        ...resourcePaths(process.cwd()),
        dataRoot: process.cwd(),
        legacyWorkspace: testWorkspace,
      });
      runtimes.push(runtime);
      await runtime.start();
      const job = agentJob();
      const error = await runtime.runTurn(job, new RunHandle(job)).catch((cause) => cause);
      expect(error).toBeInstanceOf(AgentProtocolError);
      expect(error).toHaveProperty("code", "AgentProtocolError");
      expect(error).toHaveProperty("message", expect.stringContaining(expectedMessage));
      await runtime.stop();
    }
  });

  test.each([undefined, "user_stop"] as const)("forwards steering and cancellation cause %s once for an active turn", async reason => {
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: process.env,
      ...resourcePaths(process.cwd()),
      dataRoot: process.cwd(),
      legacyWorkspace: testWorkspace,
    });
    runtimes.push(runtime);
    await runtime.start();
    const job = agentJob();
    const handle = new RunHandle(job);
    const turn = runtime.runTurn(job, handle);
    await Bun.sleep(10);

    await runtime.steerTurn(handle, {
      text: "steer",
      response_route_id: "route-1",
      message_id: "message-2",
    });
    await runtime.cancelTurn(handle, reason);
    await handle.abort();

    expect(await turn).toMatchObject({
      status: "cancelled",
      // The fixture echoes its cancel-turn request count; 1 proves the
      // handle.abort() kill callback was deduplicated against cancelTurn().
      tool_calls: 1,
      reply: reason ?? "",
      remaining_steering: [
        { text: "steer", response_route_id: "route-1", message_id: "message-2" },
      ],
    });
  });
});

test("termination waits for exit even when the child already reports killed",async()=>{
 const {EventEmitter}=await import("node:events");
 const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,killed:true,kill:()=>{setTimeout(()=>child.emit("exit",null,"SIGTERM"),50);return true;}});
 const runtime=new ProcessAgentRuntime({command:"unused",cwd:process.cwd(),environment:{},...resourcePaths(process.cwd()),dataRoot:process.cwd(),legacyWorkspace:testWorkspace});
 (runtime as any).child=child;
 let completed=false;
 const termination=(runtime as any).terminateChild().then(()=>{completed=true;});
 await Bun.sleep(10);expect(completed).toBe(false);expect(runtime.hasProcess).toBe(true);
 await termination;expect(runtime.hasProcess).toBe(false);
});
test("unconfirmed exit rejects and retains ownership after forced termination",async()=>{
 const {EventEmitter}=await import("node:events");
 const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,killed:true,kill:()=>true});
 const runtime=new ProcessAgentRuntime({command:"unused",cwd:process.cwd(),environment:{},...resourcePaths(process.cwd()),dataRoot:process.cwd(),legacyWorkspace:testWorkspace});
 (runtime as any).child=child;
 await expect((runtime as any).terminateChild()).rejects.toThrow("did not exit");expect(runtime.hasProcess).toBe(true);
},6000);

test.each([false,true])("parent exit cannot release ownership before tree termination (failure=%s)",async fail=>{
 const {EventEmitter}=await import("node:events");
 const child=Object.assign(new EventEmitter(),{pid:424242,exitCode:null as number|null,signalCode:null});
 const runtime=new ProcessAgentRuntime({command:"must-not-start",cwd:process.cwd(),environment:{},...resourcePaths(process.cwd()),dataRoot:process.cwd(),legacyWorkspace:testWorkspace});
 (runtime as any).child=child;
 let finish!:()=>void,failTree!:(error:Error)=>void;
 (runtime as any).terminateProcessTree=()=>new Promise<void>((resolve,reject)=>{finish=resolve;failTree=reject;});
 child.once("exit",()=>{(runtime as any).handleExit(new Error("parent exited"));});
 const termination=(runtime as any).terminateChild();
 child.exitCode=0;child.emit("exit",0,null);
 expect(runtime.hasProcess).toBe(true);expect(runtime.status().pid).toBe(child.pid);
 await expect(runtime.start()).rejects.toThrow("has not confirmed exit");
 if(fail){
  const failure=new Error("taskkill fixture: descendant access denied");
  failTree(failure);
  await expect(termination).rejects.toThrow(failure.message);
  expect(runtime.hasProcess).toBe(true);expect(runtime.status().message).toBe(failure.message);
  await expect(runtime.start()).rejects.toThrow(failure.message);
  await expect(runtime.stop()).rejects.toThrow(failure.message);
 }else{
  finish();await termination;expect(runtime.hasProcess).toBe(false);
 }
});

test.each([false, true])("concurrent protocol failures and stop share tree termination (failure=%s)", async fail => {
  const { EventEmitter } = await import("node:events");
  const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null as number | null, signalCode: null });
  const diagnostics: unknown[] = [];
  const runtime = new ProcessAgentRuntime({
    command: "must-not-start", cwd: process.cwd(), environment: {}, ...resourcePaths(process.cwd()),
    dataRoot: process.cwd(), legacyWorkspace: testWorkspace,
    logger: { debug() {}, info() {}, warn() {}, error(_message, fields) { diagnostics.push(fields); }, child() { return this; } },
  });
  (runtime as any).child = child;
  let finish!: () => void, failTree!: (error: Error) => void, treeCalls = 0;
  (runtime as any).terminateProcessTree = () => {
    treeCalls += 1;
    return new Promise<void>((resolve, reject) => { finish = resolve; failTree = reject; });
  };
  child.once("exit", () => { (runtime as any).handleExit(new Error("parent exited")); });
  const first = (runtime as any).failConnection(new Error("first invalid response"));
  const second = (runtime as any).failConnection(new Error("second invalid response"));
  child.exitCode = 0;
  child.emit("exit", 0, null);
  let stopSettled = false;
  const stopped = runtime.stop();
  void stopped.then(() => { stopSettled = true; }, () => { stopSettled = true; });
  const outcomes = Promise.allSettled([first, second, stopped]);
  await Bun.sleep(10);
  const stoppedBeforeTreeExit = stopSettled;
  const failure = new Error("taskkill fixture: descendant access denied");
  if (fail) failTree(failure); else finish();
  const results = await outcomes;
  expect(treeCalls).toBe(1);
  expect(stoppedBeforeTreeExit).toBe(false);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled", fail ? "rejected" : "fulfilled"]);
  expect(runtime.hasProcess).toBe(fail);
  if (fail) {
    expect(results[2]).toMatchObject({ reason: failure });
    expect(runtime.status().message).toBe(failure.message);
    expect(diagnostics).toContainEqual({ error: failure });
    const restartError = await runtime.start().catch(error => error);
    expect(restartError).toBe(failure);
  } else {
    expect(runtime.status().state).toBe("stopped");
    expect(diagnostics).toEqual([]);
  }
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentJob, InboundEvent, JsonObject } from "@lxe/protocol";
import { FakeChannelAdapter } from "../fake-channel";
import { createDirectGatewayComposition } from "../../src/orchestration/composition";
import { IngressClosedError } from "../../src/orchestration/lifecycle";
import { ProcessAgentRuntime } from "../../src/orchestration/process-runtime";
import { buildPermissionPolicy } from "../../src/security/permission-policy";
import { testWorkspace, workspaceFor } from "../workspace";

const roots: string[] = [];
const processRuntimes: ProcessAgentRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(processRuntimes.splice(0).map((runtime) => runtime.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const job = (): AgentJob => ({
  job_id: "j1", session_id: "s1", session_key: "key", response_route_id: "r1",
  user_id: "u1", conversation_id: "c1", is_group: false, message_id: "m1",
  user_input: "hello", job_kind: "turn", sender_nick: "Tester",
  source: { platform: "test", chat_id: "c1" }, raw_data: {}, user_content_blocks: [],
  diagnostics: [],
  workspace: testWorkspace,
});

const inboundEvent = (): InboundEvent => ({
  platform: "test",
  event_type: "message",
  user_input: "hello",
  user_id: "union-test",
  conversation_id: "chat",
  is_group: false,
  message_id: "message",
  sender_nick: "Tester",
  response_route_id: "route",
  union_id: "union-test",
  source: {},
  raw_data: {},
  user_content_blocks: [],
  diagnostics: [],
});

const storage = () => ({
  ensureSession: async () => undefined,
  upsertResponseRoute: async () => undefined,
  getSession: async () => ({ session_id: "s1", source: { platform: "test" }, workspace: testWorkspace }),
  appendPendingEvent: async () => undefined,
  hasPendingEvents: async () => false,
  getResponseRoute: async () => undefined,
  patchResponseRoute: async () => undefined,
});

const policy = () => buildPermissionPolicy({
  bots: { TEST: { key: "test", app_id: "app-test", skill_types: ["default"] } },
  users: { Tester: { union_id: "union-test", allow: ["TEST"] } },
}, "direct-test.yaml");

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(0);
};

const resourcePaths = (root: string) => ({
  agentSoulPath: join(root, "SOUL.md"),
  skillsRoot: join(root, "skills"),
  userSkillsRoot: join(root, "user-skills"),
  lxeskillCatalogPath: join(root, "python", "lxeskill_cli", "lxeskill", "catalog.json"),
  llmConfigRoot: join(root, "config", "llm"),
  permissionPolicyPath: join(root, "config", "permission_policy.yaml"),
});

describe("direct Gateway composition", () => {
  test("runs and completes a turn in-process while preserving lifecycle ordering", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-direct-"));
    roots.push(root);
    const order: string[] = [];
    class OrderedChannel extends FakeChannelAdapter {
      override async start(): Promise<void> {
        order.push("channel:start");
        await super.start();
      }
      override async stop(): Promise<void> {
        order.push("channel:stop");
        await super.stop();
      }
    }
    const channel = new OrderedChannel("test");
    let runtimeReady = false;
    const runtime = {
      get isReady() { return runtimeReady; },
      start: async () => { runtimeReady = true; order.push("runtime:start"); },
      stop: async () => { runtimeReady = false; order.push("runtime:stop"); },
      runTurn: async () => {
        order.push("runtime:turn");
        return {
          status: "completed" as const,
          reply: "done",
          input_tokens: 1,
          output_tokens: 1,
          tool_calls: 0,
          remaining_steering: [],
        };
      },
    };
    const composition = createDirectGatewayComposition({
      projectRoot: root,
      defaultWorkspace: () => testWorkspace,
      bindingsPath: join(root, "sessions.json"),
      policy: policy(),
      storage: storage(),
      runtime,
      channels: [channel],
    });

    await composition.start();
    await composition.parts.scheduler.enqueue(job());
    const deadline = Date.now() + 1_000;
    while (composition.parts.scheduler.hasInflightJobs() && Date.now() < deadline) await Bun.sleep(0);
    expect(composition.parts.scheduler.hasInflightJobs()).toBe(false);
    expect(order.slice(0, 2)).toEqual(["runtime:start", "channel:start"]);
    await composition.stop();
    expect(order).toContain("runtime:stop");
  });

  test("requeues remaining steering returned in the run outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-direct-"));
    roots.push(root);
    const jobs: AgentJob[] = [];
    let runtimeReady = false;
    const runtime = {
      get isReady() { return runtimeReady; },
      start: async () => { runtimeReady = true; },
      stop: async () => { runtimeReady = false; },
      runTurn: async (value: AgentJob) => {
        jobs.push(value);
        return {
          status: "completed" as const,
          reply: "done",
          input_tokens: 1,
          output_tokens: 1,
          tool_calls: 0,
          remaining_steering: jobs.length === 1
            ? [{ text: "follow up", response_route_id: "route-2", message_id: "m-2" }]
            : [],
        };
      },
    };
    const composition = createDirectGatewayComposition({
      projectRoot: root,
      defaultWorkspace: () => testWorkspace,
      bindingsPath: join(root, "sessions.json"),
      policy: policy(),
      storage: storage(),
      runtime,
    });

    await composition.start();
    await composition.parts.scheduler.enqueue(job());
    await waitFor(() => jobs.length >= 2);

    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.user_input).toBe("follow up");
    expect(jobs[1]?.response_route_id).toBe("route-2");
    expect(jobs[1]?.message_id).toBe("m-2");
    await waitFor(() => !composition.parts.scheduler.hasInflightJobs());
    await composition.stop();
  });

  test("uses the Runtime port as the live readiness source for ingress, health, and dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-direct-readiness-"));
    roots.push(root);
    const channel = new FakeChannelAdapter("test");
    const jobs: AgentJob[] = [];
    let runtimeReady = false;
    const runtime = {
      get isReady() { return runtimeReady; },
      start: async () => { runtimeReady = true; },
      stop: async () => { runtimeReady = false; },
      runTurn: async (value: AgentJob) => {
        jobs.push(value);
        return {
          status: "completed" as const,
          reply: "done",
          input_tokens: 1,
          output_tokens: 1,
          tool_calls: 0,
          remaining_steering: [],
        };
      },
    };
    const composition = createDirectGatewayComposition({
      projectRoot: root,
      defaultWorkspace: () => testWorkspace,
      bindingsPath: join(root, "sessions.json"),
      policy: policy(),
      storage: storage(),
      runtime,
      channels: [channel],
    });

    await composition.start();
    runtimeReady = false;
    composition.syncRuntimeReadiness();

    expect(await composition.health()).toMatchObject({
      ready: false,
      runtime: { ready: false },
    });
    await expect(channel.inboundSink!(inboundEvent())).rejects.toBeInstanceOf(IngressClosedError);

    await composition.parts.scheduler.enqueue(job());
    await Bun.sleep(10);
    expect(jobs).toHaveLength(0);
    expect(composition.parts.scheduler.hasInflightJobs()).toBe(true);

    runtimeReady = true;
    composition.syncRuntimeReadiness();
    await waitFor(() => jobs.length === 1 && !composition.parts.scheduler.hasInflightJobs());
    expect(jobs).toHaveLength(1);
    await composition.stop();
  });

  test("fails startup when Runtime start resolves without becoming ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-direct-not-ready-"));
    roots.push(root);
    const runtime = {
      isReady: false,
      start: async () => undefined,
      stop: async () => undefined,
      runTurn: async () => ({
        status: "completed" as const,
        reply: "",
        input_tokens: 0,
        output_tokens: 0,
        tool_calls: 0,
        remaining_steering: [],
      }),
    };
    const composition = createDirectGatewayComposition({
      projectRoot: root,
      defaultWorkspace: () => testWorkspace,
      bindingsPath: join(root, "sessions.json"),
      policy: policy(),
      storage: storage(),
      runtime,
    });

    await expect(composition.start()).rejects.toThrow("runtime is not ready");
    expect(await composition.health()).toMatchObject({
      ready: false,
      runtime: { ready: false },
    });
  });

  test("keeps composition health synchronized while the agent process crashes and recovers", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-direct-process-readiness-"));
    roots.push(root);
    const crashMarker = join(root, "crashed.once");
    const fixture = resolve(import.meta.dirname, "fixtures/fake-agent-cli.mjs");
    const channel = new FakeChannelAdapter("test");
    let composition: ReturnType<typeof createDirectGatewayComposition> | undefined;
    const runtime = new ProcessAgentRuntime({
      command: process.execPath,
      arguments: [fixture],
      cwd: process.cwd(),
      environment: { ...process.env, FAKE_AGENT_CRASH_MARKER: crashMarker },
      ...resourcePaths(process.cwd()),
      dataRoot: root,
      legacyWorkspace: workspaceFor(root),
      requestTimeoutMs: 2_000,
      restartDelaysMs: [100],
      onStatus: () => composition?.syncRuntimeReadiness(),
    });
    processRuntimes.push(runtime);
    composition = createDirectGatewayComposition({
      projectRoot: root,
      defaultWorkspace: () => workspaceFor(root),
      bindingsPath: join(root, "sessions.json"),
      policy: policy(),
      storage: storage(),
      runtime,
      channels: [channel],
    });

    await composition.start();
    expect((await composition.health()).ready).toBe(true);

    await expect(runtime.dashboardCall({ operation: "models.list", input: {} })).rejects.toThrow("exited");
    expect(await composition.health()).toMatchObject({
      ready: false,
      runtime: { ready: false },
    });
    await expect(channel.inboundSink!(inboundEvent())).rejects.toBeInstanceOf(IngressClosedError);

    await waitFor(() => runtime.isReady);
    expect(await composition.health()).toMatchObject({
      ready: true,
      runtime: { ready: true },
    });
    await composition.stop();
  });
});

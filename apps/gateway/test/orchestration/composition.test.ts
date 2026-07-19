import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentJob, JsonObject } from "@lxe/protocol";
import { FakeChannelAdapter } from "../fake-channel";
import { createDirectGatewayComposition } from "../../src/orchestration/composition";
import { buildPermissionPolicy } from "../../src/security/permission-policy";
import { testWorkspace } from "../workspace";

const roots: string[] = [];
afterEach(() => {
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
    const runtime = {
      start: async () => { order.push("runtime:start"); },
      stop: async () => { order.push("runtime:stop"); },
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
    const runtime = {
      start: async () => undefined,
      stop: async () => undefined,
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
});

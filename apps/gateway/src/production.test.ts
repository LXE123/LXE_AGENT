import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPermissionPolicy } from "./permission-policy";
import { createProductionGateway } from "./production";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const policy = () => buildPermissionPolicy(
  {
    bots: { TEST: { key: "test", app_id: "app-test", skill_types: ["default"] } },
    users: { Tester: { union_id: "union-test", allow: ["TEST"] } },
  },
  "production-test-policy.yaml",
);

describe("production Gateway application", () => {
  test("assembles only the in-process TypeScript Runtime", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lxe-production-"));
    roots.push(runtimeRoot);
    const calls: string[] = [];
    const storage = {
      ensureSession: async () => undefined,
      rebindSession: async () => undefined,
      upsertResponseRoute: async () => undefined,
      getSession: async () => ({ session_id: "s1", source: { platform: "test" } }),
      popPendingEvents: async () => [],
      appendPendingEvent: async () => undefined,
      hasPendingEvents: async () => false,
      getResponseRoute: async () => undefined,
      patchResponseRoute: async () => undefined,
    };
    const runtime = {
      start: async () => { calls.push("runtime:start"); },
      stop: async () => { calls.push("runtime:stop"); },
      runTurn: async () => ({
        status: "completed" as const,
        reply: "",
        input_tokens: 0,
        output_tokens: 0,
        tool_calls: 0,
      }),
    };
    const application = createProductionGateway({
      projectRoot: runtimeRoot,
      runtimeRoot,
      environment: {
        AGENT_DASHBOARD_ENABLED: "0",
        FEISHU_GATEWAY_ENABLED: "0",
        AGENT_MAX_CONCURRENCY: "3",
      },
      policy: policy(),
      directRuntime: runtime,
      directStorage: storage,
    });

    await application.start();
    expect(calls).toEqual(["runtime:start"]);
    expect(await application.health()).toEqual(expect.objectContaining({
      ready: true,
      runtime: { ready: true },
    }));
    expect(application.settings.maxConcurrency).toBe(3);
    expect(existsSync(join(runtimeRoot, "tmp", "gateway", "gateway-status.json"))).toBe(true);
    await application.stop();
    expect(calls).toEqual(["runtime:start", "runtime:stop"]);
    expect(existsSync(join(runtimeRoot, "tmp", "gateway", "gateway-status.json"))).toBe(false);
  });
});

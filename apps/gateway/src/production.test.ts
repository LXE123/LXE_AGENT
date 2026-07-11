import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerEnvelope } from "@lxe/protocol";
import { buildPermissionPolicy } from "./permission-policy";
import { createProductionGateway } from "./production";
import { ScriptedWorkerProcess } from "./worker-test-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const capabilities = {
  protocol_version: "1",
  worker_pid: 9001,
  capabilities: {
    request_kinds: [
      "worker.hello", "health", "session.ensure", "session.rebind", "response_route.upsert",
      "pending_events.pop", "pending_events.append", "turn.start", "turn.cancel", "turn.steer",
      "maintenance.run", "dashboard.query", "worker.shutdown",
    ],
    event_kinds: ["runtime.emit", "runtime.typing", "runtime.heartbeat_wake", "runtime.turn.completed"],
    maintenance_operations: ["mabang_erp_cookie_refresh", "data_server_sync"],
    dashboard_operations: ["session.get", "pending_events.has", "response_route.get"],
  },
};

describe("production Gateway application", () => {
  test("assembles config, lifecycle, status, dashboard, and runtime cleanup", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lxe-production-"));
    roots.push(runtimeRoot);
    const worker = new ScriptedWorkerProcess(9001, (request: WorkerEnvelope, current) => {
      if (request.kind === "worker.hello") current.reply(request, capabilities);
      else if (request.kind === "health") current.reply(request, { ready: true, active_run_count: 0 });
      else if (request.kind === "worker.shutdown") current.reply(request, { shutting_down: true });
      else current.reply(request, { result: {}, accepted: true });
    });
    const policy = buildPermissionPolicy(
      {
        bots: { TEST: { key: "test", app_id: "app-test", skill_types: ["default"] } },
        users: { Tester: { union_id: "union-test", allow: ["TEST"] } },
      },
      "production-test-policy.yaml",
    );
    const application = createProductionGateway({
      projectRoot: runtimeRoot,
      runtimeRoot,
      environment: {
        AGENT_DASHBOARD_ENABLED: "0",
        FEISHU_GATEWAY_ENABLED: "0",
        AGENT_MAX_CONCURRENCY: "3",
      },
      policy,
      spawnWorker: () => worker,
    });

    await application.start();
    expect(await application.health()).toEqual(expect.objectContaining({ ready: true }));
    expect(application.settings.maxConcurrency).toBe(3);
    expect(existsSync(join(runtimeRoot, "tmp", "gateway", "gateway-status.json"))).toBe(true);
    await application.stop();
    expect(existsSync(join(runtimeRoot, "tmp", "gateway", "gateway-status.json"))).toBe(false);
    expect(worker.stdinClosed).toBe(true);
  });
});

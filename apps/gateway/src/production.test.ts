import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lxe/core";
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

const fakeStorage = () => ({
  ensureSession: async () => undefined,
  rebindSession: async () => undefined,
  upsertResponseRoute: async () => undefined,
  getSession: async () => ({ session_id: "s1", source: { platform: "test" } }),
  popPendingEvents: async () => [],
  appendPendingEvent: async () => undefined,
  hasPendingEvents: async () => false,
  getResponseRoute: async () => undefined,
  patchResponseRoute: async () => undefined,
});

const fakeRuntime = (calls: string[]) => ({
  start: async () => { calls.push("runtime:start"); },
  stop: async () => { calls.push("runtime:stop"); },
  runTurn: async () => ({
    status: "completed" as const,
    reply: "",
    input_tokens: 0,
    output_tokens: 0,
    tool_calls: 0,
  }),
});

describe("production Gateway application", () => {
  test("keeps the diagnostic script-tool bridge disabled by default", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lxe-production-bridge-default-"));
    roots.push(runtimeRoot);
    const python = join(runtimeRoot, ".venv", "bin", "python");
    mkdirSync(join(runtimeRoot, ".venv", "bin"), { recursive: true });
    writeFileSync(python, "", "utf8");
    const logs: Array<Record<string, unknown>> = [];
    const application = createProductionGateway({
      projectRoot: runtimeRoot,
      runtimeRoot,
      environment: { AGENT_DASHBOARD_ENABLED: "0", FEISHU_GATEWAY_ENABLED: "0" },
      policy: policy(),
      directRuntime: fakeRuntime([]),
      directStorage: fakeStorage(),
      logger: createLogger("gateway", {
        write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });

    await application.start();
    expect(logs).toContainEqual(expect.objectContaining({
      message: "script_tool_bridge_disabled",
      business_command_count: 0,
    }));
    await application.stop();
  });

  test("assembles only the in-process TypeScript Runtime", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lxe-production-"));
    roots.push(runtimeRoot);
    const calls: string[] = [];
    let browserOpenCalls = 0;
    const application = createProductionGateway({
      projectRoot: runtimeRoot,
      runtimeRoot,
      environment: {
        AGENT_DASHBOARD_ENABLED: "0",
        FEISHU_GATEWAY_ENABLED: "0",
        AGENT_MAX_CONCURRENCY: "3",
      },
      policy: policy(),
      directRuntime: fakeRuntime(calls),
      directStorage: fakeStorage(),
      dashboardBrowserOpener: {
        open: async () => {
          browserOpenCalls += 1;
          return true;
        },
      },
    });

    await application.start();
    expect(calls).toEqual(["runtime:start"]);
    expect(await application.health()).toEqual(expect.objectContaining({
      ready: true,
      runtime: { ready: true },
    }));
    expect(application.settings.maxConcurrency).toBe(3);
    expect(browserOpenCalls).toBe(0);
    expect(existsSync(join(runtimeRoot, "var", "tmp", "gateway", "gateway-status.json"))).toBe(true);
    await application.stop();
    expect(calls).toEqual(["runtime:start", "runtime:stop"]);
    expect(existsSync(join(runtimeRoot, "var", "tmp", "gateway", "gateway-status.json"))).toBe(false);
  });

  test("opens the actual Dashboard URL only after readiness and only once", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lxe-production-dashboard-"));
    roots.push(runtimeRoot);
    const calls: string[] = [];
    const opened: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const application = createProductionGateway({
      projectRoot: runtimeRoot,
      runtimeRoot,
      environment: {
        AGENT_DASHBOARD_ENABLED: "1",
        AGENT_DASHBOARD_HOST: "127.0.0.1",
        AGENT_DASHBOARD_PORT: "0",
        AGENT_DASHBOARD_OPEN_BROWSER: "1",
        FEISHU_GATEWAY_ENABLED: "0",
      },
      policy: policy(),
      directRuntime: fakeRuntime(calls),
      directStorage: fakeStorage(),
      dashboardBrowserOpener: {
        open: async (url) => {
          calls.push("browser:open");
          opened.push(url);
          return true;
        },
      },
      logger: createLogger("gateway", {
        write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });

    try {
      await application.start();
      await application.start();
      expect(calls.slice(0, 2)).toEqual(["runtime:start", "browser:open"]);
      expect(opened).toEqual([application.dashboard.url]);
      expect(await application.health()).toEqual(expect.objectContaining({ ready: true }));
      expect(logs).toContainEqual(expect.objectContaining({
        message: "dashboard_available",
        url: application.dashboard.url,
        port: application.dashboard.port,
      }));
      expect(logs).toContainEqual(expect.objectContaining({
        message: "dashboard_browser_opened",
        url: application.dashboard.url,
      }));
    } finally {
      await application.stop();
    }
  });

  test("keeps the Gateway ready when the browser opener fails", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lxe-production-browser-failure-"));
    roots.push(runtimeRoot);
    const calls: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const application = createProductionGateway({
      projectRoot: runtimeRoot,
      runtimeRoot,
      environment: {
        AGENT_DASHBOARD_ENABLED: "1",
        AGENT_DASHBOARD_PORT: "0",
        AGENT_DASHBOARD_OPEN_BROWSER: "1",
        FEISHU_GATEWAY_ENABLED: "0",
      },
      policy: policy(),
      directRuntime: fakeRuntime(calls),
      directStorage: fakeStorage(),
      dashboardBrowserOpener: {
        open: async () => { throw new Error("no desktop session"); },
      },
      logger: createLogger("gateway", {
        write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });

    try {
      await application.start();
      expect(await application.health()).toEqual(expect.objectContaining({ ready: true }));
      expect(logs).toContainEqual(expect.objectContaining({
        level: "warn",
        message: "dashboard_browser_open_failed",
        reason: "opener_error",
      }));
    } finally {
      await application.stop();
    }
  });
});

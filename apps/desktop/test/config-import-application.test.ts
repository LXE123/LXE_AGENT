import { describe, expect, test } from "bun:test";
import type { Logger } from "@lxe/core";
import type { DesktopConfigImportApplyResult, DesktopSetupState } from "@lxe/desktop-protocol";
import { applyDesktopConfigImport } from "../src/main/config-import-application";

const state = (complete = true): DesktopSetupState => ({ complete } as DesktopSetupState);
const result = (complete = true): DesktopConfigImportApplyResult => ({
  state: state(complete),
  applied_groups: ["基础设置"],
  pending_groups: [],
  warnings: [],
});

const testLogger = (events: Array<{ level: string; message: string; fields: unknown }>): Logger => ({
  debug: (message, fields) => events.push({ level: "debug", message, fields }),
  info: (message, fields) => events.push({ level: "info", message, fields }),
  warn: (message, fields) => events.push({ level: "warn", message, fields }),
  error: (message, fields) => events.push({ level: "error", message, fields }),
  child: () => testLogger(events),
});

describe("desktop configuration import application", () => {
  test("persists unchanged configuration without restarting the Gateway", async () => {
    const events: Array<{ level: string; message: string; fields: unknown }> = [];
    let configured = 0;
    let restarted = 0;
    let invalidated = 0;
    let broadcasts = 0;
    const applied = result();

    await expect(applyDesktopConfigImport({
      importId: "import-1",
      apply: () => applied,
      currentEnvironment: () => ({ PROVIDER: "same" }),
      currentState: () => state(),
      configureLogging: () => { configured += 1; },
      restartGateway: async () => { restarted += 1; },
      stopGateway: async () => undefined,
      invalidateDashboard: () => { invalidated += 1; },
      broadcastHealth: () => { broadcasts += 1; },
      logger: testLogger(events),
      now: () => 100,
    })).resolves.toBe(applied);

    expect(configured).toBe(1);
    expect(restarted).toBe(0);
    expect(invalidated).toBe(1);
    expect(broadcasts).toBe(1);
    expect(events.map(({ message }) => message)).toEqual(["config_import_persisted"]);
  });

  test("restarts once after a runtime change and records phase durations", async () => {
    const events: Array<{ level: string; message: string; fields: unknown }> = [];
    let environment = { PROVIDER: "old" };
    let restarted = 0;
    const times = [100, 125, 130, 205];

    await applyDesktopConfigImport({
      importId: "import-2",
      apply: () => {
        environment = { PROVIDER: "new" };
        return result();
      },
      currentEnvironment: () => environment,
      currentState: () => state(),
      configureLogging: () => undefined,
      restartGateway: async () => { restarted += 1; },
      stopGateway: async () => undefined,
      invalidateDashboard: () => undefined,
      broadcastHealth: () => undefined,
      logger: testLogger(events),
      now: () => times.shift() ?? 205,
    });

    expect(restarted).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        message: "config_import_persisted",
        fields: expect.objectContaining({ duration_ms: 25, runtime_restart_required: true }),
      }),
      expect.objectContaining({
        message: "config_import_restart_started",
        fields: { action: "restart", duration_ms: 30 },
      }),
      expect.objectContaining({
        message: "config_import_restart_completed",
        fields: { action: "restart", duration_ms: 75 },
      }),
    ]);
  });

  test("reports the real restart error after persistence and still refreshes Desktop state", async () => {
    const events: Array<{ level: string; message: string; fields: unknown }> = [];
    let environment = { PROVIDER: "old" };
    let invalidated = 0;
    let broadcasts = 0;

    await expect(applyDesktopConfigImport({
      importId: "import-3",
      apply: () => {
        environment = { PROVIDER: "new" };
        return result();
      },
      currentEnvironment: () => environment,
      currentState: () => state(),
      configureLogging: () => undefined,
      restartGateway: async () => { throw new Error("agent initialize timed out"); },
      stopGateway: async () => undefined,
      invalidateDashboard: () => { invalidated += 1; },
      broadcastHealth: () => { broadcasts += 1; },
      logger: testLogger(events),
      now: () => 100,
    })).rejects.toThrow("配置已保存，但服务重启失败：agent initialize timed out");

    expect(invalidated).toBe(1);
    expect(broadcasts).toBe(1);
    expect(events.map(({ message }) => message)).toEqual([
      "config_import_persisted",
      "config_import_restart_started",
      "config_import_restart_failed",
    ]);
    expect(JSON.stringify(events)).not.toContain("PROVIDER");
  });

  test("stops an incomplete setup instead of restarting it", async () => {
    let stopped = 0;
    let restarted = 0;
    await applyDesktopConfigImport({
      importId: "import-4",
      apply: () => result(false),
      currentEnvironment: () => ({}),
      currentState: () => state(),
      configureLogging: () => undefined,
      restartGateway: async () => { restarted += 1; },
      stopGateway: async () => { stopped += 1; },
      invalidateDashboard: () => undefined,
      broadcastHealth: () => undefined,
      logger: testLogger([]),
    });
    expect(stopped).toBe(1);
    expect(restarted).toBe(0);
  });
});

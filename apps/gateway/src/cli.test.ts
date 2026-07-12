import { describe, expect, test } from "bun:test";
import { loadGatewayBootstrapSettings, parseGatewayCommand, runGatewayCli } from "./cli";
import { GatewayStartupAbortedError } from "./gateway-lifecycle";

describe("Gateway production CLI", () => {
  test("accepts only the default start command and explicit stop command", () => {
    expect(parseGatewayCommand([])).toBe("start");
    expect(parseGatewayCommand(["stop"])).toBe("stop");
    expect(() => parseGatewayCommand(["unknown"])).toThrow("unknown gateway command");
  });

  test("loads dashboard and concurrency settings with Python-compatible defaults", () => {
    const settings = loadGatewayBootstrapSettings({
      AGENT_DASHBOARD_ENABLED: "0",
      AGENT_DASHBOARD_HOST: " 0.0.0.0 ",
      AGENT_DASHBOARD_PORT: "9000",
      AGENT_DASHBOARD_PORT_AUTO_FALLBACK: "false",
      AGENT_DASHBOARD_OPEN_BROWSER: "0",
      AGENT_MAX_CONCURRENCY: "4",
    });
    expect(settings).toEqual({
      dashboardEnabled: false,
      dashboardHost: "0.0.0.0",
      dashboardPort: 9000,
      dashboardPortAutoFallback: false,
      dashboardOpenBrowser: false,
      maxConcurrency: 4,
    });
  });

  test("enables Dashboard browser opening by default", () => {
    expect(loadGatewayBootstrapSettings({}).dashboardOpenBrowser).toBe(true);
  });

  test("stop requests the running gateway without constructing a new application", async () => {
    let created = 0;
    let requested = 0;
    const code = await runGatewayCli(["stop"], {
      createApp: () => {
        created += 1;
        throw new Error("must not construct");
      },
      requestStop: async () => {
        requested += 1;
        return true;
      },
      waitForShutdown: async () => undefined,
    });
    expect(code).toBe(0);
    expect(created).toBe(0);
    expect(requested).toBe(1);
  });

  test("start owns the application lifecycle and always performs final cleanup", async () => {
    const calls: string[] = [];
    const app = {
      start: async () => { calls.push("start"); },
      stop: async () => { calls.push("stop"); },
      health: async () => ({ ready: true }),
    };
    const code = await runGatewayCli([], {
      createApp: () => app,
      requestStop: async () => false,
      waitForShutdown: async () => { calls.push("wait"); },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["start", "wait", "stop"]);
  });

  test("treats an explicit stop racing startup as a clean exit", async () => {
    let stopped = 0;
    const code = await runGatewayCli([], {
      createApp: () => ({
        start: async () => { throw new GatewayStartupAbortedError(); },
        stop: async () => { stopped += 1; },
        health: async () => ({ shutdown_started: true }),
      }),
      requestStop: async () => false,
      waitForShutdown: async () => undefined,
    });
    expect(code).toBe(0);
    expect(stopped).toBe(1);
  });
});

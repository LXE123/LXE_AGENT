import { afterEach, describe, expect, test } from "bun:test";
import type {
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DashboardTransport,
} from "@lxe/desktop-protocol";
import {
  callDashboard,
  resolveDashboardTransport,
  setDashboardTransportForTests,
} from "../src/api/client";

afterEach(() => setDashboardTransportForTests(undefined));

describe("Dashboard transport", () => {
  test("routes view helpers through the configured transport", async () => {
    const calls: DashboardRpcCall[] = [];
    const transport: DashboardTransport = {
      call: async <O extends DashboardRpcOperation>(call: DashboardRpcCall<O>): Promise<DashboardRpcResult<O>> => {
        calls.push(call as DashboardRpcCall);
        return { items: [], total: 0 } as DashboardRpcResult<O>;
      },
    };
    setDashboardTransportForTests(transport);

    await callDashboard({ operation: "sessions.list", input: { limit: 6 } });
    await callDashboard({ operation: "models.update", input: { provider: "kimi_coding", model: "k3" } });

    expect(calls).toEqual([
      { operation: "sessions.list", input: { limit: 6 } },
      {
        operation: "models.update",
        input: { provider: "kimi_coding", model: "k3" },
      },
    ]);
  });

  test("requires the Electron preload bridge", () => {
    expect(() => resolveDashboardTransport({}))
      .toThrow("Desktop preload bridge is unavailable");
  });

  test("uses the injected desktop bridge", () => {
    const bridge: DashboardTransport = {
      call: async <O extends DashboardRpcOperation>(): Promise<DashboardRpcResult<O>> =>
        ({ items: [], total: 0 }) as DashboardRpcResult<O>,
    };
    expect(resolveDashboardTransport({ bridge })).toBe(bridge);
  });
});

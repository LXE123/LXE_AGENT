import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lxe/core";
import { BunDashboardServer, dashboardAccessUrl } from "./dashboard";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BunDashboardServer", () => {
  test("builds accessible wildcard and IPv6 URLs", () => {
    expect(dashboardAccessUrl("0.0.0.0", 8765)).toBe("http://127.0.0.1:8765");
    expect(dashboardAccessUrl("::", 8765)).toBe("http://127.0.0.1:8765");
    expect(dashboardAccessUrl("::1", 8765)).toBe("http://[::1]:8765");
    expect(dashboardAccessUrl("[::1]", 8765)).toBe("http://[::1]:8765");
  });

  test("serves health, channel state, and the built dashboard on a dynamic port", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-"));
    roots.push(root);
    const dist = join(root, "web", "agent-dashboard", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<main>LXE</main>", "utf8");
    const logs: Array<Record<string, unknown>> = [];
    const dashboard = new BunDashboardServer({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      autoFallback: true,
      projectRoot: root,
      health: async () => ({ ready: true }),
      channels: async () => ({ feishu: { ready: true } }),
      api: async (request, url) => url.pathname === "/api/example"
        ? Response.json({ method: request.method })
        : undefined,
      logger: createLogger("gateway.dashboard", {
        write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });

    expect(await dashboard.start()).toBe(true);
    expect(dashboard.port).toBeGreaterThan(0);
    expect(dashboard.requestedPort).toBe(0);
    expect(dashboard.usedPortFallback).toBe(false);
    expect(logs).toContainEqual(expect.objectContaining({
      message: "dashboard_listening",
      url: dashboard.url,
      port: dashboard.port,
      port_fallback: false,
    }));
    expect(await fetch(`${dashboard.url}/api/health`).then((value) => value.json())).toEqual({
      status: "ok",
      gateway: { ready: true },
    });
    expect(await fetch(`${dashboard.url}/api/channels/health`).then((value) => value.json())).toEqual({
      items: { feishu: { ready: true } },
      total: 1,
    });
    expect(await fetch(`${dashboard.url}/api/example`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((value) => value.json())).toEqual({ method: "PATCH" });
    expect(await fetch(dashboard.url).then((value) => value.text())).toContain("LXE");
    await dashboard.stop();
    expect(dashboard.state().running).toBe(false);
  });

  test("falls back from an occupied fixed port and logs the actual URL", async () => {
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    const blockerPort = blocker.port;
    if (blockerPort === undefined) throw new Error("blocker did not bind a port");
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-fallback-"));
    roots.push(root);
    const logs: Array<Record<string, unknown>> = [];
    const dashboard = new BunDashboardServer({
      enabled: true,
      host: "127.0.0.1",
      port: blockerPort,
      autoFallback: true,
      projectRoot: root,
      health: async () => ({ ready: true }),
      channels: async () => ({}),
      logger: createLogger("gateway.dashboard", {
        write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });
    try {
      expect(await dashboard.start()).toBe(true);
      expect(dashboard.usedPortFallback).toBe(true);
      expect(dashboard.port).not.toBe(blockerPort);
      expect(dashboard.url).toBe(`http://127.0.0.1:${dashboard.port}`);
      expect(logs).toContainEqual(expect.objectContaining({
        level: "warn",
        message: "dashboard_port_fallback",
        requested_port: blockerPort,
        actual_port: dashboard.port,
      }));
    } finally {
      await dashboard.stop();
      await blocker.stop(true);
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunDashboardServer } from "./dashboard";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BunDashboardServer", () => {
  test("serves health, channel state, and the built dashboard on a dynamic port", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-"));
    roots.push(root);
    const dist = join(root, "web", "agent-dashboard", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<main>LXE</main>", "utf8");
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
    });

    expect(await dashboard.start()).toBe(true);
    expect(dashboard.port).toBeGreaterThan(0);
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
});

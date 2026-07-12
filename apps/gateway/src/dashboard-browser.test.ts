import { describe, expect, test } from "bun:test";
import {
  BunDashboardBrowserOpener,
  dashboardBrowserCommand,
  type DashboardBrowserChild,
} from "./dashboard-browser";

describe("Dashboard browser opener", () => {
  test("builds argv-only commands for supported platforms", () => {
    const url = "http://127.0.0.1:8765";
    expect(dashboardBrowserCommand(url, "darwin")).toEqual([
      "/usr/bin/open",
      "http://127.0.0.1:8765/",
    ]);
    expect(dashboardBrowserCommand(url, "win32")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      "http://127.0.0.1:8765/",
    ]);
    expect(dashboardBrowserCommand(url, "linux")).toEqual([
      "xdg-open",
      "http://127.0.0.1:8765/",
    ]);
  });

  test("rejects non-HTTP URLs before spawning", () => {
    expect(() => dashboardBrowserCommand("file:///tmp/dashboard", "darwin"))
      .toThrow("unsupported Dashboard URL protocol");
  });

  test("returns the opener exit status and passes the URL without a shell", async () => {
    const commands: Array<readonly string[]> = [];
    const opener = new BunDashboardBrowserOpener({
      platform: "darwin",
      spawn: (command) => {
        commands.push(command);
        return { exited: Promise.resolve(0), kill: () => undefined };
      },
    });
    expect(await opener.open("http://127.0.0.1:8765")).toBe(true);
    expect(commands).toEqual([[
      "/usr/bin/open",
      "http://127.0.0.1:8765/",
    ]]);

    const failed = new BunDashboardBrowserOpener({
      platform: "linux",
      spawn: () => ({ exited: Promise.resolve(3), kill: () => undefined }),
    });
    expect(await failed.open("https://localhost:8765")).toBe(false);
  });

  test("kills a browser opener that exceeds the bounded timeout", async () => {
    let killed = false;
    const child: DashboardBrowserChild = {
      exited: new Promise<number>(() => undefined),
      kill: () => { killed = true; },
    };
    const opener = new BunDashboardBrowserOpener({
      platform: "darwin",
      timeoutMs: 5,
      spawn: () => child,
    });
    await expect(opener.open("http://127.0.0.1:8765")).rejects.toThrow("timed out");
    expect(killed).toBe(true);
  });
});

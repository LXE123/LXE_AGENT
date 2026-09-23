import { describe, expect, test } from "bun:test";
import { dashboardDevUrl, resolveDashboardDevPort } from "../vite/dev-server";

describe("dashboard development server", () => {
  test("uses the default fixed port when no override is present", () => {
    expect(resolveDashboardDevPort({})).toBe(5173);
    expect(dashboardDevUrl({})).toBe("http://127.0.0.1:5173");
  });

  test("uses one explicit port for Vite and Electron", () => {
    const environment = { LXE_DASHBOARD_DEV_PORT: "5181" };
    expect(resolveDashboardDevPort(environment)).toBe(5181);
    expect(dashboardDevUrl(environment)).toBe("http://127.0.0.1:5181");
  });

  test("rejects an invalid port instead of silently changing the renderer origin", () => {
    expect(() => resolveDashboardDevPort({ LXE_DASHBOARD_DEV_PORT: "0" })).toThrow();
    expect(() => resolveDashboardDevPort({ LXE_DASHBOARD_DEV_PORT: "not-a-port" })).toThrow();
  });
});

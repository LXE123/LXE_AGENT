import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_VIEW_STORAGE_KEY,
  dashboardRouteFromHistory,
  readStoredCapabilityView,
  storeCapabilityView,
} from "../src/shared/navigation";

describe("Dashboard information architecture", () => {
  test("maps every legacy first-level page into its new parent and child view", () => {
    expect(dashboardRouteFromHistory({ tab: "models" }, "skills")).toEqual({
      section: "capabilities",
      capabilityView: "models",
      activityView: "stats",
      workbenchView: "index",
    });
    expect(dashboardRouteFromHistory({ tab: "mcp" }, "models").capabilityView).toBe("connections");
    expect(dashboardRouteFromHistory({ tab: "connectors" }, "models").capabilityView).toBe("connections");
    expect(dashboardRouteFromHistory({ tab: "background-tasks" }, "tools")).toEqual({
      section: "activity",
      capabilityView: "tools",
      activityView: "background-tasks",
      workbenchView: "index",
    });
    expect(dashboardRouteFromHistory({ tab: "stats" }, "tools").activityView).toBe("stats");
  });

  test("keeps valid new routes and rejects invalid child views", () => {
    expect(dashboardRouteFromHistory({ section: "workbench" }, "skills")).toEqual({
      section: "workbench",
      capabilityView: "skills",
      activityView: "stats",
      workbenchView: "index",
    });
    expect(dashboardRouteFromHistory({
      section: "capabilities",
      capabilityView: "connections",
      activityView: "background-tasks",
    }, "skills")).toEqual({
      section: "capabilities",
      capabilityView: "connections",
      activityView: "stats",
      workbenchView: "index",
    });
    expect(dashboardRouteFromHistory({
      section: "capabilities",
      capabilityView: "unknown",
    }, "skills").capabilityView).toBe("models");
    expect(dashboardRouteFromHistory({
      section: "activity",
      activityView: "unknown",
    }, "tools").activityView).toBe("stats");
  });

  test("persists only valid capability views and fails safely without storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    storeCapabilityView("connections", storage);
    expect(values.get(CAPABILITY_VIEW_STORAGE_KEY)).toBe("connections");
    expect(readStoredCapabilityView(storage)).toBe("connections");
    values.set(CAPABILITY_VIEW_STORAGE_KEY, "invalid");
    expect(readStoredCapabilityView(storage)).toBe("models");

    expect(readStoredCapabilityView({ getItem: () => { throw new Error("blocked"); } })).toBe("models");
    expect(() => storeCapabilityView("tools", { setItem: () => { throw new Error("full"); } })).not.toThrow();
  });

  test("migrates the legacy capability key into the window-scoped key", () => {
    const values = new Map<string, string>([["lxe-dashboard-capability-view", "skills"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(readStoredCapabilityView(storage)).toBe("skills");
    expect(values.get(CAPABILITY_VIEW_STORAGE_KEY)).toBe("skills");
  });
});

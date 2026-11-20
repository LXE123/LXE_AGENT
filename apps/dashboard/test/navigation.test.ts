import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_VIEW_STORAGE_KEY,
  dashboardRouteFromHistory,
  readStoredCapabilityView,
  storeCapabilityView,
  workbenchParent,
  workbenchTools,
} from "../src/shared/navigation";

describe("Dashboard information architecture", () => {
  test("maps every legacy first-level page into its new parent and child view", () => {
    expect(dashboardRouteFromHistory({ tab: "models" }, "skills")).toEqual({
      section: "capabilities",
      capabilityView: "models",
      activityView: "stats",
      workbenchView: "tasks",
    });
    expect(dashboardRouteFromHistory({ tab: "mcp" }, "models").capabilityView).toBe("connections");
    expect(dashboardRouteFromHistory({ tab: "connectors" }, "models").capabilityView).toBe("connections");
    expect(dashboardRouteFromHistory({ tab: "background-tasks" }, "tools")).toEqual({
      section: "activity",
      capabilityView: "tools",
      activityView: "stats",
      workbenchView: "tasks",
    });
    expect(dashboardRouteFromHistory({ tab: "stats" }, "tools").activityView).toBe("stats");
  });

  test("keeps valid new routes and rejects invalid child views", () => {
    expect(dashboardRouteFromHistory({ section: "workbench" }, "skills")).toEqual({
      section: "workbench",
      capabilityView: "skills",
      activityView: "stats",
      workbenchView: "tasks",
    });
    expect(dashboardRouteFromHistory({
      section: "capabilities",
      capabilityView: "connections",
      activityView: "removed-view",
    }, "skills")).toEqual({
      section: "capabilities",
      capabilityView: "connections",
      activityView: "stats",
      workbenchView: "tasks",
    });
    expect(dashboardRouteFromHistory({
      section: "capabilities",
      capabilityView: "unknown",
    }, "skills").capabilityView).toBe("skills");
    expect(dashboardRouteFromHistory({
      section: "activity",
      activityView: "unknown",
    }, "tools").activityView).toBe("stats");
  });

  test("opens the catalog as a standalone page from both current and old history entries", () => {
    for (const entry of [{ section: "team-skills" }, { section: "workbench", workbenchView: "team-skills" }]) {
      expect(dashboardRouteFromHistory(entry, "tools")).toEqual({
        section: "team-skills", capabilityView: "tools", activityView: "stats", workbenchView: "tasks",
      });
    }
  });

  test("persists only valid capability views and fails safely without storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readStoredCapabilityView()).toBe("skills");
    expect(readStoredCapabilityView(storage)).toBe("skills");
    storeCapabilityView("models", storage);
    expect(readStoredCapabilityView(storage)).toBe("models");
    storeCapabilityView("connections", storage);
    expect(values.get(CAPABILITY_VIEW_STORAGE_KEY)).toBe("connections");
    expect(readStoredCapabilityView(storage)).toBe("connections");
    values.set(CAPABILITY_VIEW_STORAGE_KEY, "invalid");
    expect(readStoredCapabilityView(storage)).toBe("skills");

    expect(readStoredCapabilityView({ getItem: () => { throw new Error("blocked"); } })).toBe("skills");
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

  test("workbench opens on skill tasks and each tool returns to its own sub-page", () => {
    expect(dashboardRouteFromHistory({ section: "workbench" }, "skills").workbenchView).toBe("tasks");
    expect(dashboardRouteFromHistory({ section: "workbench", workbenchView: "tools" }, "skills").workbenchView).toBe("tools");
    expect(dashboardRouteFromHistory({ section: "workbench", workbenchView: "index" }, "skills").workbenchView).toBe("tasks");
    expect(workbenchTools("tasks")).toEqual(["fba-capacity"]);
    expect(workbenchTools("tools")).toEqual(["vietnam-settings", "amazon-v2-settings", "synthetic-performer", "input-assets"]);
    expect(workbenchParent("fba-capacity")).toBe("tasks");
    expect(workbenchParent("input-assets")).toBe("tools");
    expect(workbenchParent("tools")).toBe("tools");
  });
});

export type DashboardSection = "home" | "sessions" | "capabilities" | "activity";

export type CapabilityView = "models" | "skills" | "tools" | "connections";

export type ActivityView = "stats" | "background-tasks";

export type DashboardRouteSelection = {
  section: DashboardSection;
  capabilityView: CapabilityView;
  activityView: ActivityView;
};

export const CAPABILITY_VIEW_STORAGE_KEY = "lxe.window.main.capability-view.v1";
const LEGACY_CAPABILITY_VIEW_STORAGE_KEY = "lxe-dashboard-capability-view";

const DASHBOARD_SECTIONS = new Set<DashboardSection>([
  "home",
  "sessions",
  "capabilities",
  "activity",
]);

const CAPABILITY_VIEWS = new Set<CapabilityView>([
  "models",
  "skills",
  "tools",
  "connections",
]);

const ACTIVITY_VIEWS = new Set<ActivityView>(["stats", "background-tasks"]);

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function normalizeCapabilityView(value: unknown): CapabilityView {
  return typeof value === "string" && CAPABILITY_VIEWS.has(value as CapabilityView)
    ? value as CapabilityView
    : "models";
}

export function readStoredCapabilityView(
  storage?: Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>,
): CapabilityView {
  if (!storage) return "models";
  try {
    const current = storage.getItem(CAPABILITY_VIEW_STORAGE_KEY);
    if (current !== null) return normalizeCapabilityView(current);
    const legacy = storage.getItem(LEGACY_CAPABILITY_VIEW_STORAGE_KEY);
    const migrated = normalizeCapabilityView(legacy);
    if (legacy !== null && storage.setItem) storage.setItem(CAPABILITY_VIEW_STORAGE_KEY, migrated);
    return migrated;
  } catch {
    return "models";
  }
}

export function storeCapabilityView(
  view: CapabilityView,
  storage?: Pick<Storage, "setItem">,
): void {
  if (!storage) return;
  try {
    storage.setItem(CAPABILITY_VIEW_STORAGE_KEY, view);
  } catch {
    // The in-memory selection remains usable when storage is unavailable.
  }
}

export function dashboardRouteFromHistory(
  historyState: unknown,
  storedCapabilityView: CapabilityView,
): DashboardRouteSelection {
  const state = objectRecord(historyState);
  const section = state.section;
  if (typeof section === "string" && DASHBOARD_SECTIONS.has(section as DashboardSection)) {
    return {
      section: section as DashboardSection,
      capabilityView: section === "capabilities"
        ? normalizeCapabilityView(state.capabilityView ?? storedCapabilityView)
        : storedCapabilityView,
      activityView: section === "activity" && typeof state.activityView === "string"
        && ACTIVITY_VIEWS.has(state.activityView as ActivityView)
        ? state.activityView as ActivityView
        : "stats",
    };
  }

  switch (state.tab) {
    case "sessions":
      return { section: "sessions", capabilityView: storedCapabilityView, activityView: "stats" };
    case "models":
      return { section: "capabilities", capabilityView: "models", activityView: "stats" };
    case "skills":
      return { section: "capabilities", capabilityView: "skills", activityView: "stats" };
    case "tools":
      return { section: "capabilities", capabilityView: "tools", activityView: "stats" };
    case "mcp":
    case "connectors":
      return { section: "capabilities", capabilityView: "connections", activityView: "stats" };
    case "background-tasks":
      return {
        section: "activity",
        capabilityView: storedCapabilityView,
        activityView: "background-tasks",
      };
    case "stats":
      return { section: "activity", capabilityView: storedCapabilityView, activityView: "stats" };
    default:
      return { section: "home", capabilityView: storedCapabilityView, activityView: "stats" };
  }
}

export type DashboardSection = "home" | "sessions" | "workbench" | "capabilities" | "activity";

export type CapabilityView = "models" | "skills" | "tools" | "connections";

export type ActivityView = "stats" | "background-tasks";

/** Workbench starts on the tool index and drills into one tool at a time. */
export type WorkbenchView = "index" | "synthetic-performer" | "input-assets";

export type DashboardRouteSelection = {
  section: DashboardSection;
  capabilityView: CapabilityView;
  activityView: ActivityView;
  workbenchView: WorkbenchView;
};

export const CAPABILITY_VIEW_STORAGE_KEY = "lxe.window.main.capability-view.v1";
const LEGACY_CAPABILITY_VIEW_STORAGE_KEY = "lxe-dashboard-capability-view";

const DASHBOARD_SECTIONS = new Set<DashboardSection>([
  "home",
  "sessions",
  "workbench",
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

const WORKBENCH_VIEWS = new Set<WorkbenchView>(["index", "synthetic-performer", "input-assets"]);

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

export function normalizeWorkbenchView(value: unknown): WorkbenchView {
  return typeof value === "string" && WORKBENCH_VIEWS.has(value as WorkbenchView)
    ? value as WorkbenchView
    : "index";
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
      workbenchView: section === "workbench"
        ? normalizeWorkbenchView(state.workbenchView)
        : "index",
    };
  }

  switch (state.tab) {
    case "sessions":
      return { section: "sessions", capabilityView: storedCapabilityView, activityView: "stats", workbenchView: "index" };
    case "models":
      return { section: "capabilities", capabilityView: "models", activityView: "stats", workbenchView: "index" };
    case "skills":
      return { section: "capabilities", capabilityView: "skills", activityView: "stats", workbenchView: "index" };
    case "tools":
      return { section: "capabilities", capabilityView: "tools", activityView: "stats", workbenchView: "index" };
    case "mcp":
    case "connectors":
      return { section: "capabilities", capabilityView: "connections", activityView: "stats", workbenchView: "index" };
    case "background-tasks":
      return {
        section: "activity",
        capabilityView: storedCapabilityView,
        activityView: "background-tasks",
        workbenchView: "index",
      };
    case "stats":
      return { section: "activity", capabilityView: storedCapabilityView, activityView: "stats", workbenchView: "index" };
    default:
      return { section: "home", capabilityView: storedCapabilityView, activityView: "stats", workbenchView: "index" };
  }
}

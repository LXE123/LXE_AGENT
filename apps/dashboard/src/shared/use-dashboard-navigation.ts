import { useEffect, useState } from "react";
import { dashboardRouteFromHistory, readStoredCapabilityView, storeCapabilityView } from "./navigation";
import type { DashboardRouteSelection, DashboardSection, CapabilityView, ActivityView, WorkbenchView } from "./navigation";

export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function routeStateFromLocation(): DashboardRouteSelection {
  const storedCapabilityView = readStoredCapabilityView(browserStorage());
  return dashboardRouteFromHistory(window.history.state, storedCapabilityView);
}

export function useDashboardNavigation() {
  const [initialRoute] = useState(() => routeStateFromLocation());
  const [activeSection, setActiveSection] = useState<DashboardSection>(initialRoute.section);
  const [capabilityView, setCapabilityView] = useState<CapabilityView>(initialRoute.capabilityView);
  const [activityView, setActivityView] = useState<ActivityView>(initialRoute.activityView);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>(initialRoute.workbenchView);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = routeStateFromLocation();
      setActiveSection(nextRoute.section);
      setCapabilityView(nextRoute.capabilityView);
      setActivityView(nextRoute.activityView);
      setWorkbenchView(nextRoute.workbenchView);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    storeCapabilityView(capabilityView, browserStorage());
  }, [capabilityView]);

  function pushDashboardRoute(
    section: DashboardSection,
    nextCapabilityView = capabilityView,
    nextActivityView = activityView,
    nextWorkbenchView = workbenchView,
  ) {
    const nextState = {
      section,
      capabilityView: nextCapabilityView,
      activityView: nextActivityView,
      workbenchView: nextWorkbenchView,
    };
    const currentState = window.history.state;
    const stateChanged = currentState?.section !== section
      || currentState?.capabilityView !== nextCapabilityView
      || currentState?.activityView !== nextActivityView
      || currentState?.workbenchView !== nextWorkbenchView;
    if (window.location.pathname !== "/" || stateChanged) {
      window.history.pushState(nextState, "", "/");
    }
  }

  function openDashboardSection(section: DashboardSection) {
    const nextActivityView = section === "activity" ? "stats" : activityView;
    // Re-entering the workbench from the sidebar always lands on the tool index.
    const nextWorkbenchView = section === "workbench" ? "index" : workbenchView;
    pushDashboardRoute(section, capabilityView, nextActivityView, nextWorkbenchView);
    setActiveSection(section);
    setActivityView(nextActivityView);
    setWorkbenchView(nextWorkbenchView);
  }

  function openWorkbenchView(view: WorkbenchView) {
    pushDashboardRoute("workbench", capabilityView, activityView, view);
    setActiveSection("workbench");
    setWorkbenchView(view);
  }

  function openCapabilityView(view: CapabilityView) {
    pushDashboardRoute("capabilities", view, activityView);
    setActiveSection("capabilities");
    setCapabilityView(view);
  }

  function openActivityView(view: ActivityView) {
    pushDashboardRoute("activity", capabilityView, view);
    setActiveSection("activity");
    setActivityView(view);
  }

  return { activeSection, capabilityView, activityView, workbenchView,
    openDashboardSection, openWorkbenchView, openCapabilityView, openActivityView } as const;
}

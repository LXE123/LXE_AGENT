export const SIDEBAR_EXPANDED_STORAGE_KEY = "lxe.dashboard.sidebar.expanded";

type SidebarStorage = Pick<Storage, "getItem" | "setItem">;

export function initialSidebarExpanded(storage?: SidebarStorage): boolean {
  if (!storage) return true;
  try {
    const value = storage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY);
    if (value === null) return true;
    if (value === "false") return false;
    return true;
  } catch {
    return true;
  }
}

export function storeSidebarExpanded(expanded: boolean, storage?: SidebarStorage): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // The current layout still works when persistent storage is unavailable.
  }
}

export const FONT_SIZE_STORAGE_KEY = "lxe.window.main.font-size.v1";

export type DashboardFontSize = "small" | "standard" | "large";

export const DEFAULT_DASHBOARD_FONT_SIZE: DashboardFontSize = "standard";

export const isDashboardFontSize = (value: string | null): value is DashboardFontSize =>
  value === "small" || value === "standard" || value === "large";

export function initialDashboardFontSize(
  storage?: Pick<Storage, "getItem">,
): DashboardFontSize {
  try {
    const value = (storage ?? window.localStorage).getItem(FONT_SIZE_STORAGE_KEY);
    return isDashboardFontSize(value) ? value : DEFAULT_DASHBOARD_FONT_SIZE;
  } catch {
    return DEFAULT_DASHBOARD_FONT_SIZE;
  }
}

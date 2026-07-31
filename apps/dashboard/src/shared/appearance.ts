export const FONT_SIZE_STORAGE_KEY = "lxe.window.main.font-size.v1";
export const THEME_STORAGE_KEY = "lxe.window.main.theme.v1";

/** What the user chose. "system" defers to the OS and keeps following it. */
export type DashboardTheme = "system" | "light" | "dark";

/** What the stylesheet is actually painted with. */
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_DASHBOARD_THEME: DashboardTheme = "system";

export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const isDashboardTheme = (value: string | null): value is DashboardTheme =>
  value === "system" || value === "light" || value === "dark";

export function initialDashboardTheme(
  storage?: Pick<Storage, "getItem">,
): DashboardTheme {
  try {
    const value = (storage ?? window.localStorage).getItem(THEME_STORAGE_KEY);
    return isDashboardTheme(value) ? value : DEFAULT_DASHBOARD_THEME;
  } catch {
    return DEFAULT_DASHBOARD_THEME;
  }
}

export function resolveTheme(theme: DashboardTheme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}


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

import type { JsonObject } from "@lxe/protocol";

/** Keep Electron-only response adapters out of the user-facing channel status. */
export function publicDashboardChannelHealth(
  snapshot: Record<string, JsonObject>,
): Record<string, JsonObject> {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([platform]) => platform !== "desktop"),
  );
}

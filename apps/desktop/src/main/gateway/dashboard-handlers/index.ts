import type { DashboardHandlers } from "./context";
import { fileHandlers } from "./files";
import { sessionHandlers } from "./sessions";
import { settingsHandlers } from "./settings";

export type { DashboardHandler, DashboardHandlerContext, DashboardHandlers } from "./context";

/** Dashboard operations that need Desktop's own work. Everything else is forwarded to agentcli. */
export const DASHBOARD_HANDLERS: DashboardHandlers = { ...sessionHandlers, ...fileHandlers, ...settingsHandlers };

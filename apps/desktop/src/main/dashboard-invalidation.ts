import type {
  AgentEvent,
  DashboardRpcOperation,
  DesktopDashboardDataDomain,
  DesktopDashboardInvalidation,
} from "@lxe/desktop-protocol";

export const ALL_DASHBOARD_DATA_DOMAINS: readonly DesktopDashboardDataDomain[] = [
  "sessions",
  "stats",
  "background_tasks",
  "channels",
  "models",
  "connectors",
  "skills",
  "tools",
];

export interface DashboardInvalidationDraft {
  domains: DesktopDashboardDataDomain[];
  sessionIds: string[];
}

export function dashboardInvalidationForAgentEvent(
  event: AgentEvent,
): DashboardInvalidationDraft | undefined {
  if (event.type === "session.changed") {
    return {
      domains: ["sessions"],
      sessionIds: event.thread_id.trim() ? [event.thread_id] : [],
    };
  }
  if (event.type === "turn.completed" || event.type === "turn.failed") {
    return {
      domains: ["stats", "background_tasks"],
      sessionIds: [],
    };
  }
  return undefined;
}

export function dashboardDomainsForMutation(operation: DashboardRpcOperation): DesktopDashboardDataDomain[] {
  switch (operation) {
    case "models.update":
    case "models.thinking.update":
      return ["models"];
    case "connectors.update":
      return ["connectors", "skills"];
    case "mcp.servers.update":
      return ["tools"];
    case "sessions.send":
    case "sessions.stop":
      return ["sessions"];
    default:
      return [];
  }
}

type Schedule = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type CancelSchedule = (handle: ReturnType<typeof setTimeout>) => void;

export class DashboardInvalidationBatcher {
  private readonly domains = new Set<DesktopDashboardDataDomain>();
  private readonly sessionIds = new Set<string>();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly publish: (invalidation: DesktopDashboardInvalidation) => void,
    private readonly delayMs = 2_000,
    private readonly schedule: Schedule = setTimeout,
    private readonly cancelSchedule: CancelSchedule = clearTimeout,
  ) {}

  push(domains: Iterable<DesktopDashboardDataDomain>, sessionIds: Iterable<string> = []): void {
    for (const domain of domains) this.domains.add(domain);
    for (const sessionId of sessionIds) {
      const normalized = sessionId.trim();
      if (normalized) this.sessionIds.add(normalized);
    }
    if (!this.domains.size || this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.flush();
    }, this.delayMs);
  }

  flush(): void {
    if (!this.domains.size) return;
    if (this.timer) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    this.revision += 1;
    const invalidation: DesktopDashboardInvalidation = {
      revision: this.revision,
      domains: ALL_DASHBOARD_DATA_DOMAINS.filter((domain) => this.domains.has(domain)),
      session_ids: [...this.sessionIds],
    };
    this.domains.clear();
    this.sessionIds.clear();
    this.publish(invalidation);
  }

  dispose(): void {
    if (this.timer) this.cancelSchedule(this.timer);
    this.timer = undefined;
    this.domains.clear();
    this.sessionIds.clear();
  }
}

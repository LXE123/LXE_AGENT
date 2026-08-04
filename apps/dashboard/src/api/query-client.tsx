import { useEffect, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  DesktopDashboardDataDomain,
  DesktopDashboardInvalidation,
} from "@lxe/desktop-protocol";

import { dashboardQueryKeys } from "./query-keys";

export const DEFAULT_STALE_TIME_MS = 30_000;
export const DEFAULT_GC_TIME_MS = 10 * 60_000;

export function createDashboardQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        gcTime: DEFAULT_GC_TIME_MS,
        retry: 1,
        refetchOnWindowFocus: true,
        refetchOnReconnect: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

const domainKeys: Record<Exclude<DesktopDashboardDataDomain, "sessions">, readonly unknown[]> = {
  stats: dashboardQueryKeys.stats.all,
  channels: dashboardQueryKeys.channelHealth.all,
  models: dashboardQueryKeys.models.all,
  connectors: dashboardQueryKeys.connectors.all,
  skills: dashboardQueryKeys.skills.all,
  tools: dashboardQueryKeys.tools.all,
};

const allDomains = new Set<DesktopDashboardDataDomain>([
  "sessions",
  "stats",
  "channels",
  "models",
  "connectors",
  "skills",
  "tools",
]);

export async function applyDashboardInvalidation(
  queryClient: QueryClient,
  invalidation: DesktopDashboardInvalidation,
): Promise<void> {
  const receivedDomains = new Set(invalidation.domains);
  if (
    invalidation.session_ids.length === 0
    && receivedDomains.size === allDomains.size
    && [...allDomains].every((domain) => receivedDomains.has(domain))
  ) {
    queryClient.removeQueries({ type: "inactive" });
    await queryClient.resetQueries({ type: "active" });
    return;
  }
  const tasks: Array<Promise<unknown>> = [];
  for (const domain of new Set(invalidation.domains)) {
    if (domain === "sessions") {
      tasks.push(queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists }));
      if (invalidation.session_ids.length) {
        for (const sessionId of new Set(invalidation.session_ids)) {
          tasks.push(queryClient.invalidateQueries({
            queryKey: dashboardQueryKeys.sessions.detailSession(sessionId),
          }));
        }
      } else {
        tasks.push(queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.details }));
      }
      continue;
    }
    tasks.push(queryClient.invalidateQueries({ queryKey: domainKeys[domain] }));
  }
  await Promise.all(tasks);
}

function DashboardInvalidationListener(): null {
  const queryClient = useQueryClient();
  const desktop = window.lxe?.desktop;
  useEffect(() => {
    if (!desktop) return;
    return desktop.onDashboardInvalidated((invalidation) => {
      void applyDashboardInvalidation(queryClient, invalidation);
    });
  }, [desktop, queryClient]);
  return null;
}

const dashboardQueryClient = createDashboardQueryClient();

export function DashboardQueryProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={dashboardQueryClient}>
      <DashboardInvalidationListener />
      {children}
    </QueryClientProvider>
  );
}

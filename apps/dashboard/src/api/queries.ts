import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";

import { fetchJson } from "./client";
import { dashboardQueryKeys } from "./query-keys";
import { normalizeProjectDocs } from "../features/docs/model";
import { normalizeSessionList } from "../features/sessions/model";
import type {
  ApiList,
  BackgroundTaskPayload,
  ChannelHealthList,
  CliCommandPayload,
  ConnectorPayload,
  ModelPayload,
  ProjectDocContentPayload,
  ProjectDocPayload,
  SessionDetailPayload,
  SessionListPayload,
  SessionPayload,
  SkillContentPayload,
  SkillPayload,
  SkillReferenceContentPayload,
  SkillStatPayload,
  StatsOverviewPayload,
  ToolsetPayload,
  ToolStatPayload,
} from "./payloads";

export const SESSION_LIST_PAGE_SIZE = 10;
export const SESSION_MESSAGE_PAGE_LIMIT = 10;
export const ACTIVE_DATA_STALE_TIME_MS = 5_000;
export const ACTIVE_DATA_REFRESH_INTERVAL_MS = 15_000;
export const STATS_REFRESH_INTERVAL_MS = 30_000;
export const CATALOG_STALE_TIME_MS = 5 * 60_000;
export const GATEWAY_LIFETIME_STALE_TIME_MS = Number.POSITIVE_INFINITY;

export function queryError(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

export function useSessionsInfiniteQuery(query: string, enabled = true) {
  const normalizedQuery = query.trim();
  return useInfiniteQuery({
    queryKey: dashboardQueryKeys.sessions.list(normalizedQuery),
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: String(SESSION_LIST_PAGE_SIZE),
        offset: String(pageParam),
      });
      if (normalizedQuery) params.set("q", normalizedQuery);
      return normalizeSessionList(
        await fetchJson<SessionListPayload>(`/api/sessions?${params.toString()}`),
        SESSION_LIST_PAGE_SIZE,
      );
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = (lastPage.offset ?? 0) + lastPage.items.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    enabled,
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
    refetchInterval: enabled ? ACTIVE_DATA_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function flattenSessionPages(
  pages: SessionListPayload[] | undefined,
): { items: SessionPayload[]; total: number; summary: SessionListPayload["summary"] | undefined } {
  const seen = new Set<string>();
  const items: SessionPayload[] = [];
  for (const page of pages ?? []) {
    for (const session of page.items) {
      if (seen.has(session.session_id)) continue;
      seen.add(session.session_id);
      items.push(session);
    }
  }
  return {
    items,
    total: pages?.[0]?.total ?? 0,
    summary: pages?.[0]?.summary,
  };
}

export function useSessionDetailQuery(sessionId: string, page: number | undefined, enabled = true) {
  const pageKey = page ?? "latest";
  const params = new URLSearchParams({ message_limit: String(SESSION_MESSAGE_PAGE_LIMIT) });
  if (page !== undefined) params.set("message_page", String(page));
  return useQuery({
    queryKey: dashboardQueryKeys.sessions.detail(sessionId, pageKey),
    queryFn: () => fetchJson<SessionDetailPayload>(
      `/api/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`,
    ),
    enabled: enabled && Boolean(sessionId),
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
    refetchInterval: enabled && sessionId ? ACTIVE_DATA_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useStatsOverviewQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("overview", days),
    queryFn: () => fetchJson<StatsOverviewPayload>(`/api/stats/overview?days=${days}`),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function useSkillStatsQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("skills", days),
    queryFn: () => fetchJson<ApiList<SkillStatPayload>>(`/api/stats/skills?days=${days}`),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function useToolStatsQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("tools", days),
    queryFn: () => fetchJson<ApiList<ToolStatPayload>>(`/api/stats/tools?days=${days}`),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function useBackgroundTasksQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.backgroundTasks.all,
    queryFn: () => fetchJson<ApiList<BackgroundTaskPayload>>("/api/background-tasks"),
    enabled,
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
    refetchInterval: enabled ? ACTIVE_DATA_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function useChannelHealthQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.channelHealth.all,
    queryFn: () => fetchJson<ChannelHealthList>("/api/channels/health"),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useModelsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.models.list,
    queryFn: () => fetchJson<ApiList<ModelPayload>>("/api/models"),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useCurrentModelQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.models.current,
    queryFn: () => fetchJson<ModelPayload>("/api/models/current"),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useConnectorsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.connectors.all,
    queryFn: () => fetchJson<ApiList<ConnectorPayload>>("/api/connectors"),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useSkillsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.list,
    queryFn: () => fetchJson<ApiList<SkillPayload>>("/api/skills"),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useCommandsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.commands.all,
    queryFn: () => fetchJson<ApiList<CliCommandPayload>>("/api/commands"),
    enabled,
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

export function useToolsetsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.tools.all,
    queryFn: () => fetchJson<ApiList<ToolsetPayload>>("/api/tools/toolsets"),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useProjectDocsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.docs.list,
    queryFn: async () => normalizeProjectDocs(
      await fetchJson<ApiList<ProjectDocPayload>>("/api/project-docs"),
    ),
    enabled,
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

export function useProjectDocContentQuery(path: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.docs.content(path),
    queryFn: () => fetchJson<ProjectDocContentPayload>(
      `/api/project-docs/${path.split("/").map(encodeURIComponent).join("/")}`,
    ),
    enabled: enabled && Boolean(path),
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

export function useSkillContentQuery(name: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.content(name),
    queryFn: () => fetchJson<SkillContentPayload>(
      `/api/skills/${encodeURIComponent(name)}/content`,
    ),
    enabled: enabled && Boolean(name),
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

export function useSkillReferenceQuery(name: string, path: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.reference(name, path),
    queryFn: () => fetchJson<SkillReferenceContentPayload>(
      `/api/skills/${encodeURIComponent(name)}/references/${path.split("/").map(encodeURIComponent).join("/")}`,
    ),
    enabled: enabled && Boolean(name) && Boolean(path),
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

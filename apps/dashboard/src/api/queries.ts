import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";

import { callDashboard } from "./client";
import { dashboardQueryKeys } from "./query-keys";
import { normalizeSessionList } from "../features/sessions/model";
import type {
  ApiList,
  BackgroundTaskPayload,
  ChannelHealthList,
  CliCommandPayload,
  ConnectorPayload,
  ModelPayload,
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
export const BACKGROUND_TASKS_REFRESH_INTERVAL_MS = 15_000;
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
      return normalizeSessionList(
        await callDashboard({
          operation: "sessions.list",
          input: { query: normalizedQuery, limit: SESSION_LIST_PAGE_SIZE, offset: pageParam },
        }),
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
  return useQuery({
    queryKey: dashboardQueryKeys.sessions.detail(sessionId, pageKey),
    queryFn: () => callDashboard({
      operation: "sessions.detail",
      input: {
        session_id: sessionId,
        message_limit: SESSION_MESSAGE_PAGE_LIMIT,
        ...(page === undefined ? {} : { message_page: page }),
      },
    }),
    enabled: enabled && Boolean(sessionId),
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
    placeholderData: keepPreviousData,
  });
}

export function useSessionConversationQuery(sessionId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: dashboardQueryKeys.sessions.conversation(sessionId),
    queryFn: ({ pageParam }) => callDashboard({
      operation: "sessions.detail",
      input: {
        session_id: sessionId,
        message_limit: SESSION_MESSAGE_PAGE_LIMIT,
        ...(pageParam === undefined ? {} : { message_page: pageParam }),
      },
    }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: () => undefined,
    getPreviousPageParam: (firstPage) => firstPage.messages_page.has_previous
      ? firstPage.messages_page.current_page - 1
      : undefined,
    enabled: enabled && Boolean(sessionId),
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
  });
}

export function useConversationActivityQuery(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.sessions.activity(sessionId),
    queryFn: () => callDashboard({
      operation: "sessions.activity",
      input: { session_id: sessionId },
    }),
    enabled: enabled && Boolean(sessionId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useStatsOverviewQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("overview", days),
    queryFn: () => callDashboard({ operation: "stats.overview", input: { days } }),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useSkillStatsQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("skills", days),
    queryFn: () => callDashboard({ operation: "stats.skills.list", input: { days } }),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useToolStatsQuery(days: number, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.stats.byType("tools", days),
    queryFn: () => callDashboard({ operation: "stats.tools.list", input: { days } }),
    enabled,
    refetchInterval: enabled ? STATS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useBackgroundTasksQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.backgroundTasks.all,
    queryFn: () => callDashboard({ operation: "backgroundTasks.list", input: {} }),
    enabled,
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
    refetchInterval: enabled ? BACKGROUND_TASKS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function useChannelHealthQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.channelHealth.all,
    queryFn: () => callDashboard({ operation: "channels.health", input: {} }),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useModelsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.models.list,
    queryFn: () => callDashboard({ operation: "models.list", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useCurrentModelQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.models.current,
    queryFn: () => callDashboard({ operation: "models.current", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useConnectorsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.connectors.all,
    queryFn: () => callDashboard({ operation: "connectors.list", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useSkillsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.list,
    queryFn: () => callDashboard({ operation: "skills.list", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useCommandsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.commands.all,
    queryFn: () => callDashboard({ operation: "commands.list", input: {} }),
    enabled,
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

export function useToolsetsQuery(enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.tools.all,
    queryFn: () => callDashboard({ operation: "toolsets.list", input: {} }),
    enabled,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

export function useSkillContentQuery(name: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.content(name),
    queryFn: () => callDashboard({ operation: "skills.content", input: { name } }),
    enabled: enabled && Boolean(name),
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

export function useSkillReferenceQuery(name: string, path: string, enabled = true) {
  return useQuery({
    queryKey: dashboardQueryKeys.skills.reference(name, path),
    queryFn: () => callDashboard({ operation: "skills.reference", input: { name, path } }),
    enabled: enabled && Boolean(name) && Boolean(path),
    staleTime: GATEWAY_LIFETIME_STALE_TIME_MS,
  });
}

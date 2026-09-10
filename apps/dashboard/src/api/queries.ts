import { clearResetStreams } from "../features/sessions/context-display";
import type { DesktopConversationActivityPayload } from "@lxe/desktop-protocol";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { ConversationDisplayController, type ConversationDisplaySnapshot } from "../features/sessions/display-controller";

import { canReadSessionResult, SessionStatusCache } from "../features/sessions/session-status";

import { callDashboard } from "./client";
import { dashboardQueryKeys } from "./query-keys";
import {
  normalizeSessionList,
} from "../features/sessions/model";
import type {
  ApiList,
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
export const STATS_REFRESH_INTERVAL_MS = 30_000;
export const CATALOG_STALE_TIME_MS = 5 * 60_000;
export const GATEWAY_LIFETIME_STALE_TIME_MS = Number.POSITIVE_INFINITY;

export function queryError(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

export function useUserQuestionsQuery(enabled: boolean, selectedSessionId: string) {
  const query = useQuery({
    queryKey: dashboardQueryKeys.sessions.questions,
    queryFn: async ({ signal }) => {
      const result = await callDashboard({ operation: "sessions.questions", input: {} });
      signal.throwIfAborted();
      return result;
    },
    enabled, retry: false, staleTime: 0,
    refetchOnMount: "always", refetchOnWindowFocus: "always",
    // Events are hints. Recover missed notifications and changes while unfocused.
    refetchInterval: 5_000, refetchIntervalInBackground: true,
  });
  const refetch = query.refetch;
  useEffect(() => { if (enabled) void refetch(); }, [enabled, selectedSessionId, refetch]);
  return query;
}

export function useAttachmentPreviewQuery(
  sessionId: string | undefined, id: string, variant: "thumbnail" | "expanded", enabled: boolean,
) {
  return useQuery({
    queryKey: dashboardQueryKeys.sessions.attachmentPreview(sessionId ?? "", id, variant),
    queryFn: async ({ signal }) => {
      const result = await callDashboard({ operation: "sessions.attachment.preview",
        input: { session_id: sessionId!, attachment_id: id, variant } });
      signal.throwIfAborted();
      return result;
    },
    enabled: enabled && !!sessionId,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
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

export function useSessionDetailQuery(sessionId: string, before: string | undefined, enabled = true) {
  const pageKey = before ?? "latest";
  return useQuery({
    queryKey: dashboardQueryKeys.sessions.detail(sessionId, pageKey),
    queryFn: () => callDashboard({
      operation: "sessions.detail",
      input: {
        session_id: sessionId,
        message_limit: SESSION_MESSAGE_PAGE_LIMIT,
        ...(before === undefined ? {} : { message_before: before }),
      },
    }),
    enabled: enabled && Boolean(sessionId),
    staleTime: ACTIVE_DATA_STALE_TIME_MS,
  });
}

export function useSessionConversationQuery(sessionId: string, enabled = true, suppliedController?: ConversationDisplayController) {
  const queryClient = useQueryClient();
  const [ownedController] = useState(() => new ConversationDisplayController());
  const controller = suppliedController ?? ownedController;
  const display = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const requests = useRef(new Map<string, Promise<SessionDetailPayload | undefined>>());
  const [fetching, setFetching] = useState<string | null>(null);
  const [pageError, setPageError] = useState<unknown>(null);
  useLayoutEffect(() => {
    controller.select(sessionId);
    requests.current.clear(); setFetching(null); setPageError(null);
    const cached = queryClient.getQueryData<SessionDetailPayload>(dashboardQueryKeys.sessions.detail(sessionId, "latest"));
    if (cached) controller.receiveHistory(cached, "latest", -1);
    const activityKey = dashboardQueryKeys.sessions.activity(sessionId);
    const receiveActivity = () => {
      const activity = queryClient.getQueryData<DesktopConversationActivityPayload>(activityKey);
      if (activity) controller.receiveActivity(activity);
    };
    receiveActivity();
    // Apply pushed activity before a concurrently resolving history request can confirm it.
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "success" && JSON.stringify(event.query.queryKey) === JSON.stringify(activityKey)) receiveActivity();
    });
    return () => {
      unsubscribe();
      void queryClient.cancelQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(sessionId) });
      queryClient.removeQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(sessionId), type: "inactive" });
    };
  }, [controller, sessionId, queryClient]);
  const latestQuery = useQuery({
    queryKey: dashboardQueryKeys.sessions.detail(sessionId, "latest"),
    queryFn: async ({ signal }) => {
      const ticket = controller.beginHistory();
      try {
        const page = await callDashboard({ operation: "sessions.detail", input: { session_id: sessionId, message_limit: SESSION_MESSAGE_PAGE_LIMIT } });
        const accepted = !signal.aborted && controller.completeHistory(ticket, page, "latest");
        if (accepted && page.context_reset_at) {
          queryClient.setQueryData<DesktopConversationActivityPayload>(dashboardQueryKeys.sessions.activity(sessionId),
            current => clearResetStreams(current, page.context_reset_at!));
        }
        // The Query cache shares the bounded tail instead of retaining evicted payloads.
        return accepted ? controller.getSnapshot().latest! : page;
      } catch (error) { if (!signal.aborted && controller.isCurrent(ticket)) controller.failHistory(error); throw error; }
    },
    enabled: enabled && Boolean(sessionId), staleTime: ACTIVE_DATA_STALE_TIME_MS, gcTime: 0,
  });
  const fetchPage = useCallback((direction: "older" | "newer"): Promise<SessionDetailPayload | undefined> => {
    const existing = requests.current.get(direction);
    if (existing) return existing;
    const page = controller.getSnapshot().detail;
    const cursor = direction === "older" ? page?.messages_page.previous_cursor : page?.messages_page.next_cursor;
    if (!enabled || !cursor || page?.session.session_id !== sessionId) return Promise.resolve(undefined);
    const ticket = controller.beginHistory();
    setFetching(direction); setPageError(null);
    const request = callDashboard({ operation: "sessions.detail", input: {
      session_id: sessionId, message_limit: SESSION_MESSAGE_PAGE_LIMIT,
      ...(direction === "older" ? { message_before: cursor } : { message_after: cursor }),
    } }).then(incoming => controller.completeHistory(ticket, incoming, direction) ? controller.getSnapshot().detail : undefined)
      .catch((error: unknown) => { if (controller.isCurrent(ticket)) setPageError(error); throw error; })
      .finally(() => {
        if (requests.current.get(direction) !== request) return;
        requests.current.delete(direction); setFetching(null);
      });
    requests.current.set(direction, request);
    return request;
  }, [enabled, sessionId, controller]);
  // Sending and the jump button change the same controller epoch. Discard in-flight pages,
  // cancel obsolete latest reads and request the new tail; local messages remain visible.
  useEffect(() => {
    if (!display.jump || display.sessionId !== sessionId) return;
    requests.current.clear(); setFetching(null); setPageError(null);
    if (enabled && sessionId) {
      void queryClient.cancelQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(sessionId) })
        .then(() => queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.detail(sessionId, "latest") }));
    }
  }, [display.jump, display.sessionId, sessionId, enabled, queryClient]);
  const data = display.sessionId === sessionId ? display.detail : undefined;
  return {
    controller, display, data,
    error: pageError ?? latestQuery.error,
    isPending: display.loadState === "loading" && !data,
    isFetching: latestQuery.isFetching || fetching !== null,
    isRefetchError: latestQuery.isRefetchError,
    hasPreviousPage: Boolean(data?.messages_page.has_previous && data.messages_page.previous_cursor),
    hasNextPage: Boolean(data?.messages_page.has_next && data.messages_page.next_cursor),
    isFetchingPreviousPage: fetching === "older", isFetchingNextPage: fetching === "newer",
    isFetchPreviousPageError: pageError !== null,
    fetchPreviousPage: useCallback(() => fetchPage("older"), [fetchPage]),
    fetchNextPage: useCallback(() => fetchPage("newer"), [fetchPage]),
    setVisibleGroups: controller.setVisibleGroups,
    setFollowing: controller.setFollowing,
    jumpToLatest: controller.jumpToLatest,
  };
}

export function useConversationActivityQuery(sessionId: string, enabled = true) {
  const queryClient = useQueryClient();
  const key = dashboardQueryKeys.sessions.activity(sessionId);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const before = queryClient.getQueryData<DesktopConversationActivityPayload>(key);
      const response = await callDashboard({ operation: "sessions.activity", input: { session_id: sessionId } });
      const current = queryClient.getQueryData<DesktopConversationActivityPayload>(key);
      // A pushed update during this read is newer than its captured server snapshot.
      return current && current !== before ? current : response;
    },
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

export function useSessionStatus(sessionIds:string[],ready:boolean,display:ConversationDisplaySnapshot,visible:boolean){
  const [cache]=useState(()=>new SessionStatusCache());
  const items=useSyncExternalStore(cache.subscribe,cache.getSnapshot,cache.getSnapshot);
  const [error,setError]=useState("");
  const [focused,setFocused]=useState(()=>document.hasFocus()&&document.visibilityState==="visible");
  const [refresh,setRefresh]=useState(0);
  const attempted=useRef(new Set<string>());
  const queryClient=useQueryClient();
  const key=JSON.stringify([...new Set([...sessionIds,display.sessionId].filter(Boolean))]);
  useEffect(()=>{
    const focus=()=>{const active=document.hasFocus()&&document.visibilityState==="visible";setFocused(active);if(active){attempted.current.clear();setRefresh(v=>v+1);}};
    window.addEventListener("focus",focus);window.addEventListener("blur",focus);document.addEventListener("visibilitychange",focus);
    return ()=>{window.removeEventListener("focus",focus);window.removeEventListener("blur",focus);document.removeEventListener("visibilitychange",focus);};
  },[]);
  // Register the stream before the first batch query; no per-token subscriptions.
  useEffect(()=>window.lxe?.desktop.onSessionStatus?.(snapshot=>{
    cache.receive(snapshot);
    for(const item of snapshot.items)if(item.result)void queryClient.invalidateQueries({queryKey:dashboardQueryKeys.sessions.detailSession(item.session_id)});
  }),[cache,queryClient]);
  useEffect(()=>{
    if(!ready||!error)return;
    const timer=setTimeout(()=>{attempted.current.clear();setRefresh(v=>v+1);},1000);
    return ()=>clearTimeout(timer);
  },[ready,error,refresh]);
  useEffect(()=>{
    if(!ready)return;
    let cancelled=false;
    const ids=JSON.parse(key) as string[];
    void (async()=>{
      try{
        for(let i=0;i<ids.length;i+=200){
          const snapshot=await callDashboard({operation:"sessions.status.list",input:{session_ids:ids.slice(i,i+200)}});
          if(cancelled)return;cache.receive(snapshot);
          // A snapshot can be the first evidence of a result missed while this
          // window was disconnected; refresh an already-cached transcript too.
          for(const item of snapshot.items)if(item.result)void queryClient.invalidateQueries({queryKey:dashboardQueryKeys.sessions.detailSession(item.session_id)});
        }
        setError("");
      }catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:String(cause));}
    })();
    return ()=>{cancelled=true;};
  },[key,ready,refresh,cache,queryClient]);
  const selected=items.get(display.sessionId);
  useEffect(()=>{
    if(!ready||error||!canReadSessionResult(selected,display,visible,focused))return;
    const result=selected!.result!;
    const ticket=JSON.stringify([selected!.session_id,result.turn_id,result.version]);
    if(attempted.current.has(ticket))return;
    attempted.current.add(ticket);
    void callDashboard({operation:"sessions.status.ack",input:{session_id:selected!.session_id,turn_id:result.turn_id,version:result.version}})
      .then(cache.receive).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
  },[selected,display,visible,focused,ready,error,refresh,cache]);
  return {items,error,ready};
}

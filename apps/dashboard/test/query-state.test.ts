import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type {
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DashboardTransport,
} from "@lxe/desktop-protocol";

import { setDashboardTransportForTests } from "../src/api/client";
import {
  applyDashboardInvalidation,
  createDashboardQueryClient,
  DEFAULT_GC_TIME_MS,
  DEFAULT_STALE_TIME_MS,
} from "../src/api/query-client";
import { dashboardQueryKeys } from "../src/api/query-keys";
import {
  ACTIVE_DATA_STALE_TIME_MS,
  BACKGROUND_TASKS_REFRESH_INTERVAL_MS,
  flattenSessionPages,
} from "../src/api/queries";
import type { SessionListPayload, SessionPayload } from "../src/api/payloads";

afterEach(() => setDashboardTransportForTests(undefined));

const session = (sessionId: string): SessionPayload => ({
  session_id: sessionId,
  title: sessionId,
  source: {},
  source_summary: { platform: "desktop", chat_type: "direct" },
  model: "test",
  reasoning_effort: "",
  model_config: {},
  created_at: 1,
  last_active_at: 1,
  message_count: 1,
  tool_call_count: 0,
  input_tokens: 1,
  output_tokens: 1,
  api_call_count: 1,
});

const page = (items: SessionPayload[], total = items.length, offset = 0): SessionListPayload => ({
  items,
  total,
  limit: 10,
  offset,
  summary: { total_sessions: total, tool_call_count: 0, token_count: 2 * total },
});

describe("Dashboard Query state", () => {
  test("uses stable keys and the configured cache policy", () => {
    expect(dashboardQueryKeys.sessions.list("  order  ")).toEqual(["sessions", "list", "order"]);
    expect(dashboardQueryKeys.sessions.detail("s-1", 2)).toEqual(["sessions", "detail", "s-1", 2]);
    expect(dashboardQueryKeys.sessions.activity("s-1")).toEqual(["sessions", "activity", "s-1"]);
    expect(dashboardQueryKeys.stats.byType("skills", 30)).toEqual(["stats", "skills", 30]);

    const options = createDashboardQueryClient().getDefaultOptions();
    expect(options.queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS);
    expect(options.queries?.gcTime).toBe(DEFAULT_GC_TIME_MS);
    expect(options.queries?.retry).toBe(1);
    expect(options.queries?.refetchOnWindowFocus).toBe(true);
    expect(options.queries?.refetchOnReconnect).toBe(false);
    expect(ACTIVE_DATA_STALE_TIME_MS).toBe(5_000);
    expect(BACKGROUND_TASKS_REFRESH_INTERVAL_MS).toBe(15_000);
  });

  test("keeps session list and detail push-driven without polling", () => {
    const source = readFileSync(new URL("../src/api/queries.ts", import.meta.url), "utf8");
    const sessions = source.slice(
      source.indexOf("export function useSessionsInfiniteQuery"),
      source.indexOf("export function flattenSessionPages"),
    );
    const detail = source.slice(
      source.indexOf("export function useSessionDetailQuery"),
      source.indexOf("export function useStatsOverviewQuery"),
    );
    expect(sessions).not.toContain("refetchInterval");
    expect(detail).not.toContain("refetchInterval");
    const clientSource = readFileSync(new URL("../src/api/query-client.tsx", import.meta.url), "utf8");
    expect(clientSource).toContain("refetchOnWindowFocus: true");
  });

  test("deduplicates concurrent requests for one query key", async () => {
    let calls = 0;
    let resolveRequest: ((value: DashboardRpcResult<"models.list">) => void) | undefined;
    const response = new Promise<DashboardRpcResult<"models.list">>((resolve) => { resolveRequest = resolve; });
    const transport: DashboardTransport = {
      call: async <O extends DashboardRpcOperation>(_call: DashboardRpcCall<O>): Promise<DashboardRpcResult<O>> => {
        calls += 1;
        return response as Promise<DashboardRpcResult<O>>;
      },
    };
    setDashboardTransportForTests(transport);
    const client = createDashboardQueryClient();
    const queryFn = () => transport.call({ operation: "models.list", input: {} });
    const first = client.fetchQuery({ queryKey: dashboardQueryKeys.models.list, queryFn });
    const second = client.fetchQuery({ queryKey: dashboardQueryKeys.models.list, queryFn });
    expect(calls).toBe(1);
    resolveRequest?.({ items: [], total: 0 });
    expect(await first).toEqual({ items: [], total: 0 });
    expect(await second).toEqual({ items: [], total: 0 });
  });

  test("deduplicates session ids across refreshed offset pages", () => {
    const result = flattenSessionPages([
      page([session("new"), session("s-1")], 3, 0),
      page([session("s-1"), session("s-2")], 3, 2),
    ]);
    expect(result.items.map((item) => item.session_id)).toEqual(["new", "s-1", "s-2"]);
    expect(result.total).toBe(3);
  });

  test("invalidates lists and only the named session detail", async () => {
    const client = createDashboardQueryClient();
    client.setQueryData(dashboardQueryKeys.sessions.list(""), page([session("s-1")]));
    client.setQueryData(dashboardQueryKeys.sessions.detail("s-1", "latest"), { id: "s-1" });
    client.setQueryData(dashboardQueryKeys.sessions.detail("s-2", "latest"), { id: "s-2" });

    await applyDashboardInvalidation(client, {
      revision: 1,
      domains: ["sessions"],
      session_ids: ["s-1"],
    });

    expect(client.getQueryState(dashboardQueryKeys.sessions.list(""))?.isInvalidated).toBe(true);
    expect(client.getQueryState(dashboardQueryKeys.sessions.detail("s-1", "latest"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(dashboardQueryKeys.sessions.detail("s-2", "latest"))?.isInvalidated).toBe(false);
  });

  test("clears lifecycle-static data when Gateway becomes ready again", async () => {
    const client = createDashboardQueryClient();
    client.setQueryData(dashboardQueryKeys.models.list, { items: [{ provider: "test" }] });
    await applyDashboardInvalidation(client, {
      revision: 3,
      domains: [
        "sessions",
        "stats",
        "background_tasks",
        "channels",
        "models",
        "connectors",
        "skills",
        "tools",
      ],
      session_ids: [],
    });
    expect(client.getQueryData(dashboardQueryKeys.models.list)).toBeUndefined();
  });
});

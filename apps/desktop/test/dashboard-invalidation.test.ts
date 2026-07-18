import { describe, expect, test } from "bun:test";
import { AGENT_PROTOCOL_VERSION, type AgentEvent, type DesktopDashboardInvalidation } from "@lxe/desktop-protocol";

import {
  DashboardInvalidationBatcher,
  dashboardDomainsForMutation,
  dashboardInvalidationForAgentEvent,
} from "../src/main/dashboard-invalidation";

const event = (
  type: "thread.started" | "turn.started" | "turn.completed" | "turn.failed" | "item.completed",
): AgentEvent => ({
  version: AGENT_PROTOCOL_VERSION,
  type,
  thread_id: "session-1",
  ...(type === "thread.started" ? {} : { turn_id: "turn-1" }),
  ...(type === "item.completed"
    ? { payload: { session_id: "session-1", message: { role: "assistant", content: "secret" } } }
    : { payload: {} }),
} as AgentEvent);

describe("Dashboard invalidation bridge", () => {
  test("maps runtime events to the minimum data domains", () => {
    expect(dashboardInvalidationForAgentEvent(event("thread.started"))).toEqual({
      domains: ["sessions"],
      sessionIds: ["session-1"],
    });
    expect(dashboardInvalidationForAgentEvent(event("item.completed"))).toEqual({
      domains: ["sessions"],
      sessionIds: ["session-1"],
    });
    expect(dashboardInvalidationForAgentEvent(event("turn.completed"))).toEqual({
      domains: ["sessions", "stats", "background_tasks"],
      sessionIds: ["session-1"],
    });
  });

  test("maps successful mutation operations to their related domains", () => {
    expect(dashboardDomainsForMutation("models.update")).toEqual(["models"]);
    expect(dashboardDomainsForMutation("models.thinking.update")).toEqual(["models"]);
    expect(dashboardDomainsForMutation("connectors.update")).toEqual(["connectors", "skills"]);
    expect(dashboardDomainsForMutation("mcp.servers.update")).toEqual(["tools"]);
    expect(dashboardDomainsForMutation("sessions.list")).toEqual([]);
  });

  test("coalesces events for 200ms and never forwards event bodies", () => {
    const published: DesktopDashboardInvalidation[] = [];
    let callback: (() => void) | undefined;
    let delay = 0;
    const batcher = new DashboardInvalidationBatcher(
      (invalidation) => published.push(invalidation),
      200,
      ((next, timeout) => {
        callback = next;
        delay = timeout;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      () => undefined,
    );

    batcher.push(["sessions"], ["session-1"]);
    batcher.push(["stats", "sessions"], ["session-1", "session-2"]);
    expect(delay).toBe(200);
    expect(published).toEqual([]);
    callback?.();

    expect(published).toEqual([{
      revision: 1,
      domains: ["sessions", "stats"],
      session_ids: ["session-1", "session-2"],
    }]);
    const wire = JSON.stringify(published[0]);
    expect(wire).not.toContain("secret");
    expect(wire).not.toContain("password");
    expect(wire).not.toContain("path");
  });
});

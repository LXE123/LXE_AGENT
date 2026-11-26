import { expect, test } from "bun:test";
import { DESKTOP_MCP_NAME, type DashboardRpcCall, type DashboardRpcOperation } from "@lxe/desktop-protocol";
import { DASHBOARD_HANDLERS, type DashboardHandlerContext, type DashboardHandler } from "../src/main/gateway/dashboard-handlers";

// How the Gateway orders these handlers around agentcli readiness is checked in fixtures/automation-stop.electron.ts.

function call<O extends DashboardRpcOperation>(operation: O, input: DashboardRpcCall<O>["input"]) {
  const handler = DASHBOARD_HANDLERS[operation] as DashboardHandler<O> | undefined;
  if (!handler) throw new Error(`no handler for ${operation}`);
  return (context: unknown) => handler({ operation, input } as DashboardRpcCall<O>, context as DashboardHandlerContext);
}

/** A deletion context whose parts record what happened; `failAgent` makes agentcli's delete throw. */
function deletionContext(options: { failAgent?: Error; busy?: boolean } = {}) {
  const events: string[] = [];
  const context = {
    parts: {
      sessionStatus: { flush: async () => { events.push("flush status"); } },
      bindings: {
        loadAll: () => ({ a: { session_id: "chat", session_key: "feishu:1" }, b: { session_id: "other", session_key: "feishu:2" } }),
        removeSession: (id: string) => { events.push(`remove bindings ${id}`); return ["binding"]; },
        restore: (removed: unknown) => { events.push(`restore bindings ${JSON.stringify(removed)}`); },
      },
      scheduler: {
        beginSessionDeletion: (id: string, keys: string[]) => {
          events.push(`fence ${id} ${keys.join(",")}`);
          return options.busy ? undefined : () => events.push("release fence");
        },
      },
      conversations: { forgetSession: (id: string) => events.push(`forget conversation ${id}`) },
      runtimeState: { forget: (id: string) => events.push(`forget runtime state ${id}`) },
    },
    runtime: {
      sessionAttachmentPaths: async () => ["/paste.txt"],
      dashboardCall: async (rpc: { operation: string }) => {
        events.push(`agentcli ${rpc.operation}`);
        if (options.failAgent) throw options.failAgent;
        return { session_id: "chat", deleted: true };
      },
    },
    store: {
      pastedText: { prepareDeletion: (id: string, paths: string[]) => events.push(`prepare pastes ${id} ${paths}`) },
      detachSession: (id: string) => { events.push(`detach gateway ${id}`); return "snapshot"; },
      restoreSession: (snapshot: unknown) => { events.push(`restore gateway ${snapshot}`); },
    },
    automations: { service: { pauseSession: (id: string) => events.push(`pause automations ${id}`) } },
    beforeDeleteSession: async (id: string) => { events.push(`before delete ${id}`); },
    collectPastedText: async (id: string) => { events.push(`collect pastes ${id}`); },
  };
  return { events, context };
}

test("deleting a session undoes Desktop's detach steps when agentcli refuses", async () => {
  const { events, context } = deletionContext({ failAgent: new Error("agent offline") });
  await expect(call("sessions.delete", { session_id: "chat" })(context)).rejects.toThrow("agent offline");
  expect(events).toEqual([
    "flush status", "fence chat feishu:1", "before delete chat", "prepare pastes chat /paste.txt",
    "detach gateway chat", "remove bindings chat", "agentcli sessions.delete",
    `restore bindings ["binding"]`, "restore gateway snapshot", "release fence",
  ]);
});

test("deleting a session cleans up only after agentcli deleted it", async () => {
  const { events, context } = deletionContext();
  expect(await call("sessions.delete", { session_id: "chat" })(context)).toEqual({ session_id: "chat", deleted: true });
  expect(events.slice(events.indexOf("agentcli sessions.delete"))).toEqual([
    "agentcli sessions.delete", "pause automations chat", "forget conversation chat",
    "forget runtime state chat", "collect pastes chat", "release fence",
  ]);
});

test("a session with an active or queued turn is not deleted", async () => {
  const { events, context } = deletionContext({ busy: true });
  await expect(call("sessions.delete", { session_id: "chat" })(context)).rejects.toThrow("stop it before deleting");
  expect(events).toEqual(["flush status", "fence chat feishu:1"]);
});

test("forking waits for the session's current work", async () => {
  const forwarded: string[] = [];
  const context = (activity: { active?: { turn_id: string }; queued: unknown[] }, inflight = false) => ({
    parts: { conversations: { activity: () => activity }, scheduler: { hasInflightWork: () => inflight } },
    runtime: { dashboardCall: async (rpc: { operation: string }) => { forwarded.push(rpc.operation); return { session: {} }; } },
  });
  const fork = (input: { session_id: string; turn_id?: string }) => call("sessions.fork", input);
  await expect(fork({ session_id: "chat" })(context({ queued: [] }, true))).rejects.toThrow("Wait for the current turn");
  await expect(fork({ session_id: "chat" })(context({ queued: [{}] }))).rejects.toThrow("Wait for the current turn");
  await expect(fork({ session_id: "chat", turn_id: "t1" })(context({ active: { turn_id: "t1" }, queued: [] }))).rejects.toThrow("Wait for the current turn");
  await fork({ session_id: "chat", turn_id: "t0" })(context({ active: { turn_id: "t1" }, queued: [] }));
  await fork({ session_id: "chat" })(context({ queued: [] }));
  expect(forwarded).toEqual(["sessions.fork", "sessions.fork"]);
});

test("opening files reports a failure as text and only reveal asks for the folder", async () => {
  const calls: unknown[] = [];
  const context = (failure?: Error) => ({
    fileCall: async (rpc: unknown) => { calls.push(rpc); if (failure) throw failure; },
  });
  expect(await call("sessions.file.open", { session_id: "s", artifact_id: "a" })(context())).toEqual({ opened: true, error: "" });
  expect(await call("sessions.file.reveal", { session_id: "s", artifact_id: "a" })(context(new Error("gone"))))
    .toEqual({ revealed: false, error: "gone" });
  expect(await call("sessions.attachment.open", { session_id: "s", attachment_id: "f" })(context(new Error("denied"))))
    .toEqual({ opened: false, error: "denied" });
  expect(calls).toEqual([
    { operation: "open", input: { ref: { session_id: "s", kind: "artifact", id: "a" } } },
    { operation: "open", input: { ref: { session_id: "s", kind: "artifact", id: "a" }, reveal: true } },
    { operation: "open", input: { ref: { session_id: "s", kind: "attachment", id: "f" } } },
  ]);
});

test("a model default that cannot be saved fails a global change but not a conversation's", async () => {
  const model = { provider: "p", model: "m", credential_source: "local", thinking_state: { level: "high" } };
  const context = {
    runtime: { dashboardCall: async () => model },
    config: { saveRuntimePreference: () => { throw new Error("disk full"); } },
  };
  expect(await call("models.update", { provider: "p", model: "m", session_id: "chat" })(context)).toEqual(model);
  await expect(call("models.update", { provider: "p", model: "m" })(context)).rejects.toThrow("disk full");
  expect(await call("models.update", { provider: "p", model: "m", remember_default: false })(context)).toEqual(model);
});

test("Desktop's own MCP switch stays in Desktop while other MCP servers go to agentcli", async () => {
  const seen: string[] = [];
  const context = {
    runtime: { dashboardCall: async (rpc: { input: { name: string } }) => { seen.push(`agentcli ${rpc.input.name}`); return {}; } },
    automations: { setMcpEnabled: async (enabled: boolean) => { seen.push(`desktop ${enabled}`); return {}; } },
  };
  await call("mcp.servers.update", { name: DESKTOP_MCP_NAME, enabled: false })(context);
  await call("mcp.servers.update", { name: "github", enabled: true })(context);
  expect(seen).toEqual(["desktop false", "agentcli github"]);
});

test("Feishu owner pairing reports unavailable without the channel and starts a code with it", async () => {
  expect(await call("channels.feishu.owner", {})({ parts: {} })).toEqual({
    available: false, paired: false, owner_open_id_masked: "", paired_at: "", pairing: null,
  });
  await expect(call("channels.feishu.owner.pair", {})({ parts: {} })).rejects.toThrow("飞书渠道未配置");

  let pairing: { code: string; expires_at: string } | null = null;
  const feishuOwner = {
    status: () => ({ paired: false, owner_open_id_masked: "", paired_at: "", pairing }),
    startPairing: () => (pairing = { code: "123456", expires_at: "2026-01-01T00:10:00.000Z" }),
  };
  expect(await call("channels.feishu.owner.pair", {})({ parts: { feishuOwner } })).toEqual({
    available: true, paired: false, owner_open_id_masked: "", paired_at: "",
    pairing: { code: "123456", expires_at: "2026-01-01T00:10:00.000Z" },
  });
  expect((await call("channels.feishu.owner", {})({ parts: { feishuOwner } })).pairing?.code).toBe("123456");
});

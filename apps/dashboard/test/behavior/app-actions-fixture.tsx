import React, { useState } from "react";
import { useModelActions } from "../../src/api/model-actions";
import { useMcpActions } from "../../src/api/mcp-actions";
import { useCurrentModelQuery, useModelsQuery, useToolsetsQuery, useConversationActivityQuery } from "../../src/api/queries";
import { useConversationEvents } from "../../src/features/sessions/use-conversation-events";
import { ConversationComposer } from "../../src/features/sessions/view";
import { McpServicesView } from "../../src/features/integrations/view";
import type { DesktopConversationActivityPayload, DesktopConversationEvent, DesktopConversationStreamEvent, McpServerPayload } from "@lxe/desktop-protocol";
import { modelRow, modelOption } from "../features/models/source-fixtures";

const models = () => [modelRow("deepseek", "local", "Local", [modelOption("first"), modelOption("second")]),
  modelRow("deepseek", "cloud", "Cloud", [modelOption("first")])];
let current = models()[0]!;
let server: McpServerPayload;
let failure = "", held = "";
let release: (() => void) | undefined;
let sends = 0;
let controls: ReturnType<typeof useModelActions> | undefined;
const activities = new Map<string, DesktopConversationActivityPayload>();
const activityListeners = new Set<(event: DesktopConversationEvent) => void>();
const streamListeners = new Set<(event: DesktopConversationStreamEvent) => void>();

export const actionFixture = {
  active: false,
  reset() {
    this.active = true; current = models()[0]!; failure = ""; held = ""; release = undefined; sends = 0; activities.clear();
    server = { name: "fixture-mcp", enabled: true, transport: "stdio", status: "ready", tool_count: 0, error: "", server_title: "Fixture MCP", connector_id: "", connector_name: "", connector_description: "", exposure: "", tools: [] };
  },
  fail(operation: string) { failure = operation; },
  hold(operation: string) { held = operation; },
  release() { held = ""; release?.(); },
  select(model: string, source: "local" | "cloud" = "local") { controls!.setCurrentModel("deepseek", model, source); },
  thinking(level: string) { controls!.setCurrentThinkingLevel(level); },
  state() { return { sends, activityListeners: activityListeners.size, streamListeners: streamListeners.size }; },
  onActivity(listener: (event: DesktopConversationEvent) => void) { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; },
  onStream(listener: (event: DesktopConversationStreamEvent) => void) { streamListeners.add(listener); return () => { streamListeners.delete(listener); }; },
  snapshot(id = "event-session", seq = 1, text = "a") {
    const activity: DesktopConversationActivityPayload = {
      session_id: id, queued: [], latest: null,
      active: { turn_id: "event-turn", message_id: "event-message", text: "hello", state: "running", started_at: 1, user_persisted_at: 1, settled_at: 0,
        stream: { seq, state: "delta", content: text, thinking: "", redacted_thinking_count: 0, thinking_elapsed_ms: 0, tool_pending: false, tool_elapsed_ms: 0, tool_steps: [],
          process_parts: [{ type: "text", part_id: "answer", sequence: 1, status: "streaming", presentation: "final", text }],
          display_metrics: { status: "running", phase: "thinking", elapsed_ms: 1, model: "first", input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, context_tokens: 0, context_window_tokens: 100 } } },
    };
    activities.set(id, activity);
    activityListeners.forEach(listener => listener({ activity: structuredClone(activity) }));
  },
  batch(seq: number, delta: string, id = "event-session") {
    streamListeners.forEach(listener => listener({ batch: { session_id: id, turn_id: "event-turn", emit_id: "event", seq,
      mutations: [{ kind: "part_delta", part_id: "answer", field: "text", delta }] } }));
  },
  finish() {
    const activity = structuredClone(activities.get("event-session")!);
    activity.latest = { ...activity.active!, state: "completed" }; activity.active = null;
    activities.set(activity.session_id, activity);
    activityListeners.forEach(listener => listener({ activity }));
  },
  async rpc(call: { operation: string; input: Record<string, unknown> }) {
    if (held === call.operation) await new Promise<void>(resolve => { release = resolve; });
    if (failure === call.operation) throw new Error(`EACCES: fixture ${call.operation} rejected`);
    switch (call.operation) {
      case "models.current": return structuredClone(current);
      case "models.list": return { items: models().map(row => row.credential_source === current.credential_source ? { ...row, ...current } : row) };
      case "models.update": {
        const row = models().find(row => row.credential_source === call.input.credential_source)!;
        current = { ...row, ...row.model_options.find(option => option.model === call.input.model)! };
        return structuredClone(current);
      }
      case "models.thinking.update": current = { ...current, thinking_state: { ...current.thinking_state!, level: String(call.input.level) } }; return structuredClone(current);
      case "toolsets.list": return { items: [{ name: "mcp", label: "MCP", enabled: true, tools: [], servers: [structuredClone(server)] }] };
      case "mcp.servers.update": server = { ...server, enabled: Boolean(call.input.enabled), status: call.input.enabled ? "ready" : "disabled" }; return structuredClone(server);
      case "sessions.activity": return structuredClone(activities.get(String(call.input.session_id)) ?? { session_id: call.input.session_id, active: null, latest: null, queued: [] });
      case "sessions.detail": return { session: { session_id: call.input.session_id, permission_mode: "workspace-write" } };
      case "sessions.execTasks": return { items: [] };
      default: throw new Error(`Unexpected action fixture RPC: ${call.operation}`);
    }
  },
};

export function AppActionsFixture({ subscribed = true }: { subscribed?: boolean }) {
  return <>{subscribed && <EventSubscription />}<ActionControls /></>;
}
function EventSubscription() { useConversationEvents(); return null; }
function ActionControls() {
  const [error, setError] = useState("");
  const currentQuery = useCurrentModelQuery();
  const modelsQuery = useModelsQuery();
  const toolsQuery = useToolsetsQuery();
  const activity = useConversationActivityQuery("event-session");
  const otherActivity = useConversationActivityQuery("other-session");
  const actions = useModelActions({ current: currentQuery.data, models: modelsQuery.data?.items ?? [], onError: setError });
  controls = actions;
  const mcp = useMcpActions(setError);
  return <>
    <output id="action-state">{JSON.stringify({ model: currentQuery.data?.model, source: currentQuery.data?.credential_source,
      thinking: currentQuery.data?.thinking_state?.level, modelSaving: actions.modelSaving, thinkingSaving: actions.thinkingSaving,
      models: modelsQuery.data?.items.map(item => ({ model: item.model, source: item.credential_source })),
      activity: activity.data, otherActivity: otherActivity.data })}</output>
    <output id="action-error">{error}</output>
    <McpServicesView mcpError="" mcpSavingId={mcp.savingId} mcpToolset={toolsQuery.data?.items[0]} onToggleMcpServer={mcp.toggleMcpServer} />
    <ConversationComposer contextDetail={null} activity={null} conversationKey="actions" currentModel={currentQuery.data ?? null}
      models={modelsQuery.data?.items ?? []} modelLoading={currentQuery.isPending || modelsQuery.isPending}
      modelSaving={actions.modelSaving} thinkingSaving={actions.thinkingSaving} runtimeReady runtimeUnavailableMessage=""
      onModelChange={actions.setCurrentModel} onThinkingLevelChange={actions.setCurrentThinkingLevel}
      onSend={async () => { sends++; }} onStop={async () => {}} />
  </>;
}

import type { DesktopCloudState, DesktopSyntheticPerformerTask, LxeDesktopBridge, McpServerPayload, ModelPayload, ToolsetPayload } from "@lxe/desktop-protocol";
import { setupState, cloudState } from "../desktop/settings-fixture-data";
import { modelOption, modelRow } from "../features/models/source-fixtures";

type Call = { operation: string; input?: unknown };
export function createDashboardContractFixture(calls: Call[]) {
  let setup = setupState();
  let cloud = cloudState({ native_access: { status: "connected", model_status: "ready", last_error: "", verified_at: 1, is_admin: false } });
  const cloudListeners = new Set<(value: DesktopCloudState) => void>();
  const taskListeners = new Set<(value: DesktopSyntheticPerformerTask) => void>();
  const failures = new Set<string>();
  const holds = new Set<string>();
  const pending = new Map<string, () => void>();
  const record = async (operation: string, input?: unknown) => { calls.push({ operation, input }); await gate(operation); };
  async function gate(operation: string) {
    if (holds.has(operation)) await new Promise<void>(resolve => pending.set(operation, resolve));
    if (failures.has(operation)) throw new Error(`EACCES: fixture ${operation} denied`);
  }
  const models: ModelPayload[] = [
    modelRow("deepseek", "local", "DeepSeek", [modelOption("fixture-model"), modelOption("next-model")]),
    modelRow("kimi_coding", "local", "Kimi Coding", [modelOption("kimi-model")]),
    modelRow("openrouter", "cloud", "OpenRouter", [modelOption("unavailable-model")], false),
  ];
  let current = models[0]!;
  const server: McpServerPayload = { name: "fixture-server", enabled: true, transport: "stdio", status: "ready", tool_count: 1,
    error: "", server_title: "Fixture server", connector_id: "fixture", connector_name: "Fixture connector",
    connector_description: "Local fixture", exposure: "full", tools: [{ rawName: "lookup", modelName: "fixture_lookup" }] };
  const toolsets: ToolsetPayload[] = [{ name: "mcp", label: "MCP", enabled: true, servers: [server], tools: [{
    name: "fixture_lookup", raw_name: "lookup", description: "Look up fixture data", parameters: {}, requires_resource: null,
    source: "mcp", exposure: "full", connector_name: "Fixture connector",
  }] }];
  let task: DesktopSyntheticPerformerTask | null = null;
  const controls = {
    fail(operation: string, value: boolean) { if (value) failures.add(operation); else failures.delete(operation); },
    hold(operation: string) { holds.add(operation); },
    release(operation: string) { holds.delete(operation); pending.get(operation)?.(); pending.delete(operation); },
    cloud(patch: Partial<DesktopCloudState>) { cloud = { ...cloud, ...patch }; cloudListeners.forEach(listener => listener(structuredClone(cloud))); },
    listeners() { return { cloud: cloudListeners.size, task: taskListeners.size }; },
    completeTask() { if (task) { task = { ...task, state: "completed", stage: "done", processed: 1 }; taskListeners.forEach(listener => listener(structuredClone(task!))); } },
    clearCalls() { calls.length = 0; },
  };
  const desktop = {
    getSetupState: async () => structuredClone(setup),
    getCloudState: async () => structuredClone(cloud),
    onCloudStateChanged: (listener: (state: DesktopCloudState) => void) => { cloudListeners.add(listener); return () => { cloudListeners.delete(listener); }; },
    openCloudDestination: async destination => { await record("openCloudDestination", destination); },
    saveLocalModelCredential: async input => { await record("saveLocalModelCredential", input); setup = { ...setup,
      local_model_providers: setup.local_model_providers.map(row => row.provider === input.provider ? { ...row, configured: true } : row) }; return structuredClone(setup); },
    selectSyntheticPerformerSources: async kind => { await record("selectSyntheticPerformerSources", kind); return { kind, selection_id: "source-handle", display_path: "Fixture media", selected_count: 1 }; },
    selectSyntheticPerformerOutput: async () => { await record("selectSyntheticPerformerOutput"); return { output_id: "output-handle", display_path: "Fixture output" }; },
    getSyntheticPerformerTask: async () => structuredClone(task),
    onSyntheticPerformerTaskChanged: (listener: (value: DesktopSyntheticPerformerTask) => void) => { taskListeners.add(listener); return () => { taskListeners.delete(listener); }; },
    startSyntheticPerformerTask: async input => { await record("startSyntheticPerformerTask", input); task = { task_id: "task-handle", action: input.action,
      state: "running", stage: input.action, processed: 0, total: 1, current_file: "sample.png", selection_id: input.selection_id,
      recursive: input.recursive, items: [], counts: {}, error: "" }; return structuredClone(task); },
    cancelSyntheticPerformerTask: async id => { await record("cancelSyntheticPerformerTask", id); task = { ...task!, state: "cancelled" }; return structuredClone(task); },
    openSyntheticPerformerOutput: async id => { await record("openSyntheticPerformerOutput", id); },
  } satisfies Partial<LxeDesktopBridge["desktop"]>;
  function rpc(call: { operation: string; input: Record<string, unknown> }): unknown {
    switch (call.operation) {
      case "stats.skills.list": return { days: 7, items: Array.from({ length: 8 }, (_, i) => ({ name: `skill-${i}`, executions: i + 1, failures: 0, success_rate: 1 })) };
      case "models.current": return structuredClone(current);
      case "models.list": return { items: structuredClone(models) };
      case "models.update": return (async () => { await gate(call.operation); const row = models.find(m => m.provider === call.input.provider)!;
        current = { ...row, ...row.model_options.find(m => m.model === call.input.model)!, model: String(call.input.model) }; return structuredClone(current); })();
      case "models.thinking.update": return (async () => { await gate(call.operation); current = { ...current, thinking_state: { enabled: call.input.level !== "off", editable: true, level: String(call.input.level) } }; return structuredClone(current); })();
      case "toolsets.list": return { items: structuredClone(toolsets) };
      case "mcp.servers.update": return (async () => { await gate(call.operation); server.enabled = Boolean(call.input.enabled); return structuredClone(server); })();
      case "skills.list": return { items: [{ name: "fixture-skill", description: "Fixture skill", type: "default", source: "default", commands: [], references: [], location: "/skills/fixture-skill/SKILL.md" }], total: 1 };
      case "commands.list": return { items: [] };
      case "sessions.file.open": return (async () => { await gate(call.operation); return { opened: true }; })();
      case "sessions.file.reveal": return (async () => { await gate(call.operation); return { revealed: true }; })();
      case "sessions.attachment.open": return (async () => { await gate(call.operation); return { opened: true }; })();
      default: return undefined;
    }
  }
  return { desktop, rpc, controls };
}

import { setDashboardTransportForTests } from "../../../src/api/client";

// Mount the real application through the shared desktop bridge fixture. Only RPC
// boundaries are substituted; navigation, the outer content panel and page are real.
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario");
const created = new Set<string>();
const calls: { operation: string; input: unknown }[] = [];
Object.assign(window, { automationFixtureCalls: calls });
params.set("app", "1");
params.set("workspaces", "1");
params.set("contracts", "1");
params.set("section", "automations");
params.set("language", "zh");
params.set("runtime", scenario === "offline" ? "offline" : "ready");
history.replaceState(null, "", `${location.pathname}?${params}`);

setDashboardTransportForTests({ async call(call) {
  calls.push(structuredClone(call));
  if (call.operation === "skills.user.list") return { items: [], total: 0 };
  if (call.operation === "automations.list") {
    if (scenario === "loading") await new Promise(resolve => setTimeout(resolve, 60_000));
    if (scenario === "error") throw new Error("Fixture: SQLITE_BUSY: database is locked (automations.list)");
  }
  if (call.operation === "automations.save" && scenario === "save-error") throw new Error("Fixture: schedule.start_at is invalid: non-existent local time");
  if (call.operation === "automations.preview" && scenario === "pending") await new Promise(resolve => setTimeout(resolve, 4000));
  if (!call.operation.startsWith("automations.") && !["sessions.workspaces", "sessions.detail", "models.list"].includes(call.operation)) {
    return window.lxe!.dashboard.call(call);
  }
  const response = await fetch("/__automations", { method: "POST", body: JSON.stringify(call) });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  if (call.operation === "automations.save") created.add(result.id);
  if (call.operation === "automations.list" && scenario === "empty") result.items = result.items.filter((task: { id: string }) => created.has(task.id));
  return result;
} });

await import("../../behavior/renderer");

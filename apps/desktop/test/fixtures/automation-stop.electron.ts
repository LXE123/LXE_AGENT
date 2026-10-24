import { app } from "electron";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DesktopGateway } from "../../src/main/desktop-gateway";
import { DesktopAutomations } from "../../src/main/automations";
import { NodeAutomationStore } from "../../src/main/automation-store";
import { SessionRuntimeState } from "../../../gateway/src/state/session-state";

async function verifyStop(state: "running" | "queued") {
  const db = new DatabaseSync(":memory:");
  const store = new NodeAutomationStore(db);
  const runtimeState = new SessionRuntimeState();
  const sent: string[] = [], stopped: Array<[string, string | undefined]> = [];
  const runtime = { isReady: true, dashboardCall: async (call: { operation: string }) => {
    if (call.operation === "sessions.detail") return { session: { source_summary: { platform: "desktop" } } };
    if (["sessions.questions", "sessions.approvals"].includes(call.operation)) return { items: [] };
    throw new Error(`Unexpected fixture RPC ${call.operation}`);
  } };
  const composition = { parts: { runtimeState,
    scheduler: { isSessionDeletionFenced: () => false, hasInflightWork: () => false },
    sessionStatus: { list: async () => ({ items: [{ state: "idle" }] }), flush: async () => {} },
    conversations: {
      stop: async (sessionId: string, turnId?: string) => {
        stopped.push([sessionId, turnId]);
        if (turnId === "old-turn") throw new Error("This task is no longer active");
        runtimeState.suspendAutonomy(sessionId);
        return { session_id: sessionId, stopped_turn_id: state === "running" ? "turn" : null,
          cleared_turn_ids: state === "queued" ? ["turn"] : [] };
      },
      send: async (_input: unknown, admission: { assertCurrent(): void; id: string }) => {
        admission.assertCurrent(); sent.push(admission.id);
      },
    },
  } };
  const automations = new DesktopAutomations({ store, environment: {}, node: process.execPath, script: "unused",
    changed() {}, onError(error) { throw error; },
    runtime: runtime as unknown as ConstructorParameters<typeof DesktopAutomations>[0]["runtime"],
    composition: composition as unknown as ConstructorParameters<typeof DesktopAutomations>[0]["composition"],
  });
  // Exercise the production RPC routing without starting external runtimes or user data.
  const gateway: DesktopGateway = Object.assign(Object.create(DesktopGateway.prototype), { runtime, composition, automations });
  try {
    automations.service.start(); await automations.service.tick();
    const definition = { name: "test", prompt: "report", timezone: "UTC", schedule: { kind: "interval" as const, minutes: 60 },
      target: { mode: "reuse" as const, session_id: "chat" } };
    const first = await automations.service.save({ definition });
    const second = await automations.service.save({ definition });
    await gateway.dashboardCall({ operation: "sessions.stop", input: { session_id: "chat", turn_id: "turn" } });
    assert.deepEqual(stopped, [["chat", "turn"]]);
    assert.deepEqual(automations.service.get(first.id), first);
    assert.deepEqual(automations.service.get(second.id), second);
    assert.equal(runtimeState.isAutonomySuspended("chat"), true);
    await assert.rejects(gateway.dashboardCall({ operation: "sessions.stop", input: { session_id: "chat", turn_id: "old-turn" } }), /no longer active/);
    assert.deepEqual(automations.service.get(first.id), first);
    // Simulate the next persisted deadline, with the prior turn already settled.
    store.save({ ...first, next_run_at: Date.now() - 1, next_nominal_at: Date.now() - 1 }, first.version);
    await automations.service.tick();
    assert.deepEqual(sent, [first.id]);
    assert.equal(automations.service.get(first.id).status, "active");
    assert.deepEqual(automations.service.get(second.id), second);
    const current = automations.service.get(first.id);
    await automations.service.setStatus(first.id, current.version, "paused");
    assert.equal(stopped.length, 2); // Pausing the plan does not call conversation.stop.
  } finally { await automations.close(); db.close(); }
}

async function verifyTaskOptions() {
  const db = new DatabaseSync(":memory:"); const store = new NodeAutomationStore(db);
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const runtime = { isReady: true, dashboardCall: async (call: typeof calls[number]) => {
    calls.push(call);
    switch (call.operation) {
      case "sessions.workspaces": return { items: [{ workspace_id: "ws", directory: process.argv[2]! }] };
      case "models.list": return { items: [{ provider: "p", credential_source: "local", selectable: true, model_options: [{ model: "m", thinking_levels: ["off", "high"] }] }] };
      case "models.current": return { thinking_levels: ["off", "high"] };
      case "models.update": case "models.thinking.update": return {};
      case "titles.generate": return { title: "后台生成的名称" };
      default: throw new Error(`Unexpected task options RPC ${call.operation}`);
    }
  } };
  const prepared: string[] = [];
  const composition = { parts: { conversations: { send: async (_input: unknown, admission: { session_id: string; prepareSession?(): Promise<void>; assertCurrent(): void }) => {
    admission.assertCurrent(); await admission.prepareSession?.(); prepared.push(admission.session_id);
  } }, sessionStatus: { flush: async () => {} } } };
  const automation = new DesktopAutomations({ store, environment: {}, node: process.execPath, script: "unused", changed() {}, onError(error) { throw error; },
    runtime: runtime as unknown as ConstructorParameters<typeof DesktopAutomations>[0]["runtime"],
    composition: composition as unknown as ConstructorParameters<typeof DesktopAutomations>[0]["composition"] });
  try {
    automation.service.start(); await automation.service.tick();
    const definition = { name: "", prompt: "生成报告", timezone: "UTC", schedule: { kind: "interval" as const, minutes: 60 },
      target: { mode: "new" as const, workspace_id: "ws", effort: "high", model: { provider: "p", model: "m", credential_source: "local" as const } } };
    const task = await automation.service.save({ definition });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(automation.service.get(task.id).name, "后台生成的名称");
    assert.deepEqual(calls.find(call => call.operation === "titles.generate")?.input, { text: definition.prompt, model: definition.target.model });
    assert.equal(prepared.length, 0);
    const run = await automation.service.runNow(task.id);
    assert.equal(run.dispatch_state, "accepted");
    assert.deepEqual(calls.filter(call => ["models.update", "models.thinking.update"].includes(call.operation)), [
      { operation: "models.update", input: { ...definition.target.model, session_id: run.session_id } },
      { operation: "models.thinking.update", input: { level: "high", session_id: run.session_id } },
    ]);
    await assert.rejects(automation.service.save({ definition: { ...definition, target: { ...definition.target, effort: "unsupported" } } }), /思考强度/);
    calls.length = 0;
    const defaultModel = await automation.service.save({ definition: { ...definition, name: "手写名称", target: { mode: "new", workspace_id: "ws", effort: "off" } } });
    const secondRun = await automation.service.runNow(defaultModel.id);
    assert.equal(secondRun.dispatch_state, "accepted");
    assert.equal(calls.some(call => call.operation === "titles.generate" || call.operation === "models.update"), false);
    assert.deepEqual(calls.find(call => call.operation === "models.thinking.update")?.input, { level: "off", session_id: secondRun.session_id });
  } finally { await automation.close(); db.close(); }
}

app.disableHardwareAcceleration();
app.setPath("userData", join(process.argv[2]!, "profile"));
app.whenReady().then(async () => {
  await verifyStop("running");
  await verifyStop("queued");
  await verifyTaskOptions();
  console.log("automation-stop-routing-passed");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

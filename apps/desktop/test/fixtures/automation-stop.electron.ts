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

app.disableHardwareAcceleration();
app.setPath("userData", join(process.argv[2]!, "profile"));
app.whenReady().then(async () => {
  await verifyStop("running");
  await verifyStop("queued");
  console.log("automation-stop-routing-passed");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

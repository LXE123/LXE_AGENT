import { app } from "electron";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDirectGatewayComposition, type DirectAgentRuntime } from "@lxe/gateway/desktop";
import { DesktopConversationAttachmentService } from "../../src/main/conversation-attachments";
import { DesktopGateway } from "../../src/main/desktop-gateway";

async function verify(root: string) {
  const workspace = { directory: root, worktree: root };
  const turn = Promise.withResolvers<Awaited<ReturnType<DirectAgentRuntime["runTurn"]>>>();
  let attempts = 0;
  const runtime: DirectAgentRuntime = {
    isReady: true, async start() {}, async stop() {}, runTurn: () => turn.promise,
    async steerTurn() { if (++attempts === 1) throw new Error("fixture admission failed"); },
  };
  const composition = createDirectGatewayComposition({
    projectRoot: root, defaultWorkspace: () => workspace, runtime,
    storage: {
      async getSession(session_id) { return { session_id, source: { platform: "desktop" }, workspace }; },
      async getResponseRoute() { return undefined; },
      async ensureSession() {}, async upsertResponseRoute() {}, async patchResponseRoute() {},
    },
  });
  composition.syncRuntimeReadiness();
  const attachments = new DesktopConversationAttachmentService();
  const gateway: DesktopGateway = Object.assign(Object.create(DesktopGateway.prototype), {
    runtime, composition, options: { attachments },
  });
  const path = join(root, "note.txt");
  writeFileSync(path, "note");
  const ids = attachments.register([path]).map(item => item.attachment_id);
  const original = await gateway.dashboardCall({ operation: "sessions.send", input: { session_id: "chat", text: "start" } });
  const send = (client_message_id: string) => gateway.dashboardCall({ operation: "sessions.send", input: {
    session_id: "chat", steer_turn_id: original.turn_id, client_message_id, text: "", attachment_ids: ids,
  } });
  try {
    await assert.rejects(send("same"), /fixture admission failed/);
    const first = send("same");
    const retry = send("same");
    const competing = send("different");
    const [accepted, replay] = await Promise.all([first, retry, assert.rejects(competing, /already being submitted/)]);
    assert.equal(accepted.state, "steered");
    assert.deepEqual(replay, accepted);
    assert.deepEqual(await send("same"), accepted);
    await assert.rejects(send("different"), /no longer available/);
    assert.equal(attempts, 2);
  } finally {
    turn.resolve({ status: "completed", reply: "", input_tokens: 0, output_tokens: 0, tool_calls: 0, remaining_steering: [] });
    await composition.stop();
  }
}

app.disableHardwareAcceleration();
const root = process.argv[2]!;
app.setPath("userData", join(root, "profile"));
app.whenReady().then(() => verify(root)).then(() => {
  console.log("steering-receipts-passed");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

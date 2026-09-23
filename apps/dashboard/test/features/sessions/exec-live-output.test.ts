import { expect, test } from "bun:test";
import type { BackgroundTaskChangedPayload, DesktopConversationTurnPayload } from "@lxe/desktop-protocol";
import { ConversationDisplayController } from "../../../src/features/sessions/display-controller";
import type { SessionDetailPayload } from "../../../src/api/payloads";
import { connectExecLiveOutput } from "../../../src/features/sessions/exec-live-output";

const update = (revision: number, status: "running" | "failed" = "running"): BackgroundTaskChangedPayload => ({
  tool_call_id: "call",
  task: { exec_id: "exec", session_id: "s", origin_turn_id: "turn", revision, status,
    pid: 1, command: "command", cwd: "/", started_at: 1, ended_at: status === "running" ? null : 2,
    duration_sec: 1, exit_code: status === "running" ? null : 4, truncated: false, output_tail: `output-${revision}` },
  step: { id: "call", name: "exec", title: "Run command", detail: "command", icon_token: "x",
    status: status === "running" ? "running" : "error", duration_ms: 1000,
    ...(status === "running" ? { result_block: { language: "text", content: `output-${revision}` } }
      : { error_block: { language: "text", content: `output-${revision}` } }) },
});

test("recovery subscribes first, merges newer events and discards reads after leaving the session", async () => {
  const controller = new ConversationDisplayController();
  controller.select("s");
  controller.receiveActivity({ session_id: "s", active: null, queued: [], latest: turn() });
  let receive!: (value: BackgroundTaskChangedPayload) => void;
  let resolve!: (value: { items: BackgroundTaskChangedPayload[] }) => void;
  let unsubscribed = false;
  const connection = connectExecLiveOutput(controller, callback => {
    receive = callback; return () => { unsubscribed = true; };
  }, () => {
    expect(receive).toBeDefined();
    return new Promise(done => { resolve = done; });
  }, error => { throw error; });
  const body = () => controller.getSnapshot().rows.find(row => row.kind === "tool")?.liveTool?.result_block?.content;
  const first = connection.refresh();
  await Promise.resolve();
  receive(update(3));
  resolve({ items: [update(2)] });
  await first;
  expect(body()).toBe("output-3");
  // A runtime restart has no retained processes; remove only snapshots predating this read.
  const restarted = connection.refresh();
  await Promise.resolve();
  resolve({ items: [] });
  await restarted;
  expect(body()).toBe("output-0");
  const leaving = connection.refresh();
  await Promise.resolve();
  connection.dispose();
  controller.select("other");
  resolve({ items: [update(4)] });
  await leaving;
  expect(unsubscribed).toBe(true);
  expect(controller.getSnapshot().rows).toHaveLength(0);
});

test("repeated call IDs in different turns do not share output and stale history cannot replace live previews", () => {
  const controller = new ConversationDisplayController();
  controller.select("s");
  controller.receiveActivity({ session_id: "s", active: { ...turn(), state: "running", settled_at: 0 }, latest: turn("other"), queued: [] });
  controller.receiveExecUpdate(update(9));
  const tool = (turnId: string) => controller.getSnapshot().rows.find(row => row.kind === "tool" && row.turnId === turnId)?.liveTool;
  expect(tool("turn")?.result_block?.content).toBe("output-9");
  expect(tool("other")?.result_block?.content).toBe("output-0");
  controller.receiveExecUpdate({ ...update(12), task: { ...update(12).task, session_id: "other-session" } });
  controller.receiveHistory({ session: { session_id: "s" }, messages: [], messages_page: {} } as unknown as SessionDetailPayload, "latest");
  expect(tool("turn")?.result_block?.content).toBe("output-9");
});
const turn = (id = "turn"): DesktopConversationTurnPayload => ({
  turn_id: id, message_id: id, text: "run", state: "completed", started_at: 1, user_persisted_at: 0, settled_at: 2,
  stream: { seq: 1, state: "final", content: "done", thinking: "", redacted_thinking_count: 0, thinking_elapsed_ms: 0,
    tool_pending: false, tool_elapsed_ms: 0, tool_steps: [update(0).step],
    process_parts: [{ type: "tool", part_id: "call", sequence: 1, tool_step: update(0).step }], display_metrics: {} } as DesktopConversationTurnPayload["stream"],
});

test("updates the original row after turn completion and ignores stale streams, snapshots and late running events", () => {
  const controller = new ConversationDisplayController();
  controller.select("s");
  controller.receiveExecUpdate(update(1)); // Output may beat the tool-start frame.
  controller.receiveActivity({ session_id: "s", active: null, queued: [], latest: turn() });
  const rows = () => controller.getSnapshot().rows.filter(row => row.kind === "tool" && row.turnId === "turn");
  expect(rows()).toHaveLength(1);
  const id = rows()[0]!.id;
  expect(rows()[0]?.liveTool?.result_block?.content).toBe("output-1");
  controller.receiveHistory({ session: { session_id: "s" }, messages: [
    { role: "user", content: "run", display_id: "user", display_group_id: "g", message_id: "turn",
      turn: { turn_id: "turn", status: "completed" } },
  ], messages_page: { group_cursors: ["g"], newest_cursor: "g", oldest_cursor: "g", fetched_at: 1 } } as SessionDetailPayload, "latest");
  controller.receiveActivity({ session_id: "s", active: null, queued: [], latest: turn("next-turn") });
  controller.receiveExecUpdate(update(3));
  controller.receiveExecUpdate(update(2));
  expect(rows()[0]?.liveTool?.result_block?.content).toBe("output-3");
  controller.receiveExecUpdate(update(4, "failed"));
  controller.receiveExecUpdate(update(5));
  controller.receiveActivity({ session_id: "s", active: null, queued: [], latest: turn() });
  expect(rows()).toHaveLength(1);
  expect(rows()[0]?.id).toBe(id);
  expect(rows()[0]?.liveTool?.error_block?.content).toBe("output-4");
  controller.select("other");
  controller.receiveExecUpdate(update(6));
  expect(controller.getSnapshot().rows).toHaveLength(0);
  controller.select("s");
  controller.receiveActivity({ session_id: "s", active: null, queued: [], latest: turn() });
  expect(rows()[0]?.liveTool?.result_block?.content).toBe("output-0");
});

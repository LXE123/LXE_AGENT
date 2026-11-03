import { expect, test } from "bun:test";
import { assistantMood, withAssistantIdentity } from "../../../src/features/sessions/assistant-identity-model";
import { conversationRows } from "../../../src/features/sessions/presentation";
import { processHeaders, reconcileProcesses, visibleProcessRows } from "../../../src/features/sessions/process";
import type { SessionMessage } from "../../../src/api/payloads";

const history = (status = "completed") => [
  { role: "user", display_id: "u", content: "Question" },
  { role: "assistant", id: "a", content: [{ type: "thinking", thinking: "Working" }, { type: "text", text: "Answer" }] },
].map(message => ({ ...message, display_group_id: "group", created_at: 1, turn: { turn_id: "t", status } })) as SessionMessage[];

test("one identity survives process expansion without replacing transcript rows", () => {
  const rows = conversationRows(history(), [], []);
  const headers = processHeaders(rows), states = reconcileProcesses(new Map(), headers);
  const collapsed = withAssistantIdentity(visibleProcessRows(rows, headers, states));
  states.set("process:t", { status: "completed", expanded: true });
  const expanded = withAssistantIdentity(visibleProcessRows(rows, headers, states));
  expect(collapsed.filter(row => row.kind === "assistant_identity")).toHaveLength(1);
  expect(expanded.filter(row => row.kind === "assistant_identity")).toEqual(collapsed.filter(row => row.kind === "assistant_identity"));
  expect(expanded.filter(row => row.kind !== "assistant_identity")).toEqual(visibleProcessRows(rows, headers, states));
  expect(collapsed[0]!.message!.role).toBe("user");
});

test("final-only replies still get an identity and waiting questions override only their own turn", () => {
  const messages = [...history(), ...history().map(message => ({ ...message, display_group_id: "next", display_id: "u2", id: "a2", turn: { turn_id: "next", status: "completed" } }))]
    .map(message => message.role === "assistant" ? { ...message, content: "Answer" } : message) as SessionMessage[];
  const rows = conversationRows(messages, [], []);
  const decorated = withAssistantIdentity(rows, "t");
  expect(decorated.filter(row => row.kind === "assistant_identity").map(row => [row.turnId, row.status])).toEqual([["t", "waiting_input"], ["next", "completed"]]);
  expect(withAssistantIdentity(rows).filter(row => row.kind === "assistant_identity").map(row => row.status)).toEqual(["completed", "completed"]);
});

test("failed, stopped and unknown states never use the completion portrait", () => {
  expect(assistantMood("completed")).toBe("completed");
  for (const status of ["running", "streaming", "stopping"]) expect(assistantMood(status)).toBe("thinking");
  for (const status of ["error", "cancelled", "queued", "waiting_input", undefined]) expect(assistantMood(status)).toBe("waiting");
});

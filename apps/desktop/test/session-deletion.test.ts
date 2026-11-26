import { expect, test } from "bun:test";
import { runSessionDeletion, type SessionDeletionSteps } from "../src/main/gateway/session-deletion";

/** A deletion whose steps record what happened; `fail` names the step that throws. */
function deletion(fail: Partial<Record<"bindings" | "agent" | "pause" | "forget", Error>> = {}) {
  const events: string[] = [];
  const logged: Array<[string, string]> = [];
  const steps: SessionDeletionSteps<{ deleted: true }> = {
    detach: async onUndo => {
      events.push("detach gateway record");
      onUndo(() => events.push("restore gateway record"));
      if (fail.bindings) throw fail.bindings;
      events.push("remove bindings");
      onUndo(() => events.push("restore bindings"));
    },
    deleteAgentSession: async () => {
      if (fail.agent) throw fail.agent;
      events.push("delete agent session");
      return { deleted: true };
    },
    cleanup: [
      ["pause_failed", () => { if (fail.pause) throw fail.pause; events.push("pause automations"); }],
      ["forget_failed", () => { if (fail.forget) throw fail.forget; events.push("forget conversation"); }],
    ],
    afterCommit: async () => { events.push("collect pasted text"); },
    logFailure: (event, error) => logged.push([event, String(error)]),
  };
  return { run: () => runSessionDeletion(steps), events, logged };
}

test("a completed deletion runs every step once and in order", async () => {
  const { run, events, logged } = deletion();
  expect(await run()).toEqual({ deleted: true });
  expect(events).toEqual(["detach gateway record", "remove bindings", "delete agent session",
    "pause automations", "forget conversation", "collect pasted text"]);
  expect(logged).toEqual([]);
});

test("a cleanup failure after the Agent session is deleted is logged, not rolled back", async () => {
  const { run, events, logged } = deletion({ pause: new Error("automation version conflict"), forget: new Error("disk full") });
  expect(await run()).toEqual({ deleted: true });
  expect(events).toEqual(["detach gateway record", "remove bindings", "delete agent session", "collect pasted text"]);
  expect(events).not.toContain("restore gateway record");
  expect(events).not.toContain("restore bindings");
  expect(logged).toEqual([["pause_failed", "Error: automation version conflict"], ["forget_failed", "Error: disk full"]]);
});

test("a failed Agent deletion restores the Gateway record and bindings, newest first", async () => {
  const { run, events } = deletion({ agent: new Error("agentcli refused: session is busy") });
  await expect(run()).rejects.toThrow("agentcli refused: session is busy");
  expect(events).toEqual(["detach gateway record", "remove bindings", "restore bindings", "restore gateway record"]);
});

test("a failure part way through detaching undoes only the steps already done", async () => {
  const { run, events } = deletion({ bindings: new Error("bindings file is read-only") });
  await expect(run()).rejects.toThrow("bindings file is read-only");
  expect(events).toEqual(["detach gateway record", "restore gateway record"]);
});

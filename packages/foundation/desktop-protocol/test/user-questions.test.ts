import { expect, test } from "bun:test";
import { parseDashboardRpcCall, parseAgentCall, decodeAgentEvent, encodeAgentEvent } from "../src";

test("question reads, answers and change notifications cross the shared IPC/JSON-RPC contract", () => {
  const calls = [
    { operation: "sessions.questions" as const, input: {} },
    { operation: "sessions.answer" as const, input: { session_id: "s", request_id: "request", answers: [{ id: "q", selected: ["a"] }] } },
  ];
  for (const call of calls) {
    expect(parseDashboardRpcCall(call)).toEqual(call);
    expect(parseAgentCall({ jsonrpc: "2.0", id: "q", method: "dashboard_call", params: call })).toMatchObject({ params: call });
  }
  const event = { type: "session.changed" as const, thread_id: "s", payload: { changes: ["questions" as const] } };
  expect(decodeAgentEvent(encodeAgentEvent(event))).toEqual(event);
});

test("malformed answer payloads are rejected at the boundary", () => {
  for (const input of [
    {}, { session_id: "s", request_id: "r", answers: [] },
    { session_id: "s", request_id: "r", answers: [{ id: "q", selected: "a" }] },
    { session_id: "s", request_id: "r", answers: [{ id: "q", selected: [], custom: " " }] },
    { session_id: "s", request_id: "r", answers: [{ id: "q", selected: [] }], run_id: "other" },
  ]) expect(() => parseDashboardRpcCall({ operation: "sessions.answer", input })).toThrow();
});

test("question stop can bind the existing cancellation route to its turn", () => {
  const call = { operation: "sessions.stop" as const, input: { session_id: "s", turn_id: "t" } };
  expect(parseDashboardRpcCall(call)).toEqual(call);
  expect(() => parseDashboardRpcCall({ ...call, input: { ...call.input, turn_id: " " } })).toThrow();
});

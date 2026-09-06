import { expect, test } from "bun:test";
import { desktopStreamBatchValidationError } from "../src/index";
import stream from "../fixtures/valid-emit-request.json";

const batch = (mutations: unknown[]) => ({
  session_id: "s", turn_id: "t", response_route_id: "r", emit_id: "e", seq: 1, mutations,
});
test("stream metadata errors never report a missing part", () => {
  const error = desktopStreamBatchValidationError(batch([{
    kind: "stream_updated", state: "delta", display_metrics: { ...stream.display_metrics, context_source: "unknown" },
  }]));
  expect(error).toContain("/mutations/0/display_metrics/context_source");
  expect(error).not.toContain("part");
  expect(error).toContain("allowed values");
});
test("nested text errors select the text branch, preserving real required and extra property paths", () => {
  const error = desktopStreamBatchValidationError(batch([{
    kind: "part_updated", part: { type: "text", part_id: "p", sequence: 1, status: "completed", text: "hello", unexpected: true },
  }]));
  expect(error).toContain("/mutations/0/part/presentation");
  expect(error).toContain("/mutations/0/part/unexpected");
  expect(error).not.toContain("redacted_count");
  expect(error).not.toContain("tool_step");
});
test("unknown discriminants and nonobject items report their actual location", () => {
  expect(desktopStreamBatchValidationError(batch([{ kind: "unknown" }]))).toContain("/mutations/0/kind");
  expect(desktopStreamBatchValidationError(batch([{ kind: "part_updated", part: { type: "unknown" } }]))).toContain("/mutations/0/part/type");
  expect(desktopStreamBatchValidationError(batch([null]))).toContain("/mutations/0: must be object");
  expect(desktopStreamBatchValidationError(batch([]))).toContain("/mutations: must NOT have fewer than 1 items");
});
test("valid siblings do not hide invalid siblings or outer batch errors", () => {
  const value = batch([
    { kind: "part_delta", part_id: "p", field: "text", delta: "x" },
    { kind: "part_delta", part_id: "p", field: "text", delta: "" },
  ]);
  expect(desktopStreamBatchValidationError({ ...value, seq: 0 })).toContain("/seq");
  expect(desktopStreamBatchValidationError(value)).toContain("/mutations/1/delta");
  expect(desktopStreamBatchValidationError(value)).not.toContain("/mutations/0");
  expect(desktopStreamBatchValidationError(batch([value.mutations[0]]))).toBe("");
});

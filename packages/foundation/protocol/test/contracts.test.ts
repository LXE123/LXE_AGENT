import { describe, expect, test } from "bun:test";

import invalidAgentJobShape from "../fixtures/invalid-agent-job-shape.json";
import validAgentJob from "../fixtures/valid-agent-job.json";
import validEmitRequest from "../fixtures/valid-emit-request.json";
import validInboundEvent from "../fixtures/valid-inbound-event.json";

async function loadProtocol() {
  return import("../src/index");
}

describe("protocol contracts", () => {
  test("accepts every valid cross-language fixture", async () => {
    const {
      validateAgentJob,
      validateEmitRequest,
      validateInboundEvent,
    } = await loadProtocol();

    expect(validateInboundEvent(validInboundEvent)).toBe(true);
    expect(validateAgentJob(validAgentJob)).toBe(true);
    const retiredField = ["server", "scope"].join("_");
    expect(validateAgentJob({
      ...validAgentJob,
      workspace: { ...validAgentJob.workspace, [retiredField]: "local" },
    })).toBe(false);
    expect(validateEmitRequest(validEmitRequest)).toBe(true);
    expect(validateEmitRequest({ ...validEmitRequest, turn_id: "" })).toBe(false);
  });

  test("rejects a payload with the wrong field shape", async () => {
    const { validateAgentJob } = await loadProtocol();

    expect(validateAgentJob(invalidAgentJobShape)).toBe(false);
  });

  test("enforces the final-answer stream discriminant", async () => {
    const { validateEmitRequest } = await loadProtocol();
    const stream = {
      ...validEmitRequest,
      emit_kind: "stream",
      stream_type: "final_answer",
      state: "delta",
      seq: 1,
    };
    expect(validateEmitRequest(stream)).toBe(true);
    expect(validateEmitRequest({ ...stream, stream_type: "content_block_delta" })).toBe(false);
    expect(validateEmitRequest({ ...stream, state: "running" })).toBe(false);
    expect(validateEmitRequest({ ...stream, seq: 0 })).toBe(false);

    const { display_metrics: _displayMetrics, ...base } = stream;
    const final = { ...base, emit_kind: "final", stream_type: "", state: "", seq: 0 };
    expect(validateEmitRequest(final)).toBe(true);
    expect(validateEmitRequest({ ...final, display_metrics: validEmitRequest.display_metrics })).toBe(false);
    expect(validateEmitRequest({ ...final, stream_type: "final_answer", state: "final", seq: 1 })).toBe(false);
  });

  test("allows an empty heartbeat message id but keeps normal turns strict", async () => {
    const { validateAgentJob } = await loadProtocol();
    const heartbeat = {
      ...validAgentJob,
      job_id: "heartbeat-1",
      job_kind: "heartbeat",
      message_id: "",
      user_input: "",
    };
    expect(validateAgentJob(heartbeat)).toBe(true);
    expect(validateAgentJob({ ...heartbeat, job_kind: "turn" })).toBe(false);
  });
});

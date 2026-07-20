import { describe, expect, test } from "bun:test";

import invalidAgentJobShape from "../fixtures/invalid-agent-job-shape.json";
import validAgentJob from "../fixtures/valid-agent-job.json";
import validEmitRequest from "../fixtures/valid-emit-request.json";
async function loadProtocol() {
  return import("../src/index");
}

describe("protocol contracts", () => {
  test("accepts every valid cross-language fixture", async () => {
    const { validateAgentJob, validateEmitRequest } = await loadProtocol();

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

  test("strictly validates operation diagnostics", async () => {
    const { validateAgentJob } = await loadProtocol();
    const diagnostic = {
      type: "operation_failure",
      provider: "feishu",
      operation: "quote_lookup",
      stage: "lookup",
      error_name: "FeishuApiHttpError",
      observed_error: "Feishu API GET failed: HTTP 400",
      redacted: false,
      truncated: false,
      cause_known: false,
      http_status: 400,
    };
    expect(validateAgentJob({ ...validAgentJob, diagnostics: [diagnostic] })).toBe(true);
    expect(validateAgentJob({ ...validAgentJob, diagnostics: [{ ...diagnostic, unexpected: true }] })).toBe(false);
    expect(validateAgentJob({ ...validAgentJob, diagnostics: [{ ...diagnostic, observed_error: "x".repeat(4_001) }] })).toBe(false);
    expect(validateAgentJob({ ...validAgentJob, diagnostics: Array.from({ length: 17 }, () => diagnostic) })).toBe(false);
    expect(validateAgentJob({
      ...validAgentJob,
      diagnostics: [{ ...diagnostic, provider_code: Number.MAX_SAFE_INTEGER + 1 }],
    })).toBe(false);
    expect(validateAgentJob({ ...validAgentJob, diagnostics: [{ ...diagnostic, cause_known: true }] })).toBe(false);
    expect(validateAgentJob({
      ...validAgentJob,
      diagnostics: [{ ...diagnostic, cause_known: true, verified_reason: "fixed_provider_code" }],
    })).toBe(true);
    expect(validateAgentJob({
      ...validAgentJob,
      diagnostics: [{ ...diagnostic, verified_reason: "not_allowed_without_known_cause" }],
    })).toBe(false);
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

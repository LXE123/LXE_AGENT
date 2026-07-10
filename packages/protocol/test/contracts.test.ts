import { describe, expect, test } from "bun:test";

import invalidAgentJobShape from "../fixtures/invalid-agent-job-shape.json";
import invalidWorkerEnvelopeVersion from "../fixtures/invalid-worker-envelope-version.json";
import validAgentJob from "../fixtures/valid-agent-job.json";
import validEmitRequest from "../fixtures/valid-emit-request.json";
import validInboundEvent from "../fixtures/valid-inbound-event.json";
import validWorkerEnvelope from "../fixtures/valid-worker-envelope.json";

async function loadProtocol() {
  return import("../src/index");
}

describe("protocol contracts", () => {
  test("accepts every valid cross-language fixture", async () => {
    const {
      validateAgentJob,
      validateEmitRequest,
      validateInboundEvent,
      validateWorkerEnvelope,
    } = await loadProtocol();

    expect(validateInboundEvent(validInboundEvent)).toBe(true);
    expect(validateAgentJob(validAgentJob)).toBe(true);
    expect(validateEmitRequest(validEmitRequest)).toBe(true);
    expect(validateWorkerEnvelope(validWorkerEnvelope)).toBe(true);
  });

  test("rejects a worker envelope with a different protocol version", async () => {
    const { validateWorkerEnvelope } = await loadProtocol();

    expect(validateWorkerEnvelope(invalidWorkerEnvelopeVersion)).toBe(false);
  });

  test("rejects a payload with the wrong field shape", async () => {
    const { validateAgentJob } = await loadProtocol();

    expect(validateAgentJob(invalidAgentJobShape)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { withoutRetiredAgentTraceEnvironment } from "../src/main/runtime-environment-policy";

describe("desktop runtime environment policy", () => {
  test("removes retired agent trace variables without changing unrelated settings", () => {
    const source = {
      AGENT_STREAM_TRACE_ENABLED: "1",
      AGENT_STREAM_TRACE_DIR: "/tmp/legacy-agent-traces",
      AGENT_SSE_WIRE_TRACE_ENABLED: "1",
      KEEP: "value",
    };

    expect(withoutRetiredAgentTraceEnvironment(source)).toEqual({
      AGENT_SSE_WIRE_TRACE_ENABLED: "1",
      KEEP: "value",
    });
    expect(source.AGENT_STREAM_TRACE_ENABLED).toBe("1");
  });
});

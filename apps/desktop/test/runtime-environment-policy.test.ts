import { describe, expect, test } from "bun:test";
import {
  withoutRetiredAgentTraceEnvironment,
  withoutRetiredShangmanEnvironment,
} from "../src/main/runtime-environment-policy";

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

  test("removes retired Shangman credentials while preserving the persisted-auth contract", () => {
    const source = {
      LXE_SHANGMAN_PASSWORD: "old-password",
      LXE_SHANGMAN_BASIC_USERNAME: "old-user",
      LXE_SHANGMAN_BASIC_PASSWORD: "old-basic-password",
      LXE_SHANGMAN_PROCESSED_PASSWORD: "processed-password",
      LXE_SHANGMAN_BASIC_AUTH: "Basic ZHVtbXk6cGFzcw==",
      LXE_SHANGMAN_PROD_ENABLED: "false",
    };
    expect(withoutRetiredShangmanEnvironment(source)).toEqual({
      LXE_SHANGMAN_PROCESSED_PASSWORD: "processed-password",
      LXE_SHANGMAN_PROD_ENABLED: "false",
    });
    expect(source.LXE_SHANGMAN_PASSWORD).toBe("old-password");
  });
});

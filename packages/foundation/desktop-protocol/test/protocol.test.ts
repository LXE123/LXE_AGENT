import { describe, expect, test } from "bun:test";
import {
  AGENT_PROTOCOL_VERSION,
  isAgentResponse,
  parseAgentWireMessage,
} from "../src";

describe("desktop agent protocol", () => {
  test("parses a valid response envelope", () => {
    const message = parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "request-1",
      ok: true,
      result: { ready: true },
    }));
    expect(isAgentResponse(message)).toBe(true);
  });

  test("rejects unsupported versions", () => {
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: 2,
      id: "request-1",
      ok: true,
      result: null,
    }))).toThrow("unsupported agent protocol version");
  });

  test("rejects non-object payloads", () => {
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "request-1",
      command: "health",
      payload: null,
    }))).toThrow("payload must be an object");
  });

  test("accepts only directory and worktree in workspace payloads", () => {
    const request = {
      version: AGENT_PROTOCOL_VERSION,
      id: "request-workspace",
      command: "initialize",
      payload: {
        resource_root: "/runtime/resources",
        data_root: "/runtime/data",
        legacy_workspace: { directory: "/workspace/project", worktree: "/workspace" },
      },
    };
    expect(parseAgentWireMessage(JSON.stringify(request))).toMatchObject(request);

    const retiredField = ["server", "scope"].join("_");
    expect(() => parseAgentWireMessage(JSON.stringify({
      ...request,
      payload: {
        ...request.payload,
        legacy_workspace: { ...request.payload.legacy_workspace, [retiredField]: "local" },
      },
    }))).toThrow("unsupported fields");
    expect(() => parseAgentWireMessage(JSON.stringify({
      ...request,
      payload: { ...request.payload, legacy_workspace: { directory: "/workspace" } },
    }))).toThrow("worktree must be a non-empty string");
  });

  test("rejects unknown commands and incomplete command payloads", () => {
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "request-1",
      command: "run_everything",
      payload: {},
    }))).toThrow("unsupported agent protocol command");
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "request-2",
      command: "cancel_turn",
      payload: {},
    }))).toThrow("cancel_turn.run_id");
  });
});

import { describe, expect, test } from "bun:test";
import {
  AGENT_PROTOCOL_VERSION,
  isAgentResponse,
  parseAgentWireMessage,
  parseDashboardRpcCall,
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
      version: AGENT_PROTOCOL_VERSION + 1,
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

  test("normalizes typed Dashboard RPC inputs", () => {
    expect(parseDashboardRpcCall({
      operation: "sessions.list",
      input: { query: "  order  ", limit: 999, offset: -5 },
    })).toEqual({
      operation: "sessions.list",
      input: { query: "order", limit: 200, offset: 0 },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.detail",
      input: { session_id: "session-1", message_page: 2 },
    })).toEqual({
      operation: "sessions.detail",
      input: { session_id: "session-1", message_limit: 10, message_page: 2 },
    });
  });

  test("rejects malformed and agent-local Dashboard RPC calls", () => {
    expect(() => parseDashboardRpcCall({
      operation: "models.update",
      input: { provider: "kimi_coding", enabled: true },
    })).toThrow("unsupported fields");
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "request-dashboard",
      command: "dashboard_call",
      payload: { operation: "channels.health", input: {} },
    }))).toThrow("owned by Electron Main");
    expect(() => parseDashboardRpcCall({
      operation: "sessions.search",
      input: {},
    })).toThrow("unsupported Dashboard RPC operation");
    expect(() => parseDashboardRpcCall({
      operation: "models.update",
      input: { provider: "x".repeat(1_000_001) },
    })).toThrow("too large");
    expect(() => parseDashboardRpcCall({
      operation: "models.update",
      input: { provider: "界".repeat(400_000) },
    })).toThrow("too large");
  });
});

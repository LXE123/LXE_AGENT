import { describe, expect, test } from "bun:test";
import type { DesktopStreamBatchRequest } from "@lxe/protocol";
import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolError,
  isAgentResponse,
  parseAgentRunTurnResult,
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
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: 4,
      id: "request-v4",
      ok: true,
      result: null,
    }))).toThrow("unsupported agent protocol version: 4");
  });

  test("strictly parses session change events", () => {
    expect(parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      type: "session.changed",
      thread_id: "session-1",
      payload: { changes: ["messages", "usage", "artifacts", "messages"] },
    }))).toEqual({
      version: AGENT_PROTOCOL_VERSION,
      type: "session.changed",
      thread_id: "session-1",
      payload: { changes: ["messages", "usage", "artifacts"] },
    });

    for (const payload of [
      { changes: [] },
      { changes: ["metadata"] },
      { changes: ["messages"], message: { role: "user", content: "must not cross the boundary" } },
    ]) {
      expect(() => parseAgentWireMessage(JSON.stringify({
        version: AGENT_PROTOCOL_VERSION,
        type: "session.changed",
        thread_id: "session-1",
        payload,
      }))).toThrow("session.changed");
    }
  });

  test("strictly parses desktop stream batches and matching envelopes", () => {
    const payload: DesktopStreamBatchRequest = {
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
      seq: 1,
      mutations: [{
        kind: "stream_updated",
        state: "delta",
        display_metrics: {
          status: "running",
          phase: "waiting_model",
          elapsed_ms: 10,
          model: "model",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          context_tokens: 0,
          context_window_tokens: 100,
        },
      }],
    };
    const event = {
      version: AGENT_PROTOCOL_VERSION,
      type: "conversation.stream.delta",
      thread_id: "session-1",
      turn_id: "turn-1",
      payload,
    } as const;
    expect(parseAgentWireMessage(JSON.stringify(event))).toEqual(event);
    expect(() => parseAgentWireMessage(JSON.stringify({ ...event, turn_id: "turn-other" })))
      .toThrow("envelope does not match");
    expect(() => parseAgentWireMessage(JSON.stringify({ ...event, payload: { ...payload, seq: 0 } })))
      .toThrow("payload is invalid");
  });

  test("strictly parses run_turn results", () => {
    expect(parseAgentRunTurnResult({
      status: "completed",
      reply: "done",
      input_tokens: 1,
      output_tokens: 2,
      tool_calls: 3,
      remaining_steering: [
        { text: "  follow up  ", response_route_id: " route-2 ", message_id: " m-2 " },
      ],
    })).toEqual({
      status: "completed",
      reply: "done",
      input_tokens: 1,
      output_tokens: 2,
      tool_calls: 3,
      remaining_steering: [
        { text: "follow up", response_route_id: "route-2", message_id: "m-2" },
      ],
    });
  });

  test("rejects incomplete or malformed run_turn results", () => {
    const valid = {
      status: "completed",
      reply: "done",
      input_tokens: 1,
      output_tokens: 2,
      tool_calls: 3,
      remaining_steering: [],
    };
    expect(() => parseAgentRunTurnResult({ ...valid, remaining_steering: undefined }))
      .toThrow(AgentProtocolError);
    expect(() => parseAgentRunTurnResult({ ...valid, remaining_steering: {} }))
      .toThrow("remaining_steering must be an array");
    expect(() => parseAgentRunTurnResult({ ...valid, remaining_steering: [{ text: " " }] }))
      .toThrow("text must be a non-empty string");
    expect(() => parseAgentRunTurnResult({
      ...valid,
      remaining_steering: [{ text: "follow up", response_route_id: 1 }],
    })).toThrow("response_route_id must be a string");
    for (const counter of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(() => parseAgentRunTurnResult({ ...valid, input_tokens: counter }))
        .toThrow("input_tokens must be a non-negative safe integer");
    }
  });

  test("rejects non-object payloads", () => {
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "request-1",
      command: "shutdown",
      payload: null,
    }))).toThrow("payload must be an object");
  });

  test("strictly validates hot Skill permission updates", () => {
    const request = {
      version: AGENT_PROTOCOL_VERSION,
      id: "permission-1",
      command: "update_skill_permissions",
      payload: { allowed_skill_types: ["amazon_fba", "default"] as string[] },
    } as const;
    expect(parseAgentWireMessage(JSON.stringify(request))).toEqual(request);
    for (const allowedSkillTypes of ["*", ["default", 1], null]) {
      expect(() => parseAgentWireMessage(JSON.stringify({
        ...request,
        payload: { allowed_skill_types: allowedSkillTypes },
      }))).toThrow("must be a string array");
    }
  });

  test("accepts only directory and worktree in workspace payloads", () => {
    const request = {
      version: AGENT_PROTOCOL_VERSION,
      id: "request-workspace",
      command: "initialize",
      payload: {
        agent_soul_path: "/runtime/resources/agent/SOUL.md",
        skills_root: "/runtime/resources/skills",
        user_skills_root: "/home/tester/.agents/skills",
        lxeskill_catalog_path: "/runtime/resources/lxeskill/catalog.json",
        llm_config_root: "/runtime/resources/config/llm",
        permission_policy_path: "/runtime/resources/config/permission_policy.yaml",
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
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "request-3",
      command: "resolve_artifact",
      payload: { session_id: "session-1" },
    }))).toThrow("resolve_artifact.artifact_id");
    expect(() => parseAgentWireMessage(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "request-4",
      command: "resolve_attachment",
      payload: { session_id: "session-1" },
    }))).toThrow("resolve_attachment.attachment_id");
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
      input: { session_id: "session-1", message_before: " cursor-2 " },
    })).toEqual({
      operation: "sessions.detail",
      input: { session_id: "session-1", message_limit: 10, message_before: "cursor-2" },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.send",
      input: { session_id: " session-1 ", text: "  hello  " },
    })).toEqual({
      operation: "sessions.send",
      input: { session_id: "session-1", text: "hello" },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.send",
      input: { text: " first message " },
    })).toEqual({ operation: "sessions.send", input: { text: "first message" } });
    expect(parseDashboardRpcCall({
      operation: "sessions.send",
      input: { text: "", attachment_ids: [" file-1 "] },
    })).toEqual({ operation: "sessions.send", input: { text: "", attachment_ids: ["file-1"] } });
    expect(parseDashboardRpcCall({
      operation: "sessions.file.open",
      input: { session_id: " session-1 ", artifact_id: " artifact-1 " },
    })).toEqual({
      operation: "sessions.file.open",
      input: { session_id: "session-1", artifact_id: "artifact-1" },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.attachment.open",
      input: { session_id: " session-1 ", attachment_id: " attachment-1 " },
    })).toEqual({
      operation: "sessions.attachment.open",
      input: { session_id: "session-1", attachment_id: "attachment-1" },
    });
    expect(parseDashboardRpcCall({
      operation: "sessions.pin",
      input: { session_id: " session-1 ", pinned: true },
    })).toEqual({ operation: "sessions.pin", input: { session_id: "session-1", pinned: true } });
    expect(parseDashboardRpcCall({
      operation: "sessions.delete",
      input: { session_id: " session-1 " },
    })).toEqual({ operation: "sessions.delete", input: { session_id: "session-1" } });
  });

  test("rejects malformed and agent-local Dashboard RPC calls", () => {
    expect(() => parseDashboardRpcCall({
      operation: "sessions.detail",
      input: { session_id: "session-1", message_page: 2 },
    })).toThrow("unsupported fields");
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
    const mainOwnedInput: Record<string, unknown> = {
      "sessions.send": { text: "hello" },
      "sessions.file.open": { session_id: "session-1", artifact_id: "artifact-1" },
      "sessions.file.reveal": { session_id: "session-1", artifact_id: "artifact-1" },
      "sessions.attachment.open": { session_id: "session-1", attachment_id: "attachment-1" },
    };
    for (const operation of [
      "sessions.send", "sessions.stop", "sessions.activity", "sessions.file.open",
      "sessions.file.reveal", "sessions.attachment.open",
    ]) {
      expect(() => parseAgentWireMessage(JSON.stringify({
        version: AGENT_PROTOCOL_VERSION,
        id: `request-${operation}`,
        command: "dashboard_call",
        payload: { operation, input: mainOwnedInput[operation] ?? { session_id: "session-1" } },
      }))).toThrow("owned by Electron Main");
    }
    expect(() => parseDashboardRpcCall({ operation: "sessions.file.open", input: { session_id: "s" } }))
      .toThrow("sessions.file.open.artifact_id must be a string");
    expect(() => parseDashboardRpcCall({ operation: "sessions.file.reveal", input: { session_id: "s" } }))
      .toThrow("sessions.file.reveal.artifact_id must be a string");
    expect(parseDashboardRpcCall({
      operation: "sessions.file.reveal",
      input: { session_id: "s", artifact_id: "a" },
    })).toEqual({ operation: "sessions.file.reveal", input: { session_id: "s", artifact_id: "a" } });
    expect(() => parseDashboardRpcCall({
      operation: "sessions.file.open",
      input: { session_id: "s", artifact_id: "artifact-1", reveal: true },
    })).toThrow("unsupported fields");
    expect(() => parseDashboardRpcCall({ operation: "sessions.send", input: { text: " " } }))
      .toThrow("requires text or an attachment");
    expect(() => parseDashboardRpcCall({
      operation: "sessions.send",
      input: { text: "", attachment_ids: ["same", "same"] },
    })).toThrow("duplicate IDs");
    expect(() => parseDashboardRpcCall({
      operation: "sessions.send",
      input: { text: "", attachment_ids: ["1", "2", "3", "4", "5", "6"] },
    })).toThrow("at most 5");
    expect(() => parseDashboardRpcCall({ operation: "sessions.send", input: { text: "x".repeat(8_193) } }))
      .toThrow("too long");
    expect(() => parseDashboardRpcCall({ operation: "sessions.stop", input: { session_id: "s", all: true } }))
      .toThrow("unsupported fields");
    expect(() => parseDashboardRpcCall({ operation: "sessions.pin", input: { session_id: "s", pinned: "yes" } }))
      .toThrow("sessions.pin.pinned must be a boolean");
    expect(() => parseDashboardRpcCall({ operation: "sessions.delete", input: { session_id: "s", force: true } }))
      .toThrow("unsupported fields");
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

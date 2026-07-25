import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lxe/core";
import {
  AGENT_PROTOCOL_VERSION,
  DashboardRpcError,
  type AgentEvent,
  type AgentResponse,
} from "@lxe/desktop-protocol";
import { AgentProtocolServer, type AgentProtocolServerOptions } from "../src/server";

type CreateHost = NonNullable<AgentProtocolServerOptions["createHost"]>;

const workspace = (root: string) => ({
  directory: root,
  worktree: root,
});

const initializePayload = (root: string) => ({
  agent_soul_path: join(root, "SOUL.md"),
  skills_root: join(root, "skills"),
  user_skills_root: join(root, "user-skills"),
  lxeskill_catalog_path: join(root, "python", "lxeskill_cli", "lxeskill", "catalog.json"),
  llm_config_root: join(root, "config", "llm"),
  permission_policy_path: join(root, "config", "permission_policy.yaml"),
  data_root: root,
  legacy_workspace: workspace(root),
});

const turnJob = (root: string) => ({
  job_id: "job-1",
  session_id: "session-1",
  session_key: "session-1",
  response_route_id: "route-1",
  user_id: "user-1",
  conversation_id: "conversation-1",
  is_group: false,
  message_id: "message-1",
  user_input: "hello",
  job_kind: "turn",
  sender_nick: "tester",
  source: {},
  raw_data: {},
  user_content_blocks: [],
  diagnostics: [],
  workspace: workspace(root),
});

const fakeHost: CreateHost = (() => ({
  start: async () => {
    createLogger("runtime.maintenance").info("data_sync_uploaded", {
      target: "cloud",
      api_key: "must-not-appear",
    });
  },
  stop: async () => undefined,
  health: () => ({ ready: true }),
  dashboardCall: async () => {
    throw new DashboardRpcError("not_found", "dashboard item not found");
  },
})) as unknown as CreateHost;

describe("AgentProtocolServer", () => {
  test("wraps persisted session changes in content-free protocol events", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    let notify: NonNullable<Parameters<CreateHost>[0]["onSessionChanged"]> | undefined;
    const createHost = ((options: Parameters<CreateHost>[0]) => {
      const callback = options.onSessionChanged;
      notify = callback;
      return {
        start: async () => undefined,
        stop: async () => undefined,
        health: () => ({ ready: true }),
      };
    }) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { output.push(message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "initialize-session-change",
      command: "initialize",
      payload: initializePayload(root),
    }));
    await notify?.("session-1", "messages");
    await notify?.("session-1", "usage");

    const changes = output.filter((message): message is Extract<AgentEvent, { type: "session.changed" }> =>
      "type" in message && message.type === "session.changed");
    expect(changes).toEqual([
      {
        version: AGENT_PROTOCOL_VERSION,
        type: "session.changed",
        thread_id: "session-1",
        payload: { changes: ["messages"] },
      },
      {
        version: AGENT_PROTOCOL_VERSION,
        type: "session.changed",
        thread_id: "session-1",
        payload: { changes: ["usage"] },
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain("content");
    await server.shutdown();
  });

  test("rejects commands before initialize", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({ write: (message) => { output.push(message); } });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "health-1",
      command: "ensure_session",
      payload: { request: { session_id: "session-1", source: {}, workspace: workspace(process.cwd()) } },
    }));
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ id: "health-1", ok: false });
  });

  test("rejects the removed pop_pending_events command", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({ write: (message) => { output.push(message); } });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "pop-1",
      command: "pop_pending_events",
      payload: { session_id: "session-1" },
    }));
    expect(output).toHaveLength(1);
    const response = output[0];
    expect(response && !("type" in response) && !response.ok).toBe(true);
    expect(response && !("type" in response) && !response.ok ? response.error.message : "")
      .toContain("unsupported agent protocol command");
  });

  test("run_turn returns steering the runtime never consumed", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const root = process.cwd();
    const createHost = (() => ({
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ ready: true }),
      runTurn: async (
        _job: unknown,
        handle: { pushSteering(message: { text: string; response_route_id: string; message_id: string }): void },
      ) => {
        handle.pushSteering({ text: "late steer", response_route_id: "route-s", message_id: "m-s" });
        return { status: "completed", reply: "ok", input_tokens: 1, output_tokens: 2, tool_calls: 3 };
      },
    })) as unknown as CreateHost;
    const server = new AgentProtocolServer({
      write: (message) => { output.push(message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "initialize-1",
      command: "initialize",
      payload: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "turn-1",
      command: "run_turn",
      payload: { job: turnJob(root) },
    }));

    const response = output.find((message): message is AgentResponse =>
      !("type" in message) && message.id === "turn-1");
    expect(response).toMatchObject({
      ok: true,
      result: {
        status: "completed",
        reply: "ok",
        input_tokens: 1,
        output_tokens: 2,
        tool_calls: 3,
        remaining_steering: [
          { text: "late steer", response_route_id: "route-s", message_id: "m-s" },
        ],
      },
    });
    await server.shutdown();
  });

  test("run_turn returns an empty steering array when every message was consumed", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const root = process.cwd();
    const createHost = (() => ({
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ ready: true }),
      runTurn: async () => ({
        status: "completed",
        reply: "ok",
        input_tokens: 1,
        output_tokens: 2,
        tool_calls: 0,
      }),
    })) as unknown as CreateHost;
    const server = new AgentProtocolServer({
      write: (message) => { output.push(message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "initialize-empty-steering",
      command: "initialize",
      payload: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "turn-empty-steering",
      command: "run_turn",
      payload: { job: turnJob(root) },
    }));

    expect(output.find((message) => !("type" in message) && message.id === "turn-empty-steering"))
      .toMatchObject({ ok: true, result: { remaining_steering: [] } });
    await server.shutdown();
  });

  test("rejects the removed health command", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({ write: (message) => { output.push(message); } });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "health-1",
      command: "health",
      payload: {},
    }));
    expect(output).toHaveLength(1);
    const response = output[0];
    expect(response && !("type" in response) && !response.ok).toBe(true);
    expect(response && !("type" in response) && !response.ok ? response.error.message : "")
      .toContain("unsupported agent protocol command");
  });

  test("propagates Dashboard RPC errors through the agent error envelope", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { output.push(message); },
      createHost: fakeHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "initialize-dashboard",
      command: "initialize",
      payload: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "dashboard-1",
      command: "dashboard_call",
      payload: { operation: "models.list", input: {} },
    }));
    expect(output.find((message) => !("type" in message) && message.id === "dashboard-1"))
      .toMatchObject({
        ok: false,
        error: { code: "not_found", message: "dashboard item not found" },
      });
    await server.shutdown();
  });

  test("rolls back a partially initialized host and remains uninitialized", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    let stops = 0;
    const createHost = (() => ({
      start: async () => { throw new Error("runtime start failed"); },
      stop: async () => { stops += 1; },
    })) as unknown as CreateHost;
    const root = process.cwd();
    const server = new AgentProtocolServer({
      write: (message) => { output.push(message); },
      createHost,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });

    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "initialize-failed",
      command: "initialize",
      payload: initializePayload(root),
    }));
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "command-after-failure",
      command: "ensure_session",
      payload: { request: { session_id: "session-1", source: {}, workspace: workspace(root) } },
    }));

    expect(stops).toBe(1);
    expect(output.find((message) => !("type" in message) && message.id === "initialize-failed"))
      .toMatchObject({ ok: false, error: { message: "runtime start failed" } });
    expect(output.find((message) => !("type" in message) && message.id === "command-after-failure"))
      .toMatchObject({ ok: false, error: { message: "agent-cli is not initialized" } });
    await server.shutdown();
  });

  test("writes the shutdown response before requesting process exit", async () => {
    const order: string[] = [];
    const server = new AgentProtocolServer({
      write: (message) => {
        order.push("type" in message ? message.type : `response:${message.id}`);
      },
      exit: () => { order.push("exit"); },
    });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "shutdown-1",
      command: "shutdown",
      payload: {},
    }));
    expect(order).toEqual(["system.status", "response:shutdown-1", "exit"]);
  });

  test("persists agent logs under the initialized data root and reports sink health", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-agent-cli-logging-"));
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "INFO",
      },
      write: (message) => { output.push(message); },
      createHost: fakeHost,
    });
    try {
      await server.accept(JSON.stringify({
        version: AGENT_PROTOCOL_VERSION,
        id: "initialize-1",
        command: "initialize",
        payload: initializePayload(root),
      }));

      const response = output.find((message): message is AgentResponse =>
        !("type" in message) && message.id === "initialize-1");
      expect(response).toMatchObject({
        ok: true,
        result: {
          logging: {
            local_file_enabled: true,
            disabled_reason: "",
            console_level: "error",
            file_level: "info",
          },
        },
      });
      const ready = output.find((message): message is AgentEvent =>
        "type" in message && message.type === "system.ready");
      expect(ready).toMatchObject({ payload: { logging: { local_file_enabled: true } } });
      const filePath = String(response?.ok
        && response.result !== null
        && typeof response.result === "object"
        && !Array.isArray(response.result)
        && response.result.logging !== null
        && typeof response.result.logging === "object"
        && !Array.isArray(response.result.logging)
        ? response.result.logging.file_path
        : "");
      expect(filePath).toMatch(/logs[\\/]runtime[\\/]\d{8}[\\/]runtime\.log$/u);
      expect(filePath).not.toMatch(/var[\\/]var[\\/]/u);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain('"message":"logging_configured"');
      expect(content).toContain('"message":"data_sync_uploaded"');
      expect(content).toContain('"target":"cloud"');
      expect(content).not.toContain("must-not-appear");

      await server.shutdown();
      const closedContent = readFileSync(filePath, "utf8");
      const consoleWrite = spyOn(console, "log").mockImplementation(() => undefined);
      try {
        createLogger("runtime.after_shutdown").info("must_not_be_persisted");
      } finally {
        consoleWrite.mockRestore();
      }
      expect(readFileSync(filePath, "utf8")).toBe(closedContent);
    } finally {
      await server.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

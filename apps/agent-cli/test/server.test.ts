import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lxe/core";
import { AGENT_PROTOCOL_VERSION, type AgentEvent, type AgentResponse } from "@lxe/desktop-protocol";
import { AgentProtocolServer, type AgentProtocolServerOptions } from "../src/server";

type CreateService = NonNullable<AgentProtocolServerOptions["createService"]>;

const workspace = (root: string) => ({
  directory: root,
  worktree: root,
});

const fakeService: CreateService = (() => ({
  start: async () => {
    createLogger("runtime.maintenance").info("data_sync_uploaded", {
      target: "cloud",
      api_key: "must-not-appear",
    });
  },
  stop: async () => undefined,
  health: () => ({ ready: true }),
})) as unknown as CreateService;

describe("AgentProtocolServer", () => {
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

  test("reports not-ready health without initialization", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({ write: (message) => { output.push(message); } });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "health-1",
      command: "health",
      payload: {},
    }));
    expect(output[0]).toEqual({
      version: AGENT_PROTOCOL_VERSION,
      id: "health-1",
      ok: true,
      result: { ready: false },
    });
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
        LOG_FILE: "",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "INFO",
      },
      write: (message) => { output.push(message); },
      createService: fakeService,
    });
    try {
      await server.accept(JSON.stringify({
        version: AGENT_PROTOCOL_VERSION,
        id: "initialize-1",
        command: "initialize",
        payload: {
          resource_root: root,
          data_root: root,
          legacy_workspace: workspace(root),
        },
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
      expect(filePath).toMatch(/var[\\/]logs[\\/]runtime[\\/]\d{8}[\\/]runtime\.log$/u);
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

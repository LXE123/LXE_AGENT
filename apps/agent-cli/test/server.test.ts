import { describe, expect, test } from "bun:test";
import { AGENT_PROTOCOL_VERSION, type AgentEvent, type AgentResponse } from "@lxe/desktop-protocol";
import { AgentProtocolServer } from "../src/server";

describe("AgentProtocolServer", () => {
  test("rejects commands before initialize", async () => {
    const output: Array<AgentResponse | AgentEvent> = [];
    const server = new AgentProtocolServer({ write: (message) => { output.push(message); } });
    await server.accept(JSON.stringify({
      version: AGENT_PROTOCOL_VERSION,
      id: "health-1",
      command: "ensure_session",
      payload: { request: { session_id: "session-1" } },
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
});

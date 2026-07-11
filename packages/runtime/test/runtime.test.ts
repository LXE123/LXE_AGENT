import { describe, expect, test } from "bun:test";
import type { AgentJob, EmitRequest, JsonObject } from "@lxe/protocol";
import { TypeScriptAgentRuntime } from "../src/runtime";
import { ToolRegistry } from "../src/tools";
import type { RuntimeHandle, RuntimeMessage, RuntimeStore, RuntimeTurnResponse } from "../src/types";

const job = (): AgentJob => ({
  job_id: "j1",
  session_id: "s1",
  session_key: "agent:main:feishu:dm:c1",
  response_route_id: "r1",
  user_id: "u1",
  conversation_id: "c1",
  is_group: false,
  message_id: "m1",
  user_input: "hello",
  job_kind: "turn",
  sender_nick: "Tester",
  source: { platform: "feishu", chat_id: "c1" },
  raw_data: {},
  user_content_blocks: [],
});

class MemoryStore implements RuntimeStore {
  messages: RuntimeMessage[] = [];
  metrics: JsonObject[] = [];
  statePatches: JsonObject[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getSession(): Promise<{ session_id: string; source: JsonObject }> {
    return { session_id: "s1", source: { platform: "feishu" } };
  }
  async loadMessages(): Promise<RuntimeMessage[]> { return structuredClone(this.messages); }
  async appendMessage(_sessionId: string, message: RuntimeMessage): Promise<void> { this.messages.push(message); }
  async patchSessionState(_sessionId: string, patch: JsonObject): Promise<void> { this.statePatches.push(patch); }
  async recordTurn(_sessionId: string, metrics: JsonObject): Promise<void> { this.metrics.push(metrics); }
}

const handle = (): RuntimeHandle => {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancelled: false,
    drainSteering: () => [],
    registerProcess: () => () => undefined,
  };
};

describe("TypeScriptAgentRuntime", () => {
  test("closes a tool call, persists canonical messages, and emits the final answer", async () => {
    const responses: RuntimeTurnResponse[] = [
      {
        content: [{ type: "tool_use", id: "tool-1", name: "echo", input: { text: "hi" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      {
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    ];
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo text",
      input_schema: { type: "object", properties: { text: { type: "string" } } },
      execute: async (input) => ({ content: [{ type: "text", text: String(input.text) }] }),
    });
    const emitted: EmitRequest[] = [];
    const services: string[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { turn: async (request) => {
        if (responses.length === 1) await request.onDelta?.({ text: "done" });
        return responses.shift()!;
      } },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      systemPrompt: "You are LXE.",
      services: [{
        start: async () => { services.push("start"); },
        stop: async () => { services.push("stop"); },
      }],
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "done" }));
    expect(store.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant",
    ]);
    expect(store.messages[2]?.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "tool-1" }),
    ]);
    expect(emitted.at(-1)).toEqual(expect.objectContaining({
      session_id: "s1",
      response_route_id: "r1",
      content: "done",
      emit_kind: "final",
    }));
    expect(emitted.some((request) => request.emit_kind === "stream" && request.content === "done")).toBe(true);
    await runtime.stop();
    expect(services).toEqual(["start", "stop"]);
  });

  test("persists tool state patches and emits returned files through the gateway", async () => {
    const responses: RuntimeTurnResponse[] = [
      {
        content: [{ type: "tool_use", id: "tool-1", name: "bridge", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "bridge",
      description: "bridge",
      input_schema: { type: "object" },
      execute: async () => ({
        content: [{ type: "text", text: "created" }],
        state_patch: { browser: { session_id: "remote-1" } },
        files: ["C:\\tmp\\report.xlsx"],
      }),
    });
    const emitted: EmitRequest[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { turn: async () => responses.shift()! },
      emitter: { emit: async (request) => { emitted.push(request); }, typing: async () => undefined },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());

    expect(store.statePatches).toEqual([{ browser: { session_id: "remote-1" } }]);
    expect(emitted).toContainEqual(expect.objectContaining({
      session_id: "s1",
      response_route_id: "r1",
      emit_kind: "tool",
      files: ["C:\\tmp\\report.xlsx"],
    }));
    await runtime.stop();
  });

  test("records exactly one error result when tool file delivery fails", async () => {
    let secondRequestMessages: RuntimeMessage[] = [];
    let providerCalls = 0;
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "report",
      description: "report",
      input_schema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "created" }], files: ["report.xlsx"] }),
    });
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { turn: async (request) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            content: [{ type: "tool_use", id: "tool-1", name: "report", input: {} }],
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        secondRequestMessages = request.messages;
        return {
          content: [{ type: "text", text: "delivery failed" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      } },
      emitter: {
        emit: async (request) => {
          if (request.emit_kind === "tool") throw new Error("upload failed");
        },
        typing: async () => undefined,
      },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());

    expect(secondRequestMessages.at(-1)?.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "tool-1", is_error: true }),
    ]);
    await runtime.stop();
  });
});

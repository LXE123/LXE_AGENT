import { describe, expect, test } from "bun:test";
import type { AgentJob, EmitRequest, JsonObject } from "@lxe/protocol";
import { TypeScriptAgentRuntime } from "../src/runtime";
import { RuntimeProviderError } from "../src/provider";
import { ToolRegistry } from "../src/tools";
import type {
  RuntimeHandle,
  RuntimeMessage,
  RuntimeProviderRequest,
  RuntimeStore,
  RuntimeTurnResponse,
} from "../src/types";

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
  pendingEvents: JsonObject[] = [];
  metrics: JsonObject[] = [];
  statePatches: JsonObject[] = [];
  replacements: RuntimeMessage[][] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getSession(): Promise<{ session_id: string; source: JsonObject }> {
    return { session_id: "s1", source: { platform: "feishu" } };
  }
  async popPendingEvents(): Promise<JsonObject[]> {
    return this.pendingEvents.splice(0);
  }
  async loadMessages(): Promise<RuntimeMessage[]> { return structuredClone(this.messages); }
  async appendMessage(_sessionId: string, message: RuntimeMessage): Promise<void> { this.messages.push(message); }
  async replaceMessages(_sessionId: string, messages: RuntimeMessage[]): Promise<void> {
    this.messages = structuredClone(messages);
    this.replacements.push(structuredClone(messages));
  }
  async patchSessionState(_sessionId: string, patch: JsonObject): Promise<void> { this.statePatches.push(patch); }
  async recordTurn(_sessionId: string, metrics: JsonObject): Promise<void> { this.metrics.push(metrics); }
}

const summarize = async () => ({
  text: "context summary",
  usage: { input_tokens: 0, output_tokens: 0 },
});

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
  test("records skill activation once and attributes every later lxeskill execution independently", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "read",
      description: "read skill",
      input_schema: { type: "object" },
      execute: async (_input, context) => {
        await context.exposureState?.activateSkill("replenishment-store-resolve");
        return { content: [{ type: "text", text: "skill loaded" }] };
      },
    });
    tools.register({
      name: "exec",
      description: "exec",
      input_schema: { type: "object" },
      classifyInvocation: () => ({
        usageName: "lxeskill:replenish store resolve",
        commandId: "replenish store resolve",
        ownerSkills: ["replenishment-store-resolve"],
      }),
      execute: async (input) => {
        if (input.fail === true) throw new Error("command failed");
        return { content: [{ type: "text", text: "done" }] };
      },
    });
    const responses: RuntimeTurnResponse[] = [
      { content: [
        { type: "tool_call", id: "read-1", name: "read", arguments: {} },
        { type: "tool_call", id: "read-2", name: "read", arguments: {} },
      ], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [{ type: "text", text: "complete" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [
        { type: "tool_call", id: "exec-1", name: "exec", arguments: { command: "lxeskill replenish store resolve --store-name Demo" } },
        { type: "tool_call", id: "exec-2", name: "exec", arguments: { command: "lxeskill replenish store resolve --store-name Demo", fail: true } },
      ], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [{ type: "text", text: "complete" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async () => responses.shift()! },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
      resolveSkillMetadata: (name) => name === "replenishment-store-resolve"
        ? { module: "amazon_replenish" }
        : undefined,
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());
    await runtime.runTurn({ ...job(), job_id: "j2", message_id: "m2" }, handle());
    await runtime.stop();

    expect(store.metrics[0]?.activations).toEqual([{
      skill: "replenishment-store-resolve",
      module: "amazon_replenish",
    }]);
    expect(store.metrics[0]?.executions).toEqual([]);
    expect(store.metrics[1]?.tools).toContainEqual(expect.objectContaining({
      name: "lxeskill:replenish store resolve",
      calls: 2,
      errors: 1,
    }));
    expect(store.metrics[1]?.activations).toEqual([]);
    expect(store.metrics[1]?.executions).toEqual([
      expect.objectContaining({
        skill: "replenishment-store-resolve",
        module: "amazon_replenish",
        command: "replenish store resolve",
        success: true,
      }),
      expect.objectContaining({
        skill: "replenishment-store-resolve",
        module: "amazon_replenish",
        command: "replenish store resolve",
        success: false,
      }),
    ]);
    expect(JSON.stringify(store.metrics[1]?.executions)).not.toContain("--store-name");
  });

  test("does not count static tool ownership as a skill execution", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "owned_tool",
      description: "owned without a stable command",
      input_schema: { type: "object" },
      ownerSkills: ["demo-skill"],
      execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const responses: RuntimeTurnResponse[] = [
      { content: [{ type: "tool_call", id: "tool-1", name: "owned_tool", arguments: {} }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [{ type: "text", text: "complete" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      toolExposure: { allowedSkills: new Set(["demo-skill"]) },
      provider: { summarize, turn: async () => responses.shift()! },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });

    await runtime.start();
    await runtime.runTurn(job(), handle());
    await runtime.stop();

    expect(store.metrics[0]?.executions).toEqual([]);
  });

  test("completes an empty heartbeat without loading history or calling the provider", async () => {
    const store = new MemoryStore();
    store.messages.push({ role: "user", content: "private history" });
    let calls = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async () => {
          calls += 1;
          throw new Error("provider must not be called");
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn({ ...job(), job_kind: "heartbeat", user_input: "" }, handle());
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "" }));
    expect(calls).toBe(0);
    expect(store.messages).toEqual([{ role: "user", content: "private history" }]);
  });

  test("reports heartbeat events without history or tools", async () => {
    const store = new MemoryStore();
    store.messages.push({ role: "user", content: "private history" });
    store.pendingEvents.push({
      event_id: "event-1",
      job_id: "background-1",
      created_at: 1_700_000_000,
      text: "refresh completed",
    });
    let captured: RuntimeProviderRequest | undefined;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: {
        summarize,
        turn: async (request) => {
          captured = request;
          return {
            content: [{ type: "text", text: "刷新已完成。" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 2 },
          };
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn({ ...job(), job_kind: "heartbeat", user_input: "" }, handle());
    expect(outcome.reply).toBe("刷新已完成。");
    expect(captured?.tools).toEqual([]);
    expect(captured?.toolChoice).toBe("none");
    expect(captured?.messages).toHaveLength(1);
    expect(JSON.stringify(captured?.messages)).not.toContain("private history");
    expect(store.pendingEvents).toEqual([]);
  });

  test("disables tools on the last step and ignores a violating tool call", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    let executed = false;
    tools.register({
      name: "danger",
      description: "must not execute",
      input_schema: { type: "object" },
      execute: async () => {
        executed = true;
        return { content: [{ type: "text", text: "bad" }] };
      },
    });
    const requests: Array<{ tools: unknown[]; toolChoice: string }> = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      maxSteps: 1,
      provider: {
        summarize,
        turn: async (request) => {
          requests.push({ tools: request.tools, toolChoice: request.toolChoice });
          return {
            content: [
              { type: "text", text: "Here is the available result." },
              { type: "tool_call", id: "late", name: "danger", arguments: {} },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(requests).toEqual([{ tools: [], toolChoice: "none" }]);
    expect(executed).toBe(false);
    expect(outcome.reply).toBe("Here is the available result.");
    expect(store.messages.at(-1)?.content).toEqual([{ type: "text", text: "Here is the available result." }]);
  });

  test("closes a tool call, persists canonical messages, and emits the final answer", async () => {
    const responses: RuntimeTurnResponse[] = [
      {
        content: [{ type: "tool_call", id: "tool-1", name: "echo", arguments: { text: "hi" } }],
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
      provider: { summarize, turn: async (request) => {
        if (responses.length === 1) await request.onEvent?.({ type: "text_delta", text: "done" });
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
      "user", "assistant", "tool", "assistant",
    ]);
    expect(store.messages[2]?.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_call_id: "tool-1" }),
    ]);
    const streamFrames = emitted.filter((request) => request.emit_kind === "stream");
    expect(streamFrames.at(-1)).toEqual(expect.objectContaining({
      session_id: "s1",
      response_route_id: "r1",
      content: "done",
      emit_kind: "stream",
      stream_type: "final_answer",
      state: "final",
      tool_steps: [expect.objectContaining({
        id: "tool-1",
        name: "echo",
        status: "success",
      })],
    }));
    expect(emitted.some((request) => request.emit_kind === "final")).toBe(false);
    expect(new Set(streamFrames.map((request) => request.emit_id)).size).toBe(1);
    expect(streamFrames.map((request) => request.seq)).toEqual(
      streamFrames.map((_, index) => index + 1),
    );
    await runtime.stop();
    expect(services).toEqual(["start", "stop"]);
  });

  test("persists tool state patches and emits returned files through the gateway", async () => {
    const responses: RuntimeTurnResponse[] = [
      {
        content: [{ type: "tool_call", id: "tool-1", name: "bridge", arguments: {} }],
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
      provider: { summarize, turn: async () => responses.shift()! },
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
      provider: { summarize, turn: async (request) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            content: [{ type: "tool_call", id: "tool-1", name: "report", arguments: {} }],
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
      expect.objectContaining({ type: "tool_result", tool_call_id: "tool-1", is_error: true }),
    ]);
    await runtime.stop();
  });

  test("stops stream retries after the first delivery failure and preserves the completed turn", async () => {
    const store = new MemoryStore();
    let streamAttempts = 0;
    let finalAttempts = 0;
    let providerCalls = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "noop",
      description: "noop",
      input_schema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: { summarize, turn: async (request) => {
        providerCalls += 1;
        await request.onEvent?.({ type: "text_delta", text: "d" });
        await request.onEvent?.({ type: "text_delta", text: "o" });
        if (providerCalls === 1) {
          return {
            content: [{ type: "tool_call", id: "tool-1", name: "noop", arguments: {} }],
            stop_reason: "tool_use",
            usage: { input_tokens: 2, output_tokens: 1 },
          };
        }
        await request.onEvent?.({ type: "text_delta", text: "ne" });
        return {
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 4, output_tokens: 1 },
        };
      } },
      emitter: {
        emit: async (request) => {
          if (request.emit_kind === "stream") streamAttempts += 1;
          if (request.emit_kind === "final") finalAttempts += 1;
          throw new Error("delivery offline");
        },
        typing: async () => undefined,
      },
      systemPrompt: "test",
    });

    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());

    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "done" }));
    expect(streamAttempts).toBe(1);
    expect(finalAttempts).toBe(1);
    expect(store.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
    await runtime.stop();
  });

  test("returns an error outcome when both the provider and error reply delivery fail", async () => {
    const store = new MemoryStore();
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: { summarize, turn: async () => { throw new Error("provider offline"); } },
      emitter: {
        emit: async () => { throw new Error("delivery offline"); },
        typing: async () => undefined,
      },
      systemPrompt: "test",
    });

    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());

    expect(outcome).toEqual(expect.objectContaining({
      status: "error",
      reply: "执行失败: provider offline",
    }));
    expect(store.metrics.at(-1)).toEqual(expect.objectContaining({ status: "error" }));
    await runtime.stop();
  });

  test("keeps a successful turn independent from typing delivery", async () => {
    const store = new MemoryStore();
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: { summarize, turn: async () => ({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }) },
      emitter: {
        emit: async () => undefined,
        typing: async () => { throw new Error("typing unavailable"); },
      },
      systemPrompt: "test",
    });

    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());

    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "done" }));
    await runtime.stop();
  });

  test("forces one compaction and retries once after provider context overflow", async () => {
    const store = new MemoryStore();
    store.messages = [
      ...["old-1", "old-2", "old-3"].flatMap((label): RuntimeMessage[] => [
        { role: "user", content: `${label} request ${"u".repeat(24_000)}` },
        { role: "assistant", content: [{ type: "text", text: `${label} answer ${"a".repeat(24_000)}` }] },
      ]),
    ];
    let providerCalls = 0;
    let summaryCalls = 0;
    let retriedMessages: RuntimeMessage[] = [];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      contextWindowTokens: 100_000,
      provider: {
        summarize: async () => {
          summaryCalls += 1;
          return { text: "preserved old decision", usage: { input_tokens: 20, output_tokens: 5 } };
        },
        turn: async (request) => {
          providerCalls += 1;
          if (providerCalls === 1) throw new Error("maximum context length exceeded");
          retriedMessages = request.messages;
          return {
            content: [{ type: "text", text: "recovered" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 2 },
          };
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "recovered" }));
    expect(providerCalls).toBe(2);
    expect(summaryCalls).toBe(1);
    expect(JSON.stringify(retriedMessages)).toContain("preserved old decision");
    expect(store.replacements.some((messages) => JSON.stringify(messages).includes("preserved old decision"))).toBe(true);
    expect(store.metrics.at(-1)).toEqual(expect.objectContaining({ api_calls: 3, input_tokens: 30, output_tokens: 7 }));
    await runtime.stop();
  });

  test("fails explicitly without replacing history when summaries stay empty over the hard limit", async () => {
    const store = new MemoryStore();
    store.messages = ["old-1", "old-2", "old-3"].flatMap((label): RuntimeMessage[] => [
      { role: "user", content: `${label} request ${"x".repeat(24_000)}` },
      { role: "assistant", content: [{ type: "text", text: `${label} answer ${"y".repeat(24_000)}` }] },
    ]);
    let providerCalls = 0;
    let summaryCalls = 0;
    const original = structuredClone(store.messages);
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      contextWindowTokens: 1_000,
      provider: {
        summarize: async () => {
          summaryCalls += 1;
          return { text: "", usage: { input_tokens: 2, output_tokens: 0 } };
        },
        turn: async () => {
          providerCalls += 1;
          throw new Error("turn must not be called");
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome.status).toBe("error");
    expect(outcome.reply).toContain("无法安全完成压缩");
    expect(summaryCalls).toBe(2);
    expect(providerCalls).toBe(0);
    expect(store.replacements).toHaveLength(0);
    expect(store.messages.slice(0, original.length)).toEqual(original);
    await runtime.stop();
  });

  test("stops explicitly at the soft threshold when summarization fails", async () => {
    const store = new MemoryStore();
    store.messages = [
      { role: "user", content: `old request ${"x".repeat(464_000)}` },
      { role: "assistant", content: [{ type: "text", text: `old answer ${"y".repeat(464_000)}` }] },
      { role: "user", content: "recent request" },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];
    let providerCalls = 0;
    let summaryCalls = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      contextWindowTokens: 256_000,
      provider: {
        summarize: async () => {
          summaryCalls += 1;
          throw new Error("summary offline");
        },
        turn: async () => {
          providerCalls += 1;
          throw new Error("turn must not be called");
        },
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome.status).toBe("error");
    expect(outcome.reply).toContain("无法安全完成压缩");
    expect(summaryCalls).toBe(2);
    expect(providerCalls).toBe(0);
    expect(store.replacements).toHaveLength(0);
    expect(store.metrics.at(-1)).toEqual(expect.objectContaining({ api_calls: 2 }));
    await runtime.stop();
  });

  test("ages processed history images after a completed turn", async () => {
    const store = new MemoryStore();
    store.messages = [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "secret-base64" } }],
    }];
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      provider: { summarize, turn: async () => ({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }) },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome.status).toBe("completed");
    expect(JSON.stringify(store.messages)).toContain("already processed");
    expect(JSON.stringify(store.messages)).not.toContain("secret-base64");
    await runtime.stop();
  });

  test("closes remaining tool calls when cancellation arrives between dispatches", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const controller = new AbortController();
    const runHandle: RuntimeHandle = {
      signal: controller.signal,
      cancelled: false,
      drainSteering: () => [],
      registerProcess: () => () => undefined,
    };
    tools.register({
      name: "first", description: "first", input_schema: { type: "object", properties: {} },
      execute: async () => {
        controller.abort(new DOMException("Aborted", "AbortError"));
        return { content: [{ type: "text", text: "first completed" }] };
      },
    });
    tools.register({
      name: "second", description: "second", input_schema: { type: "object", properties: {} },
      execute: async () => { throw new Error("must not run"); },
    });
    const runtime = new TypeScriptAgentRuntime({
      store, tools,
      provider: { summarize, turn: async () => ({
        content: [
          { type: "tool_call", id: "t1", name: "first", arguments: {} },
          { type: "tool_call", id: "t2", name: "second", arguments: {} },
        ],
        stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
      }) },
      emitter: { emit: async () => undefined, typing: async () => undefined }, systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), runHandle);
    expect(outcome.status).toBe("cancelled");
    expect(store.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_call_id: "t1" }),
      expect.objectContaining({ type: "tool_result", tool_call_id: "t2", is_error: true }),
    ]);
    await runtime.stop();
  });

  test("consumes steering before tool dispatch and asks the provider to reconsider", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    let toolCalls = 0;
    let providerCalls = 0;
    let drains = 0;
    tools.register({
      name: "dangerous", description: "dangerous", input_schema: { type: "object", properties: {} },
      execute: async () => { toolCalls += 1; return { content: [] }; },
    });
    const runHandle: RuntimeHandle = {
      signal: new AbortController().signal,
      cancelled: false,
      drainSteering: () => {
        drains += 1;
        return drains === 2 ? [{ text: "不要执行，改为解释" }] : [];
      },
      registerProcess: () => () => undefined,
    };
    const runtime = new TypeScriptAgentRuntime({
      store, tools,
      provider: { summarize, turn: async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? { content: [{ type: "tool_call", id: "t1", name: "dangerous", arguments: {} }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }
          : { content: [{ type: "text", text: "已改为解释" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      } },
      emitter: { emit: async () => undefined, typing: async () => undefined }, systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), runHandle);
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "已改为解释" }));
    expect(toolCalls).toBe(0);
    expect(JSON.stringify(store.messages)).toContain("skipped because the user steered");
    expect(JSON.stringify(store.messages)).toContain("不要执行");
    await runtime.stop();
  });

  test("returns the compatible continuation message at the step limit", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "loop", description: "loop", input_schema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "again" }] }),
    });
    const runtime = new TypeScriptAgentRuntime({
      store, tools, maxSteps: 1,
      provider: { summarize, turn: async () => ({
        content: [{ type: "tool_call", id: "t1", name: "loop", arguments: {} }],
        stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
      }) },
      emitter: { emit: async () => undefined, typing: async () => undefined }, systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome).toEqual(expect.objectContaining({
      status: "completed", reply: "本轮已达到最大步骤，请发送下一条消息继续。",
    }));
    expect(store.messages.at(-1)).toEqual({
      role: "assistant", content: [{ type: "text", text: "本轮已达到最大步骤，请发送下一条消息继续。" }],
    });
    await runtime.stop();
  });

  test("retries retryable provider errors three times but stops non-retryable errors immediately", async () => {
    const run = async (retryable: boolean): Promise<{ calls: number; outcome: Awaited<ReturnType<TypeScriptAgentRuntime["runTurn"]>> }> => {
      const store = new MemoryStore();
      let calls = 0;
      const runtime = new TypeScriptAgentRuntime({
        store, tools: new ToolRegistry(),
        provider: {
          summarize,
          turn: async () => {
            calls += 1;
            throw new RuntimeProviderError(
              retryable ? "service unavailable" : "invalid authentication",
              "kimi_coding",
              retryable ? "服务暂时异常" : "认证错误",
              retryable ? "Kimi Coding 服务暂时异常，请稍后重试。" : "Kimi Coding 认证失败，请检查 API Key。",
              retryable,
              retryable ? 503 : 401,
            );
          },
        },
        emitter: { emit: async () => undefined, typing: async () => undefined }, systemPrompt: "test",
      });
      await runtime.start();
      const outcome = await runtime.runTurn(job(), handle());
      await runtime.stop();
      return { calls, outcome };
    };
    const retryable = await run(true);
    expect(retryable.calls).toBe(3);
    expect(retryable.outcome.reply).toBe("执行失败: Kimi Coding 服务暂时异常，请稍后重试。");
    const fatal = await run(false);
    expect(fatal.calls).toBe(1);
    expect(fatal.outcome.reply).toBe("执行失败: Kimi Coding 认证失败，请检查 API Key。");
  });

  test("creates distinct zero-based wire attempts for retries and later agent steps", async () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      input_schema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const attempts: Array<{ step: number; attempt: number }> = [];
    let calls = 0;
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools,
      provider: {
        summarize,
        turn: async () => {
          calls += 1;
          if (calls === 1) {
            throw new RuntimeProviderError("retry", "custom", "temporary", "retry", true, 503);
          }
          if (calls === 2) {
            return {
              content: [{ type: "tool_call", id: "tool-1", name: "echo", arguments: {} }],
              stop_reason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          }
          return {
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
      traceController: {
        startTurn: () => ({
          record: () => undefined,
          startProviderAttempt: (context) => {
            attempts.push({ step: context.step, attempt: context.attempt });
            return {
              requestStart: () => undefined,
              responseStart: () => undefined,
              event: () => undefined,
              parseError: () => undefined,
              end: () => undefined,
            };
          },
        }),
      },
      emitter: { emit: async () => undefined, typing: async () => undefined },
      systemPrompt: "test",
    });
    await runtime.start();
    const outcome = await runtime.runTurn(job(), handle());
    expect(outcome).toEqual(expect.objectContaining({ status: "completed", reply: "done" }));
    expect(attempts).toEqual([
      { step: 0, attempt: 1 },
      { step: 0, attempt: 2 },
      { step: 1, attempt: 1 },
    ]);
    await runtime.stop();
  });
});

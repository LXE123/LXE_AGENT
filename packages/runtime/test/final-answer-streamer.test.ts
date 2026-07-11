import { describe, expect, test } from "bun:test";
import type { EmitRequest } from "@lxe/protocol";
import { FinalAnswerStreamer } from "../src/final-answer-streamer";

describe("FinalAnswerStreamer display contract", () => {
  test("emits redacted counts, cumulative metrics, sanitized tool output and one terminal frame", async () => {
    let clock = 1_000;
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      responseRouteId: "r1",
      emitId: "emit-1",
      minIntervalMs: 0,
      now: () => clock,
      model: "model-1",
      contextWindowTokens: 200_000,
      toolUseMode: "full",
      showFullPaths: false,
      emit: async (request) => { emitted.push(request); return true; },
    });

    await streamer.pushEvent({ type: "thinking_delta", thinking: "checking" });
    await streamer.pushEvent({ type: "redacted_thinking" });
    clock += 3_200;
    await streamer.pushEvent({ type: "text_delta", text: "done" });
    streamer.updateUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
    });
    const call = {
      type: "tool_use" as const,
      id: "tool-1",
      name: "exec",
      input: { command: "run C:\\Users\\Alice\\secret.txt --token=raw-secret" },
    };
    await streamer.pushToolStart(call);
    await streamer.pushToolFinish(call, "success", 1_400, {
      result: { path: "C:\\Users\\Alice\\result.json", token: "raw-secret", output: "x".repeat(5_000) },
    });
    const failedCall = { ...call, id: "tool-2", input: { command: "curl https://user:pass@example.test/private?token=raw-secret" } };
    await streamer.pushToolStart(failedCall);
    await streamer.pushToolFinish(failedCall, "error", 600, {
      error: `failed at C:\\Users\\Alice\\private.log token=raw-secret ${"e".repeat(2_500)}`,
    });
    clock += 1_400;
    expect(await streamer.finish("done")).toBe(true);

    const terminal = emitted.at(-1);
    expect(terminal?.emit_kind).toBe("stream");
    if (terminal?.emit_kind !== "stream") throw new Error("terminal stream frame expected");
    expect(terminal.state).toBe("final");
    expect(terminal.redacted_thinking_count).toBe(1);
    expect(terminal.display_metrics).toEqual(expect.objectContaining({
      status: "completed",
      elapsed_ms: 4_600,
      model: "model-1",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
      context_tokens: 112,
      context_window_tokens: 200_000,
    }));
    expect(terminal.tool_steps[0]).toEqual(expect.objectContaining({
      icon_token: "setting_outlined",
      status: "success",
    }));
    const serialized = JSON.stringify(terminal);
    expect(serialized).not.toContain("raw-secret");
    expect(serialized).not.toContain("C:\\\\Users\\\\Alice");
    expect(serialized).not.toContain("encrypted");
    expect(terminal.tool_steps[0]?.result_block?.content.length).toBeLessThanOrEqual(4_000);
    expect(terminal.tool_steps[1]?.error_block?.content.length).toBeLessThanOrEqual(2_000);
    expect(emitted.map((frame) => frame.seq)).toEqual(emitted.map((_, index) => index + 1));
  });

  test("reports cancelled without creating a stream when no frame was delivered", async () => {
    const emitted: EmitRequest[] = [];
    const streamer = new FinalAnswerStreamer({
      sessionId: "s1",
      responseRouteId: "r1",
      toolUseMode: "off",
      minIntervalMs: 0,
      emit: async (request) => { emitted.push(request); return true; },
    });
    expect(await streamer.cancel()).toBe(false);
    expect(emitted).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import parityFixture from "./fixtures/cardkit-final-main-parity.json";
import { buildFinalCard, buildStreamingCard, formatElapsed } from "../../../src/channels/feishu/card-builder";
import { loadFeishuConfig } from "../../../src/channels/feishu/config";
import type { CardDisplayState } from "../../../src/channels/feishu/card-builder";

const state = (): CardDisplayState => ({
  content: "最终答案",
  thinking: "分析过程",
  redactedCount: 0,
  thinkingElapsedMs: 17_400,
  toolPending: false,
  toolElapsedMs: 14_700,
  toolSteps: [{
    id: "t1",
    name: "exec",
    title: "Run command",
    detail: "bun test",
    icon_token: "setting_outlined",
    status: "success" as const,
    duration_ms: 14_700,
  }],
  metrics: {
    status: "completed",
    phase: "generating_answer",
    elapsed_ms: 32_100,
    model: "model-1",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 2,
    context_tokens: 112,
    context_window_tokens: 200_000,
  },
});

describe("official CardKit presentation", () => {
  test("matches the frozen main screenshot structure", () => {
    const card = buildFinalCard(state(), loadFeishuConfig({}).cardDisplay);
    expect(card).toEqual(parityFixture);
    const elements = (card.body as { elements: unknown[] }).elements;
    expect(elements.map((element) => (element as { tag: string }).tag))
      .toEqual(["collapsible_panel", "collapsible_panel", "markdown"]);
  });

  test("formats zero, seconds and minutes with official labels", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(3_200)).toBe("3.2s");
    expect(formatElapsed(62_400)).toBe("1m 2s");
  });

  test("renders pending/error/footer variants and never emits encrypted thinking data", () => {
    const config = loadFeishuConfig({
      FEISHU_TOOL_USE_MODE: "full",
      FEISHU_CARD_FOOTER_STATUS: "1",
      FEISHU_CARD_FOOTER_ELAPSED: "1",
      FEISHU_CARD_FOOTER_TOKENS: "1",
      FEISHU_CARD_FOOTER_CACHE: "1",
      FEISHU_CARD_FOOTER_CONTEXT: "1",
      FEISHU_CARD_FOOTER_MODEL: "1",
    }).cardDisplay;
    const value = state();
    value.content = "";
    value.thinking = "";
    value.redactedCount = 2;
    value.toolPending = true;
    value.toolSteps = [];
    value.metrics.status = "error";
    const streaming = buildStreamingCard(value, config);
    expect(JSON.stringify(streaming)).toContain("等待工具执行");
    expect(JSON.stringify(streaming)).toContain("部分思考内容已被模型隐藏");
    const final = buildFinalCard(value, config);
    const serialized = JSON.stringify(final);
    expect(serialized).toContain("💭 思考了 17.4s");
    expect(serialized).toContain("上下文 112/200k (0%)");
    expect(serialized).toContain("model-1");
    expect(serialized).not.toContain("redacted_thinking.data");
  });

  test("renders every tool state color and hides success results outside full mode", () => {
    const value = state();
    value.toolSteps = [
      { ...value.toolSteps[0]!, id: "running", status: "running" },
      { ...value.toolSteps[0]!, id: "success", status: "success", result_block: { language: "text", content: "private result" } },
      { ...value.toolSteps[0]!, id: "error", status: "error", error_block: { language: "text", content: "safe error" } },
    ];
    value.metrics.status = "cancelled";
    const config = loadFeishuConfig({ FEISHU_CARD_FOOTER_STATUS: "1" }).cardDisplay;
    const serialized = JSON.stringify(buildFinalCard(value, config));
    expect(serialized).toContain("turquoise");
    expect(serialized).toContain("green");
    expect(serialized).toContain("red");
    expect(serialized).toContain("已停止");
    expect(serialized).toContain("safe error");
    expect(serialized).not.toContain("private result");
  });
});

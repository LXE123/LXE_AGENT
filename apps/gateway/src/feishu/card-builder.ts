/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Card presentation adapted from openclaw-lark commit 18c4416.
 */

import type { DisplayMetrics, JsonObject, ToolDisplayBlock, ToolStep } from "@lxe/protocol";
import type { FeishuCardDisplayConfig } from "./config";
import { optimizeMarkdownStyle } from "./markdown-style";

export const STREAMING_ELEMENT_ID = "streaming_content";
const STEP_INDENT = "0px 0px 0px 22px";

export interface CardDisplayState {
  content: string;
  thinking: string;
  redactedCount: number;
  thinkingElapsedMs: number;
  toolPending: boolean;
  toolElapsedMs: number;
  toolSteps: ToolStep[];
  metrics: DisplayMetrics;
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

const titleSuffix = (count: number): { zh: string; en: string } => ({
  zh: `查看 ${count} 个步骤`,
  en: `Show ${count} step${count === 1 ? "" : "s"}`,
});

const statusStyle = (status: ToolStep["status"]): { label: string; color: string } => {
  if (status === "running") return { label: "Running", color: "turquoise" };
  if (status === "error") return { label: "Failed", color: "red" };
  return { label: "Succeeded", color: "green" };
};

const escaped = (value: string): string => value.replace(/\\/g, "\\\\").replace(/([`*_{}[\]<>])/g, "\\$1");

const codeBlock = (block: ToolDisplayBlock): string => {
  const content = block.content.replace(/\r\n/g, "\n").trim();
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${block.language}\n${content}\n${fence}`;
};

const toolStepElements = (step: ToolStep): JsonObject[] => {
  const status = statusStyle(step.status);
  const elements: JsonObject[] = [{
    tag: "div",
    icon: { tag: "standard_icon", token: step.icon_token, color: "grey" },
    text: {
      tag: "lark_md",
      content: optimizeMarkdownStyle(`**${escaped(step.title)}** · <font color='${status.color}'>${status.label}</font>`, 1),
      text_size: "notation",
    },
  }];
  if (step.detail.trim()) elements.push({
    tag: "div",
    margin: STEP_INDENT,
    text: { tag: "plain_text", content: step.detail.trim(), text_color: "grey", text_size: "notation" },
  });
  const block = step.error_block ?? step.result_block;
  if (block) elements.push({
    tag: "div",
    margin: STEP_INDENT,
    text: {
      tag: "lark_md",
      content: optimizeMarkdownStyle(`**${step.error_block ? "Error" : "Result"}**\n${codeBlock(block)}`, 1),
      text_size: "notation",
    },
  });
  return elements;
};

const panelFrame = (title: JsonObject, elements: JsonObject[], spacing: string): JsonObject => ({
  tag: "collapsible_panel",
  expanded: false,
  header: {
    title,
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", color: "grey", size: "16px 16px" },
    icon_position: "right",
    icon_expanded_angle: -180,
  },
  border: { color: "grey", corner_radius: "5px" },
  vertical_spacing: spacing,
  padding: "8px 8px 8px 8px",
  elements,
});

const toolPanel = (state: CardDisplayState, config: FeishuCardDisplayConfig): JsonObject | undefined => {
  if (config.toolUseMode === "off" || (!state.toolPending && state.toolSteps.length === 0)) return undefined;
  if (state.toolPending && state.toolSteps.length === 0) return panelFrame({
    tag: "plain_text",
    content: "🛠️ Tool use pending",
    i18n_content: { zh_cn: "🛠️ 等待工具执行", en_us: "🛠️ Tool use pending" },
    text_color: "grey",
    text_size: "notation",
  }, [], "4px");
  const duration = formatElapsed(state.toolElapsedMs);
  const suffix = titleSuffix(state.toolSteps.length);
  const visibleSteps = state.toolSteps.map((step) => {
    if (config.toolUseMode === "full") return step;
    const { result_block: _resultBlock, ...visible } = step;
    return visible;
  });
  return panelFrame({
    tag: "plain_text",
    content: `🛠️ Tool use for ${duration} · ${suffix.en}`,
    i18n_content: {
      zh_cn: `🛠️ 执行耗时 ${duration} · ${suffix.zh}`,
      en_us: `🛠️ Tool use for ${duration} · ${suffix.en}`,
    },
    text_color: "grey",
    text_size: "notation",
  }, visibleSteps.flatMap(toolStepElements), "4px");
};

const thinkingPanel = (state: CardDisplayState): JsonObject | undefined => {
  const hidden = state.redactedCount > 0 ? "部分思考内容已被模型隐藏" : "";
  const content = [state.thinking.trim(), hidden].filter(Boolean).join("\n\n");
  if (!content) return undefined;
  const duration = formatElapsed(state.thinkingElapsedMs);
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "markdown",
        content: `💭 Thought for ${duration}`,
        i18n_content: { zh_cn: `💭 思考了 ${duration}`, en_us: `💭 Thought for ${duration}` },
      },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content, text_size: "notation" }],
  };
};

const compact = (value: number): string => {
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe >= 100_000_000 ? 0 : 1)}m`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 100_000 ? 0 : 1)}k`;
  return `${Math.round(safe)}`;
};

const footerElement = (metrics: DisplayMetrics, config: FeishuCardDisplayConfig): JsonObject | undefined => {
  const primaryZh: string[] = [];
  const primaryEn: string[] = [];
  const detailZh: string[] = [];
  const detailEn: string[] = [];
  const f = config.footer;
  if (f.status) {
    const labels = metrics.status === "error" ? ["出错", "Error"]
      : metrics.status === "cancelled" ? ["已停止", "Stopped"] : ["已完成", "Completed"];
    primaryZh.push(labels[0]!); primaryEn.push(labels[1]!);
  }
  if (f.elapsed) {
    primaryZh.push(`耗时 ${formatElapsed(metrics.elapsed_ms)}`);
    primaryEn.push(`Elapsed ${formatElapsed(metrics.elapsed_ms)}`);
  }
  if (f.model && metrics.model.trim()) {
    primaryZh.push(metrics.model.trim());
    primaryEn.push(metrics.model.trim());
  }
  if (f.tokens) {
    const label = `↑ ${compact(metrics.input_tokens)} ↓ ${compact(metrics.output_tokens)}`;
    detailZh.push(label); detailEn.push(label);
  }
  if (f.cache) {
    const read = metrics.cache_read_input_tokens;
    const write = metrics.cache_creation_input_tokens;
    const total = read + write + metrics.input_tokens;
    const percent = total > 0 ? Math.round(read / total * 100) : 0;
    const label = `${compact(read)}/${compact(write)} (${percent}%)`;
    detailZh.push(`缓存 ${label}`); detailEn.push(`Cache ${label}`);
  }
  if (f.context && metrics.context_window_tokens > 0) {
    const percent = Math.round(metrics.context_tokens / metrics.context_window_tokens * 100);
    detailZh.push(`上下文 ${compact(metrics.context_tokens)}/${compact(metrics.context_window_tokens)} (${percent}%)`);
    detailEn.push(`Context ${compact(metrics.context_tokens)}/${compact(metrics.context_window_tokens)} (${percent}%)`);
  }
  const zhLines = [primaryZh.join(" · "), detailZh.join(" · ")].filter(Boolean);
  const enLines = [primaryEn.join(" · "), detailEn.join(" · ")].filter(Boolean);
  if (zhLines.length === 0) return undefined;
  const color = metrics.status === "error" ? "red" : "grey";
  return {
    tag: "markdown",
    content: `<font color='${color}'>${enLines.join("\n")}</font>`,
    i18n_content: {
      zh_cn: `<font color='${color}'>${zhLines.join("\n")}</font>`,
      en_us: `<font color='${color}'>${enLines.join("\n")}</font>`,
    },
    text_size: "notation",
  };
};

export function streamDisplayContent(state: CardDisplayState): string {
  if (state.content.trim()) return optimizeMarkdownStyle(state.content);
  const hidden = state.redactedCount > 0 ? "部分思考内容已被模型隐藏" : "";
  const reasoning = [state.thinking.trim(), hidden].filter(Boolean).join("\n\n");
  return `💭 **思考中...**${reasoning ? `\n\n${reasoning}` : ""}`;
}

export function buildStreamingCard(state: CardDisplayState, config: FeishuCardDisplayConfig): JsonObject {
  const elements: JsonObject[] = [];
  const tool = toolPanel(state, config);
  if (tool) elements.push(tool);
  elements.push({
    tag: "markdown",
    content: streamDisplayContent(state),
    ...(state.content.trim() ? {} : { i18n_content: {
      zh_cn: streamDisplayContent(state),
      en_us: streamDisplayContent(state).replace("思考中", "Thinking").replace("部分思考内容已被模型隐藏", "Some reasoning was hidden by the model"),
    } }),
    text_align: "left",
    text_size: state.content.trim() ? "normal_v2" : "notation",
    margin: "0px 0px 0px 0px",
    element_id: STREAMING_ELEMENT_ID,
  });
  elements.push({
    tag: "markdown",
    content: " ",
    icon: { tag: "custom_icon", img_key: "img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg", size: "16px 16px" },
    element_id: "loading_icon",
  });
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      wide_screen_mode: true,
      update_multi: true,
      locales: ["zh_cn", "en_us"],
      summary: { content: "Processing...", i18n_content: { zh_cn: "处理中...", en_us: "Processing..." } },
    },
    body: { elements },
  };
}

export function buildFinalCard(state: CardDisplayState, config: FeishuCardDisplayConfig): JsonObject {
  const elements: JsonObject[] = [];
  const thinking = thinkingPanel(state);
  if (thinking) elements.push(thinking);
  const tool = toolPanel(state, config);
  if (tool) elements.push(tool);
  elements.push({ tag: "markdown", element_id: "content", content: optimizeMarkdownStyle(state.content || " ") });
  const footer = footerElement(state.metrics, config);
  if (footer) elements.push(footer);
  const summary = state.content.replace(/[*_`#>[\]()~]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
      locales: ["zh_cn", "en_us"],
      summary: { content: state.metrics.status === "error" ? `生成失败: ${summary.slice(0, 40)}` : summary },
    },
    body: { elements },
  };
}

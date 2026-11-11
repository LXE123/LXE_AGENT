import type { CodemodeResult } from "@earendil-works/pi-codemode";
import type { JsonObject } from "@lxe/protocol";
import { redactToolFailureText, STEP_TOOL_RESULT_MAX_TOKENS, ToolOutputError, trimTextToTokenBudget } from "@lxe/runtime";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Pi estimates one token per four UTF-16 code units; images do not consume this budget. */
async function budgetText(items: JsonObject[], maxTokens: number): Promise<JsonObject[]> {
  const combined = items.filter(item => item.type === "text").map(item => item.text).join("\n");
  const budget = Math.min(maxTokens, STEP_TOOL_RESULT_MAX_TOKENS) * 4;
  // A multi-byte string can fit Pi's character budget but exceed the agent's UTF-8 byte budget.
  if (combined.length <= budget && Buffer.byteLength(combined) <= STEP_TOOL_RESULT_MAX_TOKENS * 4) return items;

  let location: string;
  const path = join(tmpdir(), `lxe-codemode-${randomUUID()}.txt`);
  try {
    await writeFile(path, combined, { mode: 0o600, flag: "wx" });
    location = `[Full output: ${path} (read with offset/limit)]`;
  } catch (cause) {
    location = `[Could not save the full output: ${redactToolFailureText(cause instanceof Error ? cause.message : String(cause))}]`;
  }
  let preview = combined;
  if (combined.length > budget) {
    const half = budget / 2;
    // Do not leave half an emoji at either cut. slice(-0) would return the entire string.
    const head = combined.slice(0, half).replace(/[\uD800-\uDBFF]$/u, "");
    const tail = combined.slice(combined.length - half).replace(/^[\uDC00-\uDFFF]/u, "");
    preview = `${head}…${Math.ceil((combined.length - budget) / 4)} tokens truncated…${tail}`;
  }
  const suffix = `\n\n${location}`;
  const inlineTokens = STEP_TOOL_RESULT_MAX_TOKENS - Math.ceil(Buffer.byteLength(suffix) / 4);
  const text = trimTextToTokenBudget(preview, inlineTokens).text + suffix;
  return [{ type: "text", text }, ...items.filter(item => item.type === "image")];
}

export async function codemodeOutput(result: CodemodeResult, maxTokens = STEP_TOOL_RESULT_MAX_TOKENS): Promise<JsonObject[]> {
  const items: JsonObject[] = result.output.map(item => item.type === "image"
    ? { type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } }
    : { type: "text", text: result.ok ? item.text : redactToolFailureText(item.text) });
  if (!result.ok) {
    const { name, message, stack } = result.error;
    const reason = name ? `${name}: ${message}` : message;
    const details = stack?.includes(message) ? stack : [reason, stack].filter(Boolean).join("\n");
    items.push({ type: "text", text: `Script error:\n${redactToolFailureText(details)}` });
    throw new ToolOutputError(redactToolFailureText(reason), await budgetText(items, maxTokens));
  }
  if (result.value !== undefined) items.push({
    type: "text", text: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
  });
  return budgetText(items, maxTokens);
}

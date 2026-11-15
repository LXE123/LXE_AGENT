import { createHash } from "node:crypto";
import type { JsonObject } from "@lxe/protocol";
import type { RuntimeMessageContent, RuntimeProviderRequest } from "../engine/types";
import { compactionSummaryProviderText } from "../engine/compaction-summary";
import { object, string } from "../messages/accumulator";
import { canReplayMetadata, completeTool } from "../messages/replay";
import { auxiliaryDescriptor, localFileReferenceText, type ProviderDescriptor } from "./provider";

interface Content extends JsonObject {
  role: "user" | "model";
  parts: JsonObject[];
}

function inlineImage(block: JsonObject): JsonObject {
  const source = object(block.source);
  const mimeType = string(source.media_type ?? source.mimeType ?? block.mimeType);
  const data = string(source.data ?? block.data);
  if (!/^image\/[a-z0-9.+-]+$/iu.test(mimeType) || !data || !/^[a-z0-9+/]+={0,2}$/iu.test(data) || data.length % 4 === 1) {
    throw new Error("Invalid Gemini image input (MIME type or base64 data)");
  }
  return { inlineData: { mimeType, data } };
}

function userParts(content: RuntimeMessageContent): JsonObject[] {
  if (typeof content === "string") return [{ text: content }];
  return content.flatMap((block): JsonObject[] => {
    if (block.type === "text") return [{ text: string(block.text) }];
    if (block.type === "local_file") return [{ text: localFileReferenceText(block) }];
    if (block.type === "image") return [inlineImage(block)];
    return [];
  });
}

interface Call { id: string; name: string; order: number }

function toolResponse(block: JsonObject, call: Call): JsonObject {
  const content = block.content;
  const texts: string[] = [];
  const images: JsonObject[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      if (part.type === "text") texts.push(string(part.text));
      if (part.type === "image") images.push(inlineImage(part));
    }
  } else texts.push(string(content));
  const text = texts.join("\n");
  return { functionResponse: { id: call.id, name: call.name, response: block.is_error ? { error: text } : { output: text },
    ...(images.length ? { parts: images } : {}) } };
}

export function buildGoogleRequest(origin: ProviderDescriptor, request: RuntimeProviderRequest): JsonObject {
  const descriptor = auxiliaryDescriptor(origin, request);
  const contents: Content[] = [];
  const instructions = [request.system];
  const calls = new Map<string, Call>();
  const results: { order: number; part: JsonObject }[] = [];
  const flushResults = () => {
    if (!results.length) return;
    contents.push({ role: "user", parts: results.sort((a, b) => a.order - b.order).map(result => result.part) });
    results.length = 0;
  };

  for (const message of request.messages) {
    if (message.role === "tool") {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== "tool_result") continue;
        const call = calls.get(string(block.tool_call_id));
        if (!call) throw new Error(`Gemini tool result has no matching call: ${block.tool_call_id}`);
        results.push({ order: call.order, part: toolResponse(block, call) });
      }
      continue;
    }
    flushResults();
    if (message.role === "system") {
      for (const part of userParts(message.content)) if (typeof part.text === "string") instructions.push(part.text);
    } else if (message.role === "compactionSummary") {
      contents.push({ role: "user", parts: [{ text: compactionSummaryProviderText(message.summary) }] });
    } else if (message.role === "user") {
      const parts = userParts(message.content);
      if (parts.length) contents.push({ role: "user", parts });
    } else if (message.role === "assistant") {
      calls.clear();
      const sameOrigin = canReplayMetadata(message, descriptor);
      const blocks: JsonObject[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      const parts: JsonObject[] = [];
      for (const block of blocks) {
        let part: JsonObject;
        let signature: unknown;
        if (block.type === "tool_call" && completeTool(block)) {
          const localId = string(block.id);
          const id = sameOrigin || /^[a-zA-Z0-9_-]{1,64}$/u.test(localId) ? localId
            : createHash("sha256").update(localId).digest("hex");
          const name = string(block.name);
          calls.set(localId, { id, name, order: calls.size });
          part = { functionCall: { id, name, args: block.arguments! } };
          signature = block.thoughtSignature;
        } else if (block.type === "thinking" && sameOrigin && !block.redacted) {
          part = { thought: true, text: string(block.thinking) };
          signature = block.thinkingSignature;
        } else if (block.type === "text") {
          part = { text: string(block.text) };
          signature = block.textSignature;
        } else continue;
        if (sameOrigin && typeof signature === "string" && signature) part.thoughtSignature = signature;
        if (part.text !== "" || part.thoughtSignature) parts.push(part);
      }
      if (parts.length) contents.push({ role: "model", parts });
    }
  }
  flushResults();
  const system = instructions.filter(Boolean).join("\n\n");
  const tools = request.toolChoice === "none" ? [] : request.tools;
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { maxOutputTokens: descriptor.maxTokens,
      thinkingConfig: { thinkingLevel: descriptor.thinkingEffort, includeThoughts: true } },
    ...(tools.length ? { tools: [{ functionDeclarations: tools.map(tool => ({
      name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema,
    })) }] } : {}),
  };
}

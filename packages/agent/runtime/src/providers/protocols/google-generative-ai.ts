import { randomUUID } from "node:crypto";
import { AssistantMessageAccumulator, object, string } from "../../messages/accumulator";

/** Convert Google GenerateContentResponse chunks into the shared assistant event stream. */
export class GoogleStreamAdapter {
  private active: { index: number; thinking: boolean } | undefined;
  private readonly callIds = new Set<string>();
  private readonly usage: Record<string, unknown> = {};
  private finishReason = "";

  constructor(private readonly accumulator: AssistantMessageAccumulator) {}

  streamEvent(value: unknown): void {
    const chunk = object(value);
    if (chunk.error) {
      const detail = object(chunk.error);
      throw Object.assign(new Error(string(detail.message) || JSON.stringify(chunk.error)), {
        status: detail.code, error: chunk.error,
      });
    }
    this.accumulator.identity(chunk.responseId, chunk.modelVersion);
    if (chunk.usageMetadata) {
      const usage = Object.assign(this.usage, object(chunk.usageMetadata));
      const cache = Number(usage.cachedContentTokenCount ?? 0);
      const prompt = usage.promptTokenCount;
      const output = usage.candidatesTokenCount;
      this.accumulator.usage({
        ...(prompt !== undefined ? { input_tokens: Math.max(0, Number(prompt) - cache) } : {}),
        ...(usage.cachedContentTokenCount !== undefined ? { cache_read_input_tokens: cache } : {}),
        ...(output !== undefined || usage.thoughtsTokenCount !== undefined
          ? { output_tokens: Number(output ?? 0) + Number(usage.thoughtsTokenCount ?? 0) } : {}),
        status: prompt !== undefined && (output !== undefined || usage.totalTokenCount !== undefined) ? "complete" : "partial",
      });
    }
    const feedback = object(chunk.promptFeedback);
    if (feedback.blockReason) {
      throw this.incomplete(feedback.blockReason, "Gemini promptFeedback: " + JSON.stringify(feedback));
    }
    const candidate = object(Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined);
    const parts = object(candidate.content).parts;
    if (Array.isArray(parts)) {
      for (const value of parts) {
        const part = object(value);
        if (this.finishReason && !(part.thoughtSignature && !part.text && !part.functionCall)) {
          throw new Error("Gemini content arrived after " + this.finishReason);
        }
        this.part(part);
      }
    }
    if (candidate.finishReason) {
      const reason = string(candidate.finishReason);
      if (this.finishReason && this.finishReason !== reason) throw new Error("Conflicting Gemini finishReason: " + reason);
      this.finishReason = reason;
      this.accumulator.message.rawStopReason = reason;
      if (reason !== "STOP" && reason !== "MAX_TOKENS") {
        throw this.incomplete(reason, "Gemini finishReason: " + reason + (candidate.finishMessage ? " — " + candidate.finishMessage : ""));
      }
    }
  }

  private incomplete(reason: unknown, message: string): Error {
    return Object.assign(new Error(message), { incomplete_details: { reason } });
  }

  private closeText(): void {
    if (this.active) this.accumulator.end(this.active.index);
    this.active = undefined;
  }

  private part(part: Record<string, unknown>): void {
    const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
    if (part.functionCall) {
      this.closeText();
      const fn = object(part.functionCall);
      const name = string(fn.name);
      if (!name) throw new Error("Gemini functionCall has no name");
      let id = string(fn.id);
      if (!id || this.callIds.has(id)) id = randomUUID();
      this.callIds.add(id);
      const index = this.accumulator.startTool({ id, name, ...(signature ? { thoughtSignature: signature } : {}) });
      this.accumulator.append(index, JSON.stringify(fn.args ?? {}));
      this.accumulator.end(index);
      return;
    }

    if (typeof part.text !== "string" && !signature) throw new Error("Unsupported Gemini response part: " + Object.keys(part).join(", "));
    const thinking = part.thought === true;
    // A signed part (including one with empty text) must be replayed on its own.
    if (!this.active || this.active.thinking !== thinking || signature) {
      this.closeText();
      this.active = { thinking, index: thinking ? this.accumulator.startThinking() : this.accumulator.startText() };
    }
    this.accumulator.append(this.active.index, string(part.text));
    if (signature) {
      this.accumulator.metadata(this.active.index, thinking ? { thinkingSignature: signature } : { textSignature: signature });
      this.closeText();
    }
  }

  result() {
    if (!this.finishReason) throw new Error("Gemini stream ended without finishReason");
    this.closeText();
    const reason = this.finishReason === "MAX_TOKENS" ? "length" : this.callIds.size ? "toolUse" : "stop";
    return this.accumulator.complete(reason, this.finishReason);
  }
}

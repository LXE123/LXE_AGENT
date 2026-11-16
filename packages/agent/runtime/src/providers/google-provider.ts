import { createParser } from "eventsource-parser";
import type { RuntimeProvider, RuntimeProviderRequest, RuntimeSummaryRequest, RuntimeSummaryResult } from "../engine/types";
import { AssistantMessageAccumulator } from "../messages/accumulator";
import { harnessFetch } from "../network/fetch";
import { buildGoogleRequest } from "./google-request";
import { GoogleStreamAdapter } from "./protocols/google-generative-ai";
import {
  normalizeProviderError, ProviderIdleWatchdog, providerEndpointUrl, RuntimeProviderError,
  SUMMARY_SYSTEM_PROMPT, type ProviderDescriptor,
} from "./provider";
import { sanitizeWireTraceValue } from "./wire-trace";

function traceSafely(record: () => void): void {
  try { record(); } catch { /* Diagnostics cannot interrupt a model turn. */ }
}

async function responseError(response: Response): Promise<Error> {
  const raw = await response.text();
  let body: unknown = raw;
  try { body = sanitizeWireTraceValue(JSON.parse(raw)); } catch { /* Keep non-JSON gateway responses. */ }
  const status = `Gemini HTTP ${response.status} ${response.statusText}`.trim();
  const message = response.ok ? `${status}: expected text/event-stream, received ${response.headers.get("content-type") ?? "no Content-Type"}` : status;
  return Object.assign(new Error(message), {
    status: response.status, headers: response.headers, body,
  });
}

export class GoogleRuntimeProvider implements RuntimeProvider {
  constructor(private readonly descriptor: ProviderDescriptor, private readonly send = harnessFetch) {}

  async turn(request: RuntimeProviderRequest) {
    const accumulator = new AssistantMessageAccumulator(this.descriptor, request.onEvent);
    const stream = new GoogleStreamAdapter(accumulator);
    const watchdog = new ProviderIdleWatchdog(request.signal, this.descriptor.requestIdleTimeoutMs);
    const trace = request.wireTrace;
    try {
      request.signal.throwIfAborted();
      const body = buildGoogleRequest(this.descriptor, request);
      const headers = { ...this.descriptor.defaultHeaders, "x-goog-api-key": this.descriptor.apiKey,
        "Content-Type": "application/json", Accept: "text/event-stream" };
      traceSafely(() => trace?.requestStart(headers, body));
      const response = await this.send(providerEndpointUrl(this.descriptor), {
        method: "POST", headers, body: JSON.stringify(body), signal: watchdog.signal,
      });
      traceSafely(() => trace?.responseStart(response.status, Object.fromEntries(response.headers)));
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        throw await responseError(response);
      }
      if (!response.body) throw new Error("Gemini stream has no response body");
      let endOfStream = false;
      const parser = createParser({ onEvent: ({ data }) => {
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
          if (endOfStream) throw new Error("Gemini stream ended inside an SSE event");
        } catch (error) {
          traceSafely(() => trace?.parseError("generateContent", data, normalizeProviderError(error, this.descriptor)));
          throw error;
        }
        traceSafely(() => trace?.event("generateContent", chunk));
        stream.streamEvent(chunk);
      } });
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          watchdog.activity();
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.feed(decoder.decode());
        // Detect an unfinished trailing event even if an earlier candidate already sent STOP.
        endOfStream = true;
        parser.feed("\n\n");
      } finally { reader.releaseLock(); }
      watchdog.signal.throwIfAborted();
      const message = stream.result();
      traceSafely(() => trace?.end(true));
      return message;
    } catch (error) {
      const failure = request.signal.aborted ? request.signal.reason : watchdog.timedOut()
        ? new RuntimeProviderError(`provider request idle timed out after ${this.descriptor.requestIdleTimeoutMs}ms`,
          this.descriptor.name, "请求超时", true)
        : normalizeProviderError(error, this.descriptor);
      watchdog.abort(failure);
      accumulator.fail(request.signal.aborted ? "aborted" : "error", failure);
      traceSafely(() => trace?.end(false, failure instanceof Error ? failure.message : String(failure)));
      throw failure;
    } finally {
      watchdog.cleanup();
      await accumulator.drain();
    }
  }

  async summarize(request: RuntimeSummaryRequest): Promise<RuntimeSummaryResult> {
    const message = await this.turn({
      system: SUMMARY_SYSTEM_PROMPT, messages: request.messages, signal: request.signal, tools: [], toolChoice: "none",
      auxiliary: { maxOutputTokens: Math.max(1, Math.trunc(request.maxOutputTokens)), reasoning: "minimum" },
    });
    const { status: _status, ...usage } = message.usage;
    return { text: message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("").trim(), usage };
  }
}

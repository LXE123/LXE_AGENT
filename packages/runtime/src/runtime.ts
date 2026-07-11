import { randomUUID } from "node:crypto";
import type { AgentJob, EmitRequest, JsonObject } from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import { ToolRegistry } from "./tools";
import { pruneMessages, validateToolCallClosure } from "./context";
import type {
  AgentRuntime,
  RuntimeContentBlock,
  RuntimeEmitter,
  RuntimeHandle,
  RuntimeMessage,
  RuntimeProvider,
  RuntimeStore,
  ToolResultBlock,
  ToolUseBlock,
  TurnOutcome,
} from "./types";

export interface TypeScriptAgentRuntimeOptions {
  store: RuntimeStore;
  provider: RuntimeProvider;
  tools: ToolRegistry;
  emitter: RuntimeEmitter;
  systemPrompt: string;
  maxSteps?: number;
  maxContextMessages?: number;
  services?: Array<{
    start(registry: ToolRegistry): Promise<void>;
    stop(): Promise<void>;
  }>;
}

const toolUseBlocks = (content: RuntimeContentBlock[]): ToolUseBlock[] =>
  content.filter((block): block is ToolUseBlock =>
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    block.input !== null && typeof block.input === "object" && !Array.isArray(block.input));

const textContent = (content: RuntimeContentBlock[]): string =>
  content
    .filter((block): block is RuntimeContentBlock & { text: string } =>
      block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();

const isCancelled = (handle: RuntimeHandle): boolean => handle.cancelled || handle.signal.aborted;

export class TypeScriptAgentRuntime implements AgentRuntime {
  private readonly logger = createLogger("runtime");
  private readonly active = new Set<RuntimeHandle>();
  private started = false;

  constructor(private readonly options: TypeScriptAgentRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.options.store.start();
    const startedServices: NonNullable<TypeScriptAgentRuntimeOptions["services"]> = [];
    try {
      for (const service of this.options.services ?? []) {
        await service.start(this.options.tools);
        startedServices.push(service);
      }
    } catch (cause) {
      await Promise.allSettled(startedServices.reverse().map((service) => service.stop()));
      await this.options.store.stop();
      throw cause;
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await Promise.allSettled([...this.active].map(async (handle) => {
      if (!handle.signal.aborted) this.logger.warn("runtime stopped with active turn");
    }));
    await Promise.allSettled([...(this.options.services ?? [])].reverse().map((service) => service.stop()));
    await this.options.store.stop();
    this.started = false;
  }

  async runTurn(job: AgentJob, handle: RuntimeHandle): Promise<TurnOutcome> {
    if (!this.started) throw new Error("runtime is not started");
    const session = await this.options.store.getSession(job.session_id);
    if (!session) throw new Error(`session not found: ${job.session_id}`);
    this.active.add(handle);
    let inputTokens = 0;
    let outputTokens = 0;
    let apiCalls = 0;
    let toolCalls = 0;
    let typingStarted = false;
    try {
      if (job.job_kind === "turn" && job.response_route_id) {
        await this.options.emitter.typing({
          session_id: job.session_id,
          response_route_id: job.response_route_id,
          operation: "start",
          emit_id: randomUUID().replaceAll("-", ""),
        });
        typingStarted = true;
      }
      const messages = await this.options.store.loadMessages(job.session_id);
      const userContent: RuntimeMessage["content"] = job.user_content_blocks.length > 0
        ? job.user_content_blocks
        : job.user_input;
      const userMessage: RuntimeMessage = { role: "user", content: userContent };
      messages.push(userMessage);
      await this.options.store.appendMessage(job.session_id, userMessage, "turn_input");

      const maxSteps = Math.max(1, Math.trunc(this.options.maxSteps ?? 32));
      for (let step = 0; step < maxSteps; step += 1) {
        if (isCancelled(handle)) return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
        for (const steering of handle.drainSteering()) {
          const text = String(steering.text ?? "").trim();
          if (!text) continue;
          const message: RuntimeMessage = { role: "user", content: text };
          messages.push(message);
          await this.options.store.appendMessage(job.session_id, message, "steering");
        }
        const providerMessages = pruneMessages(messages, this.options.maxContextMessages ?? 200);
        validateToolCallClosure(providerMessages);
        const response = await this.options.provider.turn({
          system: this.options.systemPrompt,
          messages: providerMessages,
          tools: this.options.tools.schemas(),
          signal: handle.signal,
        });
        apiCalls += 1;
        inputTokens += Math.max(0, Math.trunc(response.usage.input_tokens));
        outputTokens += Math.max(0, Math.trunc(response.usage.output_tokens));
        const assistant: RuntimeMessage = { role: "assistant", content: response.content };
        messages.push(assistant);
        await this.options.store.appendMessage(job.session_id, assistant, "assistant_response");
        const calls = toolUseBlocks(response.content);
        if (calls.length === 0) {
          const reply = textContent(response.content);
          await this.options.store.recordTurn(job.session_id, {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            tool_calls: toolCalls,
            api_calls: apiCalls,
          });
          if (reply && job.response_route_id) await this.options.emitter.emit(this.finalRequest(job, reply));
          return this.outcome("completed", reply, inputTokens, outputTokens, toolCalls);
        }

        const results: ToolResultBlock[] = [];
        for (const call of calls) {
          if (isCancelled(handle)) return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
          toolCalls += 1;
          try {
            const result = await this.options.tools.execute(call.name, call.input, {
              handle,
              session_id: job.session_id,
            });
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: result.content,
            });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: message,
              is_error: true,
            });
          }
        }
        const toolMessage: RuntimeMessage = { role: "user", content: results };
        messages.push(toolMessage);
        await this.options.store.appendMessage(job.session_id, toolMessage, "tool_results");
      }
      throw new Error(`agent loop exceeded ${maxSteps} steps`);
    } catch (cause) {
      if (isCancelled(handle) || (cause instanceof DOMException && cause.name === "AbortError")) {
        return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error("turn failed", { session_id: job.session_id, run_id: job.job_id, error: cause });
      const reply = `执行失败: ${message}`;
      if (job.response_route_id) await this.options.emitter.emit(this.finalRequest(job, reply));
      return this.outcome("error", reply, inputTokens, outputTokens, toolCalls);
    } finally {
      if (typingStarted) {
        await this.options.emitter.typing({
          session_id: job.session_id,
          response_route_id: job.response_route_id,
          operation: "stop",
          emit_id: randomUUID().replaceAll("-", ""),
        }).catch(() => undefined);
      }
      this.active.delete(handle);
    }
  }

  private outcome(
    status: TurnOutcome["status"],
    reply: string,
    inputTokens: number,
    outputTokens: number,
    toolCalls: number,
  ): TurnOutcome {
    return { status, reply, input_tokens: inputTokens, output_tokens: outputTokens, tool_calls: toolCalls };
  }

  private finalRequest(job: AgentJob, content: string): EmitRequest {
    return {
      session_id: job.session_id,
      response_route_id: job.response_route_id,
      content,
      thinking: "",
      redacted_thinking_count: 0,
      thinking_elapsed_ms: 0,
      tool_pending: false,
      tool_elapsed_ms: 0,
      tool_steps: [],
      files: [],
      emit_kind: "final",
      emit_id: randomUUID().replaceAll("-", ""),
      stream_type: "final_answer",
      state: "final",
      seq: 1,
    };
  }
}

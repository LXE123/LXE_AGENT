import { randomUUID } from "node:crypto";
import type { AgentJob, EmitRequest, JsonObject } from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import { ToolRegistry } from "./tools";
import {
  ContextCompactionError,
  ContextOverflowError,
  ContextPipeline,
  isContextOverflowError,
  trimToolResultBlocks,
  type ContextCompactionResult,
} from "./context";
import { FinalAnswerStreamer } from "./final-answer-streamer";
import { RuntimeProviderError, type RuntimeProviderManager } from "./provider";
import type { RuntimeTraceControllerPort } from "./trace";
import type {
  AgentRuntime,
  RuntimeContentBlock,
  RuntimeEmitter,
  RuntimeHandle,
  RuntimeMessage,
  RuntimeProvider,
  RuntimeStore,
  RuntimeStreamEvent,
  RuntimeTurnResponse,
  RuntimeUsage,
  ToolResultBlock,
  ToolUseBlock,
  TurnOutcome,
} from "./types";

export interface TypeScriptAgentRuntimeOptions {
  store: RuntimeStore;
  provider?: RuntimeProvider;
  providerManager?: RuntimeProviderManager;
  traceController?: RuntimeTraceControllerPort;
  tools: ToolRegistry;
  emitter: RuntimeEmitter;
  systemPrompt: string;
  maxSteps?: number;
  contextWindowTokens?: number;
  display?: {
    model: string;
    contextWindowTokens: number;
    toolUseMode: "off" | "on" | "full";
    showFullPaths: boolean;
  };
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

const addUsage = (target: { input: number; output: number }, usage: RuntimeUsage): void => {
  target.input += Math.max(0, Math.trunc(usage.input_tokens ?? 0));
  target.output += Math.max(0, Math.trunc(usage.output_tokens ?? 0));
};

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
    const providerSnapshot = this.options.providerManager?.acquire();
    const provider = providerSnapshot?.provider ?? this.options.provider;
    if (!provider) throw new Error("runtime provider is not configured");
    const descriptor = providerSnapshot?.descriptor;
    const trace = this.options.traceController?.startTurn(job.session_id, job.job_id);
    trace?.record("turn_start", {
      session_id: job.session_id,
      turn_id: job.job_id,
      provider: descriptor?.name ?? "custom",
      model: descriptor?.model ?? this.options.display?.model ?? "",
    });
    const contextWindowTokens = descriptor?.contextWindowTokens ?? this.options.contextWindowTokens ?? this.options.display?.contextWindowTokens;
    const contextPipeline = new ContextPipeline({
      provider,
      store: this.options.store,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    });
    const finalAnswerStreamer = job.response_route_id && String(session.source.platform ?? "").trim() === "feishu"
      ? new FinalAnswerStreamer({
          sessionId: job.session_id,
          responseRouteId: job.response_route_id,
          emit: (request) => this.emitBestEffort(request, "stream"),
          ...(this.options.display ? {
            model: descriptor?.model ?? this.options.display.model,
            contextWindowTokens: descriptor?.contextWindowTokens ?? this.options.display.contextWindowTokens,
          } : {}),
          toolUseMode: this.options.display?.toolUseMode ?? "on",
          showFullPaths: this.options.display?.showFullPaths ?? false,
        })
      : undefined;
    this.active.add(handle);
    let inputTokens = 0;
    let outputTokens = 0;
    let apiCalls = 0;
    let toolCalls = 0;
    let typingStarted = false;
    const startedAt = Date.now() / 1_000;
    const toolUsage = new Map<string, { calls: number; errors: number; duration_ms: number }>();
    let usageRecorded = false;
    const accountContext = (result: ContextCompactionResult): void => {
      const usage = { input: inputTokens, output: outputTokens };
      addUsage(usage, result.usage);
      inputTokens = usage.input;
      outputTokens = usage.output;
      apiCalls += result.apiCalls;
      if (result.apiCalls > 0) finalAnswerStreamer?.updateUsage(result.usage);
    };
    const recordUsage = async (status: TurnOutcome["status"]): Promise<void> => {
      if (usageRecorded) return;
      usageRecorded = true;
      await this.options.store.recordTurn(job.session_id, {
        turn_id: job.job_id,
        started_at: startedAt,
        status,
        elapsed_ms: Math.max(0, Math.trunc((Date.now() / 1_000 - startedAt) * 1_000)),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tool_calls: toolCalls,
        api_calls: apiCalls,
        tools: [...toolUsage.entries()].map(([name, usage]) => ({ name, ...usage })),
      });
      trace?.record("turn_end", {
        status,
        elapsed_ms: Math.max(0, Math.trunc((Date.now() / 1_000 - startedAt) * 1_000)),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tool_calls: toolCalls,
        api_calls: apiCalls,
      });
    };
    try {
      if (job.job_kind === "turn" && job.response_route_id) {
        typingStarted = await this.typingBestEffort({
          session_id: job.session_id,
          response_route_id: job.response_route_id,
          operation: "start",
          emit_id: randomUUID().replaceAll("-", ""),
        }, "start");
      }
      let messages = await this.options.store.loadMessages(job.session_id);
      const userContent: RuntimeMessage["content"] = job.user_content_blocks.length > 0
        ? job.user_content_blocks
        : job.user_input;
      const userMessage: RuntimeMessage = { role: "user", content: userContent };
      messages.push(userMessage);
      await this.options.store.appendMessage(job.session_id, userMessage, "turn_input");

      const appendSteering = async (steeringMessages = handle.drainSteering()): Promise<number> => {
        let appended = 0;
        for (const steering of steeringMessages) {
          const text = String(steering.text ?? "").trim();
          if (!text) continue;
          const message: RuntimeMessage = { role: "user", content: text };
          messages.push(message);
          await this.options.store.appendMessage(job.session_id, message, "steering");
          appended += 1;
        }
        return appended;
      };

      const maxSteps = Math.max(1, Math.trunc(this.options.maxSteps ?? 50));
      await finalAnswerStreamer?.startToolPending();
      for (let step = 0; step < maxSteps; step += 1) {
        if (isCancelled(handle)) {
          await finalAnswerStreamer?.cancel();
          await recordUsage("cancelled");
          return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
        }
        await appendSteering();
        const toolSchemas = this.options.tools.schemas();
        const prepared = await contextPipeline.prepare({
          sessionId: job.session_id,
          messages,
          systemPrompt: this.options.systemPrompt,
          toolSchemas,
          signal: handle.signal,
          trigger: "pre_call",
        });
        accountContext(prepared);
        messages = prepared.messages;
        if (prepared.failureReason) {
          throw new ContextCompactionError(prepared.failureReason, prepared.afterTokens);
        }
        if (prepared.hardLimitExceeded) {
          throw new ContextOverflowError(prepared.afterTokens, contextPipeline.hardLimitTokens);
        }
        const providerRequest = () => ({
          system: this.options.systemPrompt,
          messages: structuredClone(messages) as RuntimeMessage[],
          tools: toolSchemas,
          signal: handle.signal,
          ...(trace ? { trace } : {}),
          onEvent: async (event: RuntimeStreamEvent) => {
            trace?.record("stream_event", {
              type: event.type,
              ...(event.type === "text_delta" ? { chars: event.text.length } : {}),
              ...(event.type === "thinking_delta" ? { chars: event.thinking.length } : {}),
            });
            if (!isCancelled(handle)) await finalAnswerStreamer?.pushEvent(event);
          },
        });
        const invokeProvider = async (maximumAttempts = 3): Promise<RuntimeTurnResponse> => {
          let lastError: unknown;
          for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            apiCalls += 1;
            this.logger.debug("provider attempt", {
              session_id: job.session_id,
              turn_id: job.job_id,
              step: step + 1,
              attempt,
              provider: descriptor?.name ?? "custom",
              model: descriptor?.model ?? this.options.display?.model ?? "",
            });
            trace?.record("provider_attempt", { step: step + 1, attempt });
            try {
              return await provider.turn(providerRequest());
            } catch (error) {
              if (isCancelled(handle) || (error instanceof DOMException && error.name === "AbortError")) throw error;
              if (isContextOverflowError(error)) throw error;
              const retryable = error instanceof RuntimeProviderError ? error.retryable : true;
              lastError = error;
              this.logger.warn("provider attempt failed", {
                session_id: job.session_id,
                turn_id: job.job_id,
                step: step + 1,
                attempt,
                retryable,
                error,
              });
              if (!retryable || attempt >= maximumAttempts) throw error;
            }
          }
          throw lastError ?? new Error("provider request failed");
        };
        let response;
        try {
          response = await invokeProvider();
        } catch (error) {
          if (!isContextOverflowError(error)) throw error;
          const overflow = await contextPipeline.prepare({
            sessionId: job.session_id,
            messages,
            systemPrompt: this.options.systemPrompt,
            toolSchemas,
            signal: handle.signal,
            trigger: "overflow",
          });
          accountContext(overflow);
          messages = overflow.messages;
          if (overflow.failureReason) {
            throw new ContextCompactionError(overflow.failureReason, overflow.afterTokens);
          }
          if (!overflow.compacted || overflow.hardLimitExceeded) throw error;
          response = await invokeProvider(1);
        }
        inputTokens += Math.max(0, Math.trunc(response.usage.input_tokens));
        outputTokens += Math.max(0, Math.trunc(response.usage.output_tokens));
        finalAnswerStreamer?.updateUsage(response.usage);
        const assistant: RuntimeMessage = { role: "assistant", content: response.content };
        messages.push(assistant);
        await this.options.store.appendMessage(job.session_id, assistant, "assistant_response");
        const calls = toolUseBlocks(response.content);
        if (calls.length === 0) {
          const reply = textContent(response.content);
          const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.finish(reply) : false;
          if (reply && job.response_route_id && !streamDelivered) {
            await this.emitBestEffort(this.finalRequest(job, reply), "final");
          }
          if (!isCancelled(handle)) {
            try {
              const postTurn = await contextPipeline.postTurn({
                sessionId: job.session_id,
                messages,
                systemPrompt: this.options.systemPrompt,
                signal: handle.signal,
              });
              accountContext(postTurn);
              messages = postTurn.messages;
              if (postTurn.failureReason) {
                throw new ContextCompactionError(postTurn.failureReason, postTurn.afterTokens);
              }
              if (postTurn.hardLimitExceeded) {
                this.logger.warn("post-turn context remains over hard limit", {
                  session_id: job.session_id,
                  estimated_tokens: postTurn.afterTokens,
                });
              }
            } catch (error) {
              if (!isCancelled(handle)) this.logger.warn("post-turn context maintenance failed", {
                session_id: job.session_id,
                error,
              });
            }
          }
          await recordUsage("completed");
          return this.outcome("completed", reply, inputTokens, outputTokens, toolCalls);
        }

        const results: ToolResultBlock[] = [];
        let interruptedBySteering = false;
        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
          const call = calls[callIndex]!;
          const steering = handle.drainSteering();
          if (steering.some((item) => String(item.text ?? "").trim())) {
            for (const pending of calls.slice(callIndex)) {
              results.push({
                type: "tool_result",
                tool_use_id: pending.id,
                content: "Tool execution skipped because the user steered the active turn before dispatch.",
                is_error: true,
              });
            }
            const steeredTools: RuntimeMessage = { role: "user", content: results };
            messages.push(steeredTools);
            await this.options.store.appendMessage(job.session_id, steeredTools, "tool_results_steered");
            await appendSteering(steering);
            interruptedBySteering = true;
            break;
          }
          if (isCancelled(handle)) {
            for (const pending of calls.slice(callIndex)) {
              results.push({
                type: "tool_result",
                tool_use_id: pending.id,
                content: "Tool execution cancelled before dispatch.",
                is_error: true,
              });
            }
            const cancelledTools: RuntimeMessage = { role: "user", content: results };
            messages.push(cancelledTools);
            await this.options.store.appendMessage(job.session_id, cancelledTools, "tool_results_cancelled");
            await finalAnswerStreamer?.cancel();
            await recordUsage("cancelled");
            return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
          }
          toolCalls += 1;
          const startedToolAt = Date.now();
          const usage = toolUsage.get(call.name) ?? { calls: 0, errors: 0, duration_ms: 0 };
          usage.calls += 1;
          toolUsage.set(call.name, usage);
          trace?.record("tool_start", { step: step + 1, tool: call.name, tool_use_id: call.id, input: call.input });
          await finalAnswerStreamer?.pushToolStart(call);
          let toolStatus: "success" | "error" = "success";
          let toolDisplayOutput: { result?: unknown; error?: unknown } | undefined;
          try {
            const result = await this.options.tools.execute(call.name, call.input, {
              handle,
              session_id: job.session_id,
              response_route_id: job.response_route_id,
              turn_id: job.job_id,
            });
            if (result.state_patch && Object.keys(result.state_patch).length > 0) {
              await this.options.store.patchSessionState(job.session_id, result.state_patch);
            }
            if (result.files?.length && job.response_route_id) {
              await this.options.emitter.emit({
                session_id: job.session_id,
                response_route_id: job.response_route_id,
                content: "",
                thinking: "",
                redacted_thinking_count: 0,
                thinking_elapsed_ms: 0,
                tool_pending: false,
                tool_elapsed_ms: Date.now() - startedToolAt,
                tool_steps: [],
                files: result.files,
                emit_kind: "tool",
                emit_id: randomUUID().replaceAll("-", ""),
                stream_type: "",
                state: "",
                seq: 0,
              });
            }
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: result.content,
            });
            toolDisplayOutput = { result: result.content };
          } catch (cause) {
            usage.errors += 1;
            toolStatus = "error";
            const message = cause instanceof Error ? cause.message : String(cause);
            toolDisplayOutput = { error: message };
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: message,
              is_error: true,
            });
          } finally {
            const durationMs = Date.now() - startedToolAt;
            usage.duration_ms += durationMs;
            trace?.record("tool_end", { step: step + 1, tool: call.name, tool_use_id: call.id, status: toolStatus, duration_ms: durationMs });
            await finalAnswerStreamer?.pushToolFinish(call, toolStatus, durationMs, toolDisplayOutput);
          }
        }
        if (interruptedBySteering) continue;
        const trimmedResults = trimToolResultBlocks(results, contextPipeline.toolResultMaxTokens).results;
        const toolMessage: RuntimeMessage = { role: "user", content: trimmedResults };
        messages.push(toolMessage);
        await this.options.store.appendMessage(job.session_id, toolMessage, "tool_results");
      }
      const reply = "本轮已达到最大步骤，请发送下一条消息继续。";
      const terminal: RuntimeMessage = { role: "assistant", content: [{ type: "text", text: reply }] };
      messages.push(terminal);
      await this.options.store.appendMessage(job.session_id, terminal, "assistant_max_steps");
      const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.finish(reply) : false;
      if (job.response_route_id && !streamDelivered) await this.emitBestEffort(this.finalRequest(job, reply), "final");
      await recordUsage("completed");
      return this.outcome("completed", reply, inputTokens, outputTokens, toolCalls);
    } catch (cause) {
      if (isCancelled(handle) || (cause instanceof DOMException && cause.name === "AbortError")) {
        await finalAnswerStreamer?.cancel();
        await recordUsage("cancelled");
        return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
      }
      const message = cause instanceof RuntimeProviderError
        ? cause.userMessage
        : cause instanceof Error ? cause.message : String(cause);
      this.logger.error("turn failed", { session_id: job.session_id, run_id: job.job_id, error: cause });
      const reply = `执行失败: ${message}`;
      await recordUsage("error");
      const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.fail(reply) : false;
      if (job.response_route_id && !streamDelivered) await this.emitBestEffort(this.finalRequest(job, reply), "error");
      return this.outcome("error", reply, inputTokens, outputTokens, toolCalls);
    } finally {
      if (typingStarted) {
        await this.typingBestEffort({
          session_id: job.session_id,
          response_route_id: job.response_route_id,
          operation: "stop",
          emit_id: randomUUID().replaceAll("-", ""),
        }, "stop");
      }
      this.active.delete(handle);
    }
  }

  private async emitBestEffort(request: EmitRequest, phase: string): Promise<boolean> {
    try {
      await this.options.emitter.emit(request);
      return true;
    } catch (error) {
      this.logger.warn("outbound delivery failed", {
        phase,
        session_id: request.session_id,
        response_route_id: request.response_route_id,
        error,
      });
      return false;
    }
  }

  private async typingBestEffort(
    request: Parameters<RuntimeEmitter["typing"]>[0],
    phase: string,
  ): Promise<boolean> {
    try {
      await this.options.emitter.typing(request);
      return true;
    } catch (error) {
      this.logger.warn("typing delivery failed", {
        phase,
        session_id: request.session_id,
        response_route_id: request.response_route_id,
        error,
      });
      return false;
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
      stream_type: "",
      state: "",
      seq: 0,
    };
  }
}

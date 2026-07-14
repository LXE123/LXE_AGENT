import { randomUUID } from "node:crypto";
import type { AgentJob, EmitRequest, JsonObject } from "@lxe/protocol";
import { createLogger, runWithLogContext, type Environment, type Logger } from "@lxe/core";
import { ToolRegistry, type ToolExposureOptions } from "../tooling/registry";
import {
  ContextCompactionError,
  ContextOverflowError,
  ContextPipeline,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateTokens,
  isContextOverflowError,
  trimToolResultBlocks,
  type ContextCompactionResult,
} from "./context";
import { FinalAnswerStreamer } from "./final-answer-streamer";
import { RuntimeProviderError, type RuntimeProviderManager } from "../providers/provider";
import { RuntimeTurnObserver } from "./turn-observer";
import {
  heartbeatPrompt,
  normalizePendingSystemEvents,
  userContentWithSystemEvents,
} from "./system-events";
import type { RuntimeTraceControllerPort, RuntimeWireTraceAttempt } from "../providers/trace";
import type {
  AgentRuntime,
  RuntimeContentBlock,
  RuntimeEmitter,
  RuntimeHandle,
  RuntimeMessage,
  RuntimeProvider,
  RuntimeStore,
  RuntimeStreamEvent,
  SystemPromptContext,
  SkillActivationUsage,
  SkillExecutionUsage,
  RuntimeTurnResponse,
  RuntimeUsage,
  ToolResultBlock,
  ToolCallBlock,
  TurnOutcome,
} from "./types";

export interface TypeScriptAgentRuntimeOptions {
  store: RuntimeStore;
  provider?: RuntimeProvider;
  providerManager?: RuntimeProviderManager;
  traceController?: RuntimeTraceControllerPort;
  tools: ToolRegistry;
  toolExposure?: ToolExposureOptions | (() => ToolExposureOptions);
  resolveSkillMetadata?: (skillName: string) => { module: string } | undefined;
  emitter: RuntimeEmitter;
  systemPrompt: string | ((context: SystemPromptContext) => string);
  maxSteps?: number;
  contextWindowTokens?: number;
  environment?: Environment;
  logger?: Logger;
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

const toolCallBlocks = (content: RuntimeContentBlock[]): ToolCallBlock[] =>
  content.filter((block): block is ToolCallBlock =>
    block.type === "tool_call" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    block.arguments !== null && typeof block.arguments === "object" && !Array.isArray(block.arguments));

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

export const DEFAULT_MAX_STEPS = 50;
export const DEFAULT_PROVIDER_ATTEMPTS = 3;
export const MAX_STEP_REPLY = "本轮已达到最大步骤，请发送下一条消息继续。";

export class TypeScriptAgentRuntime implements AgentRuntime {
  private readonly logger: Logger;
  private readonly active = new Set<RuntimeHandle>();
  private started = false;

  constructor(private readonly options: TypeScriptAgentRuntimeOptions) {
    this.logger = options.logger ?? createLogger("runtime");
  }

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
    return runWithLogContext({
      session_id: job.session_id,
      turn_id: job.job_id,
      response_route_id: job.response_route_id,
      message_id: job.message_id,
    }, () => this.runTurnInContext(job, handle));
  }

  private async runTurnInContext(job: AgentJob, handle: RuntimeHandle): Promise<TurnOutcome> {
    if (!this.started) throw new Error("runtime is not started");
    const session = await this.options.store.getSession(job.session_id);
    if (!session) throw new Error(`session not found: ${job.session_id}`);
    const providerSnapshot = this.options.providerManager?.acquire();
    const provider = providerSnapshot?.provider ?? this.options.provider;
    if (!provider) throw new Error("runtime provider is not configured");
    const skillActivations = new Map<string, SkillActivationUsage>();
    const skillExecutions: SkillExecutionUsage[] = [];
    const skillModule = (name: string): string => this.options.resolveSkillMetadata?.(name)?.module.trim() ?? "";
    const exposureOptions = typeof this.options.toolExposure === "function"
      ? this.options.toolExposure()
      : this.options.toolExposure;
    const toolExposure = this.options.tools.createExposureState({
      ...exposureOptions,
      onSkillActivated: async (name) => {
        skillActivations.set(name, { skill: name, module: skillModule(name) });
        await exposureOptions?.onSkillActivated?.(name);
      },
    });
    const descriptor = providerSnapshot?.descriptor;
    const systemPromptContext: SystemPromptContext = {
      platform: String(session.source.platform ?? "").trim(),
      provider: descriptor?.name ?? "custom",
      model: descriptor?.model ?? this.options.display?.model ?? "",
    };
    const systemPrompt = typeof this.options.systemPrompt === "function"
      ? this.options.systemPrompt(systemPromptContext)
      : this.options.systemPrompt;
    const observer = new RuntimeTurnObserver({
      ...(this.options.environment ? { environment: this.options.environment } : {}),
    });
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
          turnId: job.job_id,
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
    const recordUsage = async (status: TurnOutcome["status"], error?: unknown): Promise<void> => {
      if (usageRecorded) return;
      usageRecorded = true;
      const elapsedMs = Math.max(0, Math.trunc((Date.now() / 1_000 - startedAt) * 1_000));
      try {
        await this.options.store.recordTurn(job.session_id, {
          turn_id: job.job_id,
          started_at: startedAt,
          status,
          elapsed_ms: elapsedMs,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          tool_calls: toolCalls,
          api_calls: apiCalls,
          tools: [...toolUsage.entries()].map(([name, usage]) => ({ name, ...usage })),
          activations: [...skillActivations.values()],
          executions: skillExecutions,
        });
      } catch (cause) {
        this.logger.warn("turn_usage_persist_failed", { error: cause });
      }
      trace?.record("turn_end", {
        status,
        elapsed_ms: elapsedMs,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tool_calls: toolCalls,
        api_calls: apiCalls,
      });
      observer.complete({ status, inputTokens, outputTokens, toolCalls, apiCalls, ...(error === undefined ? {} : { error }) });
    };
    try {
      if (job.job_kind === "turn" && job.response_route_id) {
        typingStarted = await this.typingBestEffort({
          session_id: job.session_id,
          turn_id: job.job_id,
          response_route_id: job.response_route_id,
          operation: "start",
          emit_id: randomUUID().replaceAll("-", ""),
        }, "start");
      }
      const heartbeat = job.job_kind === "heartbeat";
      const pendingEvents = normalizePendingSystemEvents(heartbeat
        ? await this.options.store.popPendingEvents(job.session_id)
        : job.raw_data.system_events);
      if (heartbeat) observer.pendingEvents("popped", pendingEvents.length);
      else if (pendingEvents.length > 0) observer.pendingEvents("attached", pendingEvents.length);
      if (heartbeat && pendingEvents.length === 0) {
        observer.start({
          jobKind: "heartbeat",
          provider: descriptor?.name ?? "custom",
          model: descriptor?.model ?? this.options.display?.model ?? "",
          messageTurns: 0,
          systemTokens: estimateTokens(systemPrompt),
          messageTokens: 0,
          contextCapacity: contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
          pendingEventCount: 0,
        });
        observer.pendingEvents("noop", 0);
        await recordUsage("completed");
        return this.outcome("completed", "", inputTokens, outputTokens, toolCalls);
      }
      let messages = heartbeat ? [] : await this.options.store.loadMessages(job.session_id);
      const userContent: RuntimeMessage["content"] = heartbeat
        ? heartbeatPrompt(pendingEvents)
        : userContentWithSystemEvents(job.user_input, job.user_content_blocks, pendingEvents);
      const userMessage: RuntimeMessage = { role: "user", content: userContent };
      messages.push(userMessage);
      observer.start({
        jobKind: heartbeat ? "heartbeat" : "turn",
        provider: descriptor?.name ?? "custom",
        model: descriptor?.model ?? this.options.display?.model ?? "",
        messageTurns: messages.filter((message) => message.role === "user").length,
        systemTokens: estimateTokens(systemPrompt),
        messageTokens: estimateTokens(messages),
        contextCapacity: contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        pendingEventCount: pendingEvents.length,
      });
      await this.options.store.appendMessage(job.session_id, userMessage, heartbeat ? "heartbeat" : "turn_input");

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

      const maxSteps = Math.max(1, Math.trunc(this.options.maxSteps ?? DEFAULT_MAX_STEPS));
      await finalAnswerStreamer?.startToolPending();
      for (let step = 0; step < maxSteps; step += 1) {
        if (isCancelled(handle)) {
          await finalAnswerStreamer?.cancel();
          await recordUsage("cancelled");
          return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
        }
        await appendSteering();
        const isLastStep = step === maxSteps - 1;
        const toolSchemas = heartbeat || isLastStep ? [] : toolExposure.schemas();
        const prepared = await contextPipeline.prepare({
          sessionId: job.session_id,
          messages,
          systemPrompt,
          toolSchemas,
          signal: handle.signal,
          trigger: "pre_call",
        });
        accountContext(prepared);
        observer.context(prepared);
        messages = prepared.messages;
        if (prepared.failureReason) {
          throw new ContextCompactionError(prepared.failureReason, prepared.afterTokens);
        }
        if (prepared.hardLimitExceeded) {
          throw new ContextOverflowError(prepared.afterTokens, contextPipeline.hardLimitTokens);
        }
        const providerRequest = (
          attemptObserver: ReturnType<RuntimeTurnObserver["providerAttempt"]>,
          wireTrace?: RuntimeWireTraceAttempt,
        ) => ({
          system: systemPrompt,
          messages: structuredClone(messages) as RuntimeMessage[],
          tools: toolSchemas,
          toolChoice: heartbeat || isLastStep ? "none" as const : "auto" as const,
          signal: handle.signal,
          ...(wireTrace ? { wireTrace } : {}),
          onEvent: async (event: RuntimeStreamEvent) => {
            attemptObserver.stream(event);
            trace?.record("stream_event", {
              type: event.type,
              ...(event.type === "text_delta" ? { chars: event.text.length } : {}),
              ...(event.type === "thinking_delta" ? { chars: event.thinking.length } : {}),
            });
            if (!isCancelled(handle)) await finalAnswerStreamer?.pushEvent(event);
          },
        });
        let providerAttemptOrdinal = 0;
        const invokeProvider = async (maximumAttempts = DEFAULT_PROVIDER_ATTEMPTS): Promise<RuntimeTurnResponse> => {
          let lastError: unknown;
          for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            providerAttemptOrdinal += 1;
            apiCalls += 1;
            const attemptObserver = observer.providerAttempt(
              step + 1,
              providerAttemptOrdinal,
              descriptor?.name ?? "custom",
              descriptor?.model ?? this.options.display?.model ?? "",
            );
            trace?.record("provider_attempt", { step: step + 1, attempt: providerAttemptOrdinal });
            const wireTrace = trace?.startProviderAttempt({
              step,
              attempt: providerAttemptOrdinal,
              provider: descriptor?.name ?? "custom",
              model: descriptor?.model ?? this.options.display?.model ?? "",
              endpoint: descriptor ? `${descriptor.baseURL.replace(/\/+$/u, "")}/v1/messages` : "",
              timeoutMs: descriptor?.requestIdleTimeoutMs ?? 0,
            });
            try {
              const response = await provider.turn(providerRequest(attemptObserver, wireTrace));
              attemptObserver.succeed(response);
              return response;
            } catch (error) {
              if (isCancelled(handle) || (error instanceof DOMException && error.name === "AbortError")) {
                attemptObserver.cancel();
                throw error;
              }
              if (isContextOverflowError(error)) {
                attemptObserver.fail(error, false);
                throw error;
              }
              const retryable = error instanceof RuntimeProviderError ? error.retryable : true;
              lastError = error;
              attemptObserver.fail(error, retryable && attempt < maximumAttempts);
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
            systemPrompt,
            toolSchemas,
            signal: handle.signal,
            trigger: "overflow",
          });
          accountContext(overflow);
          observer.context(overflow);
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
        const calls = toolCallBlocks(response.content);
        const forcedLastStepReply = isLastStep && calls.length > 0
          ? textContent(response.content) || MAX_STEP_REPLY
          : "";
        const assistantContent: RuntimeContentBlock[] = forcedLastStepReply
          ? [{ type: "text", text: forcedLastStepReply }]
          : response.content;
        const assistant: RuntimeMessage = { role: "assistant", content: assistantContent };
        messages.push(assistant);
        await this.options.store.appendMessage(job.session_id, assistant, "assistant_response");
        if (calls.length === 0 || isLastStep) {
          const reply = forcedLastStepReply || textContent(response.content);
          const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.finish(reply) : false;
          if (reply && job.response_route_id && !streamDelivered) {
            if (finalAnswerStreamer) await this.emitStreamFallback(job, reply, "final");
            else await this.emitBestEffort(this.finalRequest(job, reply), "final");
          }
          if (!heartbeat && !isCancelled(handle)) {
            try {
              const postTurn = await contextPipeline.postTurn({
                sessionId: job.session_id,
                messages,
                systemPrompt,
                signal: handle.signal,
              });
              accountContext(postTurn);
              observer.context(postTurn);
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
                tool_call_id: pending.id,
                content: "Tool execution skipped because the user steered the active turn before dispatch.",
                is_error: true,
              });
            }
            const steeredTools: RuntimeMessage = { role: "tool", content: results };
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
                tool_call_id: pending.id,
                content: "Tool execution cancelled before dispatch.",
                is_error: true,
              });
            }
            const cancelledTools: RuntimeMessage = { role: "tool", content: results };
            messages.push(cancelledTools);
            await this.options.store.appendMessage(job.session_id, cancelledTools, "tool_results_cancelled");
            await finalAnswerStreamer?.cancel();
            await recordUsage("cancelled");
            return this.outcome("cancelled", "", inputTokens, outputTokens, toolCalls);
          }
          toolCalls += 1;
          const startedToolAt = Date.now();
          const definition = this.options.tools.definition(call.name);
          const invocation = definition?.classifyInvocation?.(call.arguments);
          const usageName = invocation?.usageName || call.name;
          const commandId = invocation?.commandId?.trim() ?? "";
          const usage = toolUsage.get(usageName) ?? { calls: 0, errors: 0, duration_ms: 0 };
          const executionOwners = commandId
            ? [...new Set((invocation?.ownerSkills ?? []).map((name) => name.trim()).filter(Boolean))]
            : [];
          usage.calls += 1;
          toolUsage.set(usageName, usage);
          observer.toolStarted(step + 1, call.name, call.id, commandId || undefined);
          trace?.record("tool_start", { step: step + 1, tool: call.name, tool_use_id: call.id, input: call.arguments });
          await finalAnswerStreamer?.pushToolStart(call);
          let toolStatus: "success" | "error" = "success";
          let toolDisplayOutput: { result?: unknown; error?: unknown } | undefined;
          try {
            const result = await this.options.tools.execute(call.name, call.arguments, {
              handle,
              session_id: job.session_id,
              response_route_id: job.response_route_id,
              turn_id: job.job_id,
              exposureState: toolExposure,
            });
            if (result.state_patch && Object.keys(result.state_patch).length > 0) {
              await this.options.store.patchSessionState(job.session_id, result.state_patch);
            }
            if (result.files?.length && job.response_route_id) {
              await this.options.emitter.emit({
                session_id: job.session_id,
                turn_id: job.job_id,
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
              tool_call_id: call.id,
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
              tool_call_id: call.id,
              content: message,
              is_error: true,
            });
          } finally {
            const durationMs = Date.now() - startedToolAt;
            usage.duration_ms += durationMs;
            for (const skillName of executionOwners) {
              skillExecutions.push({
                skill: skillName,
                module: skillModule(skillName),
                command: commandId,
                success: toolStatus === "success",
                duration_ms: durationMs,
              });
            }
            trace?.record("tool_end", { step: step + 1, tool: call.name, tool_use_id: call.id, status: toolStatus, duration_ms: durationMs });
            observer.toolCompleted(step + 1, call.name, call.id, toolStatus, durationMs, commandId || undefined);
            await finalAnswerStreamer?.pushToolFinish(call, toolStatus, durationMs, toolDisplayOutput);
          }
        }
        if (interruptedBySteering) continue;
        const trimmedResults = trimToolResultBlocks(results, contextPipeline.toolResultMaxTokens).results;
        const toolMessage: RuntimeMessage = { role: "tool", content: trimmedResults };
        messages.push(toolMessage);
        await this.options.store.appendMessage(job.session_id, toolMessage, "tool_results");
      }
      const reply = MAX_STEP_REPLY;
      const terminal: RuntimeMessage = { role: "assistant", content: [{ type: "text", text: reply }] };
      messages.push(terminal);
      await this.options.store.appendMessage(job.session_id, terminal, "assistant_max_steps");
      const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.finish(reply) : false;
      if (job.response_route_id && !streamDelivered) {
        if (finalAnswerStreamer) await this.emitStreamFallback(job, reply, "final");
        else await this.emitBestEffort(this.finalRequest(job, reply), "final");
      }
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
      const reply = `执行失败: ${message}`;
      await recordUsage("error", cause);
      const streamDelivered = finalAnswerStreamer ? await finalAnswerStreamer.fail(reply) : false;
      if (job.response_route_id && !streamDelivered) {
        if (finalAnswerStreamer) await this.emitStreamFallback(job, reply, "error");
        else await this.emitBestEffort(this.finalRequest(job, reply), "error");
      }
      return this.outcome("error", reply, inputTokens, outputTokens, toolCalls);
    } finally {
      if (typingStarted) {
        await this.typingBestEffort({
          session_id: job.session_id,
          turn_id: job.job_id,
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
        turn_id: request.turn_id,
        response_route_id: request.response_route_id,
        emit_id: request.emit_id,
        error,
      });
      return false;
    }
  }

  private async emitStreamFallback(job: AgentJob, content: string, phase: "final" | "error"): Promise<boolean> {
    const request = this.finalRequest(job, content);
    const fields = {
      phase,
      session_id: request.session_id,
      turn_id: request.turn_id,
      response_route_id: request.response_route_id,
      emit_id: request.emit_id,
    };
    this.logger.info("stream_fallback_started", fields);
    try {
      await this.options.emitter.emit(request);
      this.logger.info("stream_fallback_completed", fields);
      return true;
    } catch (error) {
      this.logger.warn("stream_fallback_failed", { ...fields, error });
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
        turn_id: request.turn_id,
        response_route_id: request.response_route_id,
        emit_id: request.emit_id,
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
      turn_id: job.job_id,
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

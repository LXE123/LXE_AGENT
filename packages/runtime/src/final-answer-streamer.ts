import { randomUUID } from "node:crypto";
import type { DisplayMetrics, EmitRequest, ToolStep } from "@lxe/protocol";
import { buildToolDisplayStep } from "./tool-display";
import type { RuntimeStreamEvent, ToolCallBlock } from "./types";

interface StreamSnapshot {
  content: string;
  thinking: string;
  redactedThinkingCount: number;
  thinkingElapsedMs: number;
  toolPending: boolean;
  toolElapsedMs: number;
  toolSteps: ToolStep[];
  displayMetrics: DisplayMetrics;
}

export interface FinalAnswerStreamerOptions {
  sessionId: string;
  turnId: string;
  responseRouteId: string;
  emit(request: EmitRequest): Promise<boolean>;
  emitId?: string;
  minIntervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  model?: string;
  contextWindowTokens?: number;
  toolUseMode?: "off" | "on" | "full";
  showFullPaths?: boolean;
}

const cloneSteps = (steps: ToolStep[]): ToolStep[] => steps.map((step) => ({ ...step }));

export class FinalAnswerStreamer {
  private readonly emitId: string;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private content = "";
  private thinking = "";
  private redactedThinkingCount = 0;
  private thinkingStartedAt = 0;
  private thinkingElapsedMs = 0;
  private toolPending = false;
  private activeToolStartedAt = 0;
  private toolElapsedMs = 0;
  private toolSteps: ToolStep[] = [];
  private lastSent = "";
  private lastSentContent = "";
  private sequence = 0;
  private lastAttemptAt = 0;
  private delivered = false;
  private deltaFailed = false;
  private terminal = false;
  private pending: Promise<void> | undefined;
  private readonly startedAt: number;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadInputTokens = 0;
  private cacheCreationInputTokens = 0;
  private contextTokens = 0;
  private displayStatus: DisplayMetrics["status"] = "running";

  constructor(private readonly options: FinalAnswerStreamerOptions) {
    this.emitId = String(options.emitId ?? "").trim() || randomUUID().replaceAll("-", "");
    this.minIntervalMs = Math.max(0, Math.trunc(options.minIntervalMs ?? 150));
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.startedAt = this.now();
  }

  async pushEvent(event: RuntimeStreamEvent): Promise<void> {
    if (event.type === "text_delta") return this.pushDelta({ text: event.text });
    if (event.type === "thinking_delta") return this.pushDelta({ thinking: event.thinking });
    if (this.terminal) return;
    this.redactedThinkingCount += 1;
    if (!this.content && !this.thinkingStartedAt) this.thinkingStartedAt = this.now();
    this.scheduleDelta();
  }

  updateUsage(usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    const input = Math.max(0, Math.trunc(usage.input_tokens ?? 0));
    const cacheRead = Math.max(0, Math.trunc(usage.cache_read_input_tokens ?? 0));
    const cacheCreation = Math.max(0, Math.trunc(usage.cache_creation_input_tokens ?? 0));
    this.inputTokens += input;
    this.outputTokens += Math.max(0, Math.trunc(usage.output_tokens ?? 0));
    this.cacheReadInputTokens += cacheRead;
    this.cacheCreationInputTokens += cacheCreation;
    this.contextTokens = input + cacheRead + cacheCreation;
  }

  async pushDelta(delta: { text?: string; thinking?: string }): Promise<void> {
    if (this.terminal) return;
    const text = String(delta.text ?? "");
    const thinking = String(delta.thinking ?? "");
    if (thinking && !this.content && !this.thinkingStartedAt) this.thinkingStartedAt = this.now();
    if (text && this.thinkingStartedAt && !this.thinkingElapsedMs) {
      this.thinkingElapsedMs = Math.max(0, this.now() - this.thinkingStartedAt);
    }
    this.content += text;
    this.thinking += thinking;
    this.scheduleDelta();
  }

  async startToolPending(): Promise<void> {
    if (this.terminal || this.toolSteps.length > 0 || this.options.toolUseMode === "off") return;
    this.toolPending = true;
    this.scheduleDelta();
  }

  async pushToolStart(call: ToolCallBlock): Promise<void> {
    if (this.terminal || this.options.toolUseMode === "off") return;
    this.activeToolStartedAt = this.now();
    this.toolPending = false;
    this.upsertTool(buildToolDisplayStep(call.id, call.name, call.arguments, "running", 0));
    this.scheduleDelta();
  }

  async pushToolFinish(
    call: ToolCallBlock,
    status: "success" | "error",
    durationMs: number,
    output?: { result?: unknown; error?: unknown },
  ): Promise<void> {
    if (this.terminal || this.options.toolUseMode === "off") return;
    this.toolPending = false;
    this.toolElapsedMs += Math.max(0, Math.trunc(durationMs));
    this.activeToolStartedAt = 0;
    this.upsertTool(buildToolDisplayStep(call.id, call.name, call.arguments, status, durationMs, {
      ...(this.options.showFullPaths === undefined ? {} : { showFullPaths: this.options.showFullPaths }),
      showResultDetails: this.options.toolUseMode === "full",
      result: output?.result,
      error: output?.error,
    }));
    this.scheduleDelta();
  }

  async finish(content: string): Promise<boolean> {
    const finalContent = String(content ?? "").trim();
    if (finalContent && finalContent.length >= this.content.length) this.content = finalContent;
    this.displayStatus = "completed";
    return this.close("final");
  }

  async fail(content: string): Promise<boolean> {
    if (!this.content) this.content = String(content ?? "").trim();
    this.displayStatus = "error";
    return this.close("error");
  }

  async cancel(): Promise<boolean> {
    this.terminal = true;
    this.displayStatus = "cancelled";
    await this.pending;
    if (!this.delivered) return false;
    this.content = this.lastSentContent;
    return this.emitFrame("final");
  }

  private async close(state: "final" | "error"): Promise<boolean> {
    this.terminal = true;
    this.finishTimers();
    this.finalizeRunningTools();
    await this.pending;
    if (!this.deltaFailed && this.snapshotKey() !== this.lastSent) await this.emitFrame("delta");
    if (this.deltaFailed && !this.delivered) return false;
    return this.emitFrame(state);
  }

  private scheduleDelta(): void {
    if (this.terminal || this.deltaFailed || this.pending || this.snapshotKey() === this.lastSent) return;
    const elapsed = this.lastAttemptAt ? this.now() - this.lastAttemptAt : this.minIntervalMs;
    const waitMs = Math.max(0, this.minIntervalMs - elapsed);
    this.pending = (async () => {
      if (waitMs > 0) await this.delay(waitMs);
      if (!this.terminal && !this.deltaFailed && this.snapshotKey() !== this.lastSent) {
        await this.emitFrame("delta");
      }
    })().finally(() => {
      this.pending = undefined;
      if (!this.terminal && !this.deltaFailed && this.snapshotKey() !== this.lastSent) this.scheduleDelta();
    });
  }

  private async emitFrame(state: "delta" | "final" | "error"): Promise<boolean> {
    const snapshot = this.snapshot();
    const key = JSON.stringify(snapshot);
    this.sequence += 1;
    this.lastAttemptAt = this.now();
    let ok = false;
    try {
      ok = await this.options.emit({
        session_id: this.options.sessionId,
        turn_id: this.options.turnId,
        response_route_id: this.options.responseRouteId,
        content: snapshot.content,
        thinking: snapshot.thinking,
        redacted_thinking_count: snapshot.redactedThinkingCount,
        thinking_elapsed_ms: snapshot.thinkingElapsedMs,
        tool_pending: snapshot.toolPending,
        tool_elapsed_ms: snapshot.toolElapsedMs,
        tool_steps: cloneSteps(snapshot.toolSteps),
        files: [],
        emit_kind: "stream",
        emit_id: this.emitId,
        stream_type: "final_answer",
        state,
        seq: this.sequence,
        display_metrics: { ...snapshot.displayMetrics },
      });
    } catch {
      ok = false;
    }
    if (!ok) {
      if (state === "delta") this.deltaFailed = true;
      return false;
    }
    this.delivered = true;
    this.lastSent = key;
    this.lastSentContent = snapshot.content;
    return true;
  }

  private snapshot(): StreamSnapshot {
    const elapsed = this.toolElapsedMs + (this.activeToolStartedAt ? this.now() - this.activeToolStartedAt : 0);
    return {
      content: this.content,
      thinking: this.thinking,
      redactedThinkingCount: this.redactedThinkingCount,
      thinkingElapsedMs: Math.max(0, Math.trunc(this.thinkingElapsedMs)),
      toolPending: this.toolPending && this.toolSteps.length === 0,
      toolElapsedMs: Math.max(0, Math.trunc(elapsed)),
      toolSteps: cloneSteps(this.toolSteps),
      displayMetrics: {
        status: this.displayStatus,
        elapsed_ms: Math.max(0, Math.trunc(this.now() - this.startedAt)),
        model: String(this.options.model ?? ""),
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        cache_read_input_tokens: this.cacheReadInputTokens,
        cache_creation_input_tokens: this.cacheCreationInputTokens,
        context_tokens: this.contextTokens,
        context_window_tokens: Math.max(0, Math.trunc(this.options.contextWindowTokens ?? 0)),
      },
    };
  }

  private snapshotKey(): string {
    return JSON.stringify(this.snapshot());
  }

  private upsertTool(step: ToolStep): void {
    const index = this.toolSteps.findIndex((current) => current.id && current.id === step.id);
    if (index >= 0) this.toolSteps[index] = step;
    else this.toolSteps.push(step);
  }

  private finishTimers(): void {
    if (this.thinkingStartedAt && !this.thinkingElapsedMs) {
      this.thinkingElapsedMs = Math.max(0, this.now() - this.thinkingStartedAt);
    }
    if (this.activeToolStartedAt) {
      this.toolElapsedMs += Math.max(0, this.now() - this.activeToolStartedAt);
      this.activeToolStartedAt = 0;
    }
    this.toolPending = false;
  }

  private finalizeRunningTools(): void {
    this.toolSteps = this.toolSteps.map((step) => step.status === "running"
      ? { ...step, status: "error", duration_ms: Math.max(step.duration_ms, this.toolElapsedMs) }
      : step);
  }
}

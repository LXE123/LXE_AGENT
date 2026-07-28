import type { EmitRequest, JsonObject, ToolStep } from "@lxe/protocol";
import { sanitizeLogValueWithPolicy } from "@lxe/core";

export const EXEC_EVENT_VERSION = 1 as const;

export interface ExecUsage extends JsonObject {
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
}

export type ExecItem =
  | {
      id: string;
      type: "agent_message";
      text: string;
      status: "in_progress" | "completed" | "error";
      sequence: number;
    }
  | {
      id: string;
      type: "tool";
      name: string;
      title: string;
      detail: string;
      status: ToolStep["status"];
      duration_ms: number;
      result?: JsonObject;
      error?: JsonObject;
    }
  | {
      id: string;
      type: "file";
      path: string;
    }
  | {
      id: string;
      type: "progress";
      text: string;
    };

type ThreadEvent = {
  version: typeof EXEC_EVENT_VERSION;
  type: "thread.started";
  thread_id: string;
};

type TurnEvent = {
  version: typeof EXEC_EVENT_VERSION;
  type: "turn.started";
  thread_id: string;
  turn_id: string;
};

type ItemEvent = {
  version: typeof EXEC_EVENT_VERSION;
  type: "item.updated" | "item.completed";
  thread_id: string;
  turn_id: string;
  item: ExecItem;
};

type TurnCompletedEvent = {
  version: typeof EXEC_EVENT_VERSION;
  type: "turn.completed";
  thread_id: string;
  turn_id: string;
  usage: ExecUsage;
};

type PublicError = {
  code: string;
  message: string;
};

type TurnFailedEvent = {
  version: typeof EXEC_EVENT_VERSION;
  type: "turn.failed";
  thread_id: string;
  turn_id: string;
  error: PublicError;
  usage: ExecUsage;
};

type ErrorEvent = {
  version: typeof EXEC_EVENT_VERSION;
  type: "error";
  error: PublicError;
};

export type ExecEventV1 =
  | ThreadEvent
  | TurnEvent
  | ItemEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ErrorEvent;

export type TextWriter = (text: string) => void | Promise<void>;

const errorCode = (cause: unknown): string => {
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
    if (cause instanceof Error && cause.name.trim()) return cause.name.trim();
  }
  return "AgentCliError";
};

export const publicError = (cause: unknown): PublicError => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const sanitized = sanitizeLogValueWithPolicy(error, {
    maxDepth: 3,
    maxItems: 20,
    maxString: 4_000,
    maxStackString: 4_000,
  });
  const message = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? String((sanitized as Record<string, unknown>).message ?? error.message)
    : error.message;
  return { code: errorCode(cause), message };
};

const usagePayload = (usage: ExecUsage): ExecUsage => ({
  input_tokens: Math.max(0, Math.trunc(usage.input_tokens)),
  output_tokens: Math.max(0, Math.trunc(usage.output_tokens)),
  tool_calls: Math.max(0, Math.trunc(usage.tool_calls)),
});

export class ExecReporter {
  private writes = Promise.resolve();
  private readonly toolStatuses = new Map<string, ToolStep["status"]>();
  private readonly reportedFiles = new Set<string>();
  private finalItemReported = false;

  constructor(
    private readonly json: boolean,
    private readonly stdout: TextWriter,
    private readonly stderr: TextWriter,
  ) {}

  threadStarted(threadId: string): Promise<void> {
    if (!this.json) return this.writeError(`thread ${threadId}\n`);
    return this.event({ version: EXEC_EVENT_VERSION, type: "thread.started", thread_id: threadId });
  }

  turnStarted(threadId: string, turnId: string): Promise<void> {
    if (!this.json) return Promise.resolve();
    return this.event({
      version: EXEC_EVENT_VERSION,
      type: "turn.started",
      thread_id: threadId,
      turn_id: turnId,
    });
  }

  async emit(request: EmitRequest): Promise<void> {
    for (const step of request.tool_steps) await this.toolEvent(request, step);
    for (const path of request.files) {
      if (this.reportedFiles.has(path)) continue;
      this.reportedFiles.add(path);
      await this.item(request, "item.completed", {
        id: `${request.emit_id}:file:${path}`,
        type: "file",
        path,
      });
    }
    if (request.emit_kind === "stream") {
      const terminal = request.state === "final" || request.state === "error";
      await this.item(request, terminal ? "item.completed" : "item.updated", {
        id: request.emit_id,
        type: "agent_message",
        text: request.content,
        status: request.state === "error" ? "error" : terminal ? "completed" : "in_progress",
        sequence: request.seq,
      });
      if (terminal) this.finalItemReported = true;
      return;
    }
    if (request.emit_kind === "final") {
      await this.item(request, "item.completed", {
        id: request.emit_id,
        type: "agent_message",
        text: request.content,
        status: "completed",
        sequence: 0,
      });
      this.finalItemReported = true;
      return;
    }
    if (request.content.trim()) {
      await this.item(request, "item.completed", {
        id: request.emit_id,
        type: "progress",
        text: request.content,
      });
    }
  }

  async ensureFinalItem(threadId: string, turnId: string, text: string): Promise<void> {
    if (!this.json || this.finalItemReported) return;
    await this.event({
      version: EXEC_EVENT_VERSION,
      type: "item.completed",
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: `${turnId}:final`,
        type: "agent_message",
        text,
        status: "completed",
        sequence: 0,
      },
    });
    this.finalItemReported = true;
  }

  turnCompleted(threadId: string, turnId: string, usage: ExecUsage): Promise<void> {
    if (!this.json) return Promise.resolve();
    return this.event({
      version: EXEC_EVENT_VERSION,
      type: "turn.completed",
      thread_id: threadId,
      turn_id: turnId,
      usage: usagePayload(usage),
    });
  }

  turnFailed(threadId: string, turnId: string, cause: unknown, usage: ExecUsage): Promise<void> {
    if (!this.json) return this.writeError(`${publicError(cause).message}\n`);
    return this.event({
      version: EXEC_EVENT_VERSION,
      type: "turn.failed",
      thread_id: threadId,
      turn_id: turnId,
      error: publicError(cause),
      usage: usagePayload(usage),
    });
  }

  error(cause: unknown): Promise<void> {
    const error = publicError(cause);
    if (!this.json) return this.writeError(`${error.message}\n`);
    return this.event({ version: EXEC_EVENT_VERSION, type: "error", error });
  }

  finalMessage(text: string): Promise<void> {
    if (this.json) return Promise.resolve();
    return this.writeOutput(`${text}${text.endsWith("\n") ? "" : "\n"}`);
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private async toolEvent(request: EmitRequest, step: ToolStep): Promise<void> {
    const previous = this.toolStatuses.get(step.id);
    if (previous === step.status) return;
    this.toolStatuses.set(step.id, step.status);
    if (!this.json) {
      await this.writeError(`[tool] ${step.title || step.name}: ${step.status}\n`);
      return;
    }
    await this.item(request, step.status === "running" ? "item.updated" : "item.completed", {
      id: step.id,
      type: "tool",
      name: step.name,
      title: step.title,
      detail: step.detail,
      status: step.status,
      duration_ms: step.duration_ms,
      ...(step.result_block ? { result: step.result_block } : {}),
      ...(step.error_block ? { error: step.error_block } : {}),
    });
  }

  private item(
    request: EmitRequest,
    type: ItemEvent["type"],
    item: ExecItem,
  ): Promise<void> {
    if (!this.json) return Promise.resolve();
    return this.event({
      version: EXEC_EVENT_VERSION,
      type,
      thread_id: request.session_id,
      turn_id: request.turn_id,
      item,
    });
  }

  private event(event: ExecEventV1): Promise<void> {
    return this.writeOutput(`${JSON.stringify(event)}\n`);
  }

  private writeOutput(text: string): Promise<void> {
    return this.enqueue(this.stdout, text);
  }

  private writeError(text: string): Promise<void> {
    return this.enqueue(this.stderr, text);
  }

  private enqueue(writer: TextWriter, value: string): Promise<void> {
    this.writes = this.writes.then(() => writer(value));
    return this.writes;
  }
}

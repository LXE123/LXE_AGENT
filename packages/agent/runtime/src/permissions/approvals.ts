import { randomUUID } from "node:crypto";
import type { ApprovalDecision, JsonObject, PendingApproval, PermissionMode } from "@lxe/protocol";
import { ToolExecutionError, type ToolDefinition } from "../tooling/registry";
import type { ExecutionPolicy } from "./policy";

type CallContext = Parameters<ToolDefinition["execute"]>[1];
const failure = (message: string) => new ToolExecutionError("permission_denied", message);
const ranks: Record<PermissionMode, number> = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
export const permissionInputProperties = {
  sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"], description: "Explicitly request the smallest sufficient wider permission for this invocation only. Pair with justification. Omit to use the current session mode; never request a lower mode." },
  justification: { type: "string", minLength: 1, pattern: "\\S", description: "Reason shown to the user for this exact operation; required with sandbox_permissions." },
};
export const permissionToolDescription = " Follows the current local file permission mode. For an operation requiring broader file access, explicitly set sandbox_permissions and justification to request approval once, only when the environment reports a desktop approval channel. Choose the smallest sufficient mode. Approval never changes the session mode; a rejected or failed operation is not automatically retried.";

export function requestedPolicy(input: JsonObject, policy: ExecutionPolicy): ExecutionPolicy {
  const mode = input.sandbox_permissions;
  if (mode === undefined && input.justification === undefined) return policy;
  if ((mode !== "workspace-write" && mode !== "danger-full-access") || typeof input.justification !== "string" || !input.justification.trim()) {
    throw new ToolExecutionError("invalid_argument", "sandbox_permissions (workspace-write or danger-full-access) and a non-empty justification must be supplied together");
  }
  if (ranks[mode] < ranks[policy.mode]) throw new ToolExecutionError("invalid_argument", "sandbox_permissions cannot reduce the invocation's permission mode");
  return mode === policy.mode ? policy : Object.freeze({ ...policy, mode });
}

interface Pending {
  request: PendingApproval;
  signal: AbortSignal;
  resolve(): void;
  reject(error: Error): void;
  dispose(): void;
}

/** Only live calls own authority. Transcript records are audit data, never executable grants. */
export class PermissionApprovalService {
  private readonly pending = new Map<string, Pending>();
  private readonly decisions = new Map<string, { sessionId: string; decision: ApprovalDecision["decision"]; signal: AbortSignal; result: Promise<{ accepted: true; request_id: string }> }>();
  private readonly auditWrites = new Set<Promise<void>>();
  private closed = false;
  private readonly closedSessions = new Set<string>();
  constructor(private readonly options: {
    changed(sessionId: string): void;
    audit(sessionId: string, event: JsonObject): Promise<void>;
  }) {}

  snapshot(): PendingApproval[] { return [...this.pending.values()].map(entry => structuredClone(entry.request)); }

  async request(tool: PendingApproval["tool"], input: JsonObject, context: CallContext, policy: ExecutionPolicy, preview: JsonObject): Promise<void> {
    if (context.platform !== "desktop") throw failure("Single-operation approval is unavailable on this channel; this operation was not authorized");
    const signal = context.signal ? AbortSignal.any([context.handle.signal, context.signal]) : context.handle.signal;
    signal.throwIfAborted();
    if (this.closed || this.closedSessions.has(context.session_id) || !context.turn_id || !context.tool_call_id) throw failure("Approval requires a live session, turn and tool call");
    const request: PendingApproval = {
      request_id: randomUUID(), session_id: context.session_id, turn_id: context.turn_id, tool_call_id: context.tool_call_id,
      tool, target_mode: policy.mode as PendingApproval["target_mode"], justification: String(input.justification).trim(),
      arguments: structuredClone(input), preview: structuredClone(preview),
    };
    await this.audit(request, "requested");
    signal.throwIfAborted();
    if (this.closed || this.closedSessions.has(context.session_id)) throw failure("Approval cancelled because its session or runtime closed");
    return new Promise<void>((resolve, reject) => {
      const abort = () => this.cancel(request.request_id);
      this.pending.set(request.request_id, { request, signal, resolve, reject, dispose: () => signal.removeEventListener("abort", abort) });
      signal.addEventListener("abort", abort, { once: true });
      this.options.changed(request.session_id);
    });
  }

  decide(input: ApprovalDecision): Promise<{ accepted: true; request_id: string }> {
    if (input.decision !== "allow" && input.decision !== "deny") throw failure("Approval decision must be allow or deny");
    const previous = this.decisions.get(input.request_id);
    if (previous) {
      if (previous.sessionId !== input.session_id || previous.signal.aborted) throw failure("Approval is expired or belongs to another session");
      if (previous.decision !== input.decision) throw failure("Approval already received a different decision");
      return previous.result;
    }
    const entry = this.pending.get(input.request_id);
    if (!entry || entry.request.session_id !== input.session_id || entry.signal.aborted) throw failure("Approval is no longer pending for this session; it may have been cancelled or the runtime restarted");
    const result = this.acceptDecision(entry, input);
    this.decisions.set(input.request_id, { sessionId: input.session_id, decision: input.decision, signal: entry.signal, result });
    if (this.decisions.size > 1000) this.decisions.delete(this.decisions.keys().next().value!);
    return result;
  }

  private async acceptDecision(entry: Pending, input: ApprovalDecision): Promise<{ accepted: true; request_id: string }> {
    try {
      await this.audit(entry.request, input.decision);
      if (!this.pending.has(input.request_id) || entry.signal.aborted) throw failure("Approval expired before the decision was committed");
      this.pending.delete(input.request_id);
      entry.dispose();
      if (input.decision === "allow") entry.resolve();
      else entry.reject(failure("User denied this single-operation permission request"));
      this.options.changed(input.session_id);
      return { accepted: true, request_id: input.request_id };
    } catch (error) {
      this.pending.delete(input.request_id);
      entry.dispose();
      entry.reject(error instanceof Error ? error : new Error(String(error)));
      this.options.changed(input.session_id);
      throw error;
    }
  }

  private audit(request: PendingApproval, decision: string): Promise<void> {
    const write = this.options.audit(request.session_id, {
      kind: "permission_approval", request_id: request.request_id, turn_id: request.turn_id,
      decision, created_at: new Date().toISOString(), ...(decision === "requested" ? { request: structuredClone(request) as unknown as JsonObject } : {}),
    });
    this.auditWrites.add(write);
    void write.then(() => this.auditWrites.delete(write), () => this.auditWrites.delete(write));
    return write;
  }

  private cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.dispose();
    // Cancellation remains effective even if recording its audit event fails.
    const recorded = this.audit(entry.request, "cancelled");
    void recorded.then(() => entry.reject(failure("Approval cancelled before execution")), error => entry.reject(error));
    this.options.changed(entry.request.session_id);
  }
  async forgetSession(sessionId: string): Promise<void> {
    this.closedSessions.add(sessionId);
    for (const [id, entry] of this.pending) if (entry.request.session_id === sessionId) this.cancel(id);
    for (const [id, entry] of this.decisions) if (entry.sessionId === sessionId) this.decisions.delete(id);
    await Promise.all([...this.auditWrites]);
  }
  async stop(): Promise<void> {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.cancel(id);
    await Promise.all([...this.auditWrites]);
    this.decisions.clear();
  }
}

export async function approveIfNeeded(service: PermissionApprovalService | undefined, tool: PendingApproval["tool"], input: JsonObject, context: CallContext, policy: ExecutionPolicy, preview: JsonObject): Promise<void> {
  if (policy.mode === context.executionPolicy.mode) return;
  if (!service) throw failure("Single-operation approval is unavailable; this operation was not authorized");
  await service.request(tool, input, context, policy, preview);
  context.handle.signal.throwIfAborted();
}

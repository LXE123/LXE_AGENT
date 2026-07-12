import type { AgentJob, EmitRequest, JsonObject, JsonValue } from "@lxe/protocol";
import type { RuntimeWireTraceAttempt } from "./trace";

export interface TextBlock extends JsonObject {
  type: "text";
  text: string;
}

export interface ToolUseBlock extends JsonObject {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonObject;
}

export interface ToolResultBlock extends JsonObject {
  type: "tool_result";
  tool_use_id: string;
  content: string | JsonObject[];
  is_error?: boolean;
}

export type RuntimeContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | JsonObject;

export type RuntimeStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "redacted_thinking" };

export interface RuntimeMessage {
  role: "user" | "assistant";
  content: string | RuntimeContentBlock[];
}

export interface RuntimeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface RuntimeTurnResponse {
  content: RuntimeContentBlock[];
  stop_reason: string;
  usage: RuntimeUsage;
}

export interface RuntimeSummaryRequest {
  messages: RuntimeMessage[];
  signal: AbortSignal;
  kind: "history" | "midturn";
}

export interface RuntimeSummaryResult {
  text: string;
  usage: RuntimeUsage;
}

export interface RuntimeProviderRequest {
  system: string;
  messages: RuntimeMessage[];
  tools: ToolSchema[];
  toolChoice: "auto" | "none";
  signal: AbortSignal;
  onEvent?: (event: RuntimeStreamEvent) => Promise<void> | void;
  wireTrace?: RuntimeWireTraceAttempt;
}

export interface RuntimeProvider {
  turn(request: RuntimeProviderRequest): Promise<RuntimeTurnResponse>;
  summarize(request: RuntimeSummaryRequest): Promise<RuntimeSummaryResult>;
}

export interface RuntimeHandle {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  drainSteering(): Array<{ text: string; response_route_id?: string; message_id?: string }>;
  registerProcess(process: { kill(): void | Promise<void>; forceKill(): void | Promise<void> }): () => void;
}

export interface RuntimeSessionRecord {
  session_id: string;
  source: JsonObject;
}

export interface ToolTurnUsage extends JsonObject {
  name: string;
  calls: number;
  errors: number;
  duration_ms: number;
}

export interface SkillActivationUsage extends JsonObject {
  skill: string;
  module: string;
}

export interface SkillExecutionUsage extends JsonObject {
  skill: string;
  module: string;
  command: string;
  success: boolean;
  duration_ms: number;
}

export interface RuntimeTurnUsageRecord extends JsonObject {
  turn_id: string;
  started_at: number;
  status: string;
  elapsed_ms: number;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  api_calls: number;
  tools: ToolTurnUsage[];
  activations: SkillActivationUsage[];
  executions: SkillExecutionUsage[];
}

export interface RuntimeStore {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSession(sessionId: string): Promise<RuntimeSessionRecord | undefined>;
  popPendingEvents(sessionId: string): Promise<JsonObject[]>;
  loadMessages(sessionId: string): Promise<RuntimeMessage[]>;
  appendMessage(sessionId: string, message: RuntimeMessage, reason?: string): Promise<void>;
  replaceMessages(
    sessionId: string,
    messages: RuntimeMessage[],
    replacementKind: "compaction" | "repair" | "history_limit" | "context_replacement",
    metadata?: JsonObject,
  ): Promise<void>;
  patchSessionState(sessionId: string, patch: JsonObject): Promise<void>;
  recordTurn(sessionId: string, metrics: RuntimeTurnUsageRecord): Promise<void>;
}

export interface SystemPromptContext {
  platform: string;
  provider: string;
  model: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: JsonObject;
}

export interface ToolExecutionResult {
  content: JsonObject[];
  state_patch?: JsonObject;
  files?: string[];
}

export interface RuntimeEmitter {
  emit(request: EmitRequest): Promise<void>;
  typing(request: {
    session_id: string;
    turn_id: string;
    response_route_id: string;
    operation: "start" | "stop";
    emit_id: string;
  }): Promise<void>;
}

export interface TurnOutcome {
  status: "completed" | "cancelled" | "error";
  reply: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
}

export interface AgentRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  runTurn(job: AgentJob, handle: RuntimeHandle): Promise<TurnOutcome>;
}

export const objectValue = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

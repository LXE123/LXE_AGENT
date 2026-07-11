import type { AgentJob, EmitRequest, JsonObject, JsonValue } from "@lxe/protocol";

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

export interface RuntimeMessage {
  role: "user" | "assistant";
  content: string | RuntimeContentBlock[];
}

export interface RuntimeTurnResponse {
  content: RuntimeContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface RuntimeProviderRequest {
  system: string;
  messages: RuntimeMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
}

export interface RuntimeProvider {
  turn(request: RuntimeProviderRequest): Promise<RuntimeTurnResponse>;
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

export interface RuntimeStore {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSession(sessionId: string): Promise<RuntimeSessionRecord | undefined>;
  loadMessages(sessionId: string): Promise<RuntimeMessage[]>;
  appendMessage(sessionId: string, message: RuntimeMessage, reason?: string): Promise<void>;
  recordTurn(sessionId: string, metrics: JsonObject): Promise<void>;
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

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface InboundEvent {
  platform: string;
  event_type: string;
  user_input: string;
  user_id: string;
  conversation_id: string;
  is_group: boolean;
  message_id: string;
  sender_nick: string;
  response_route_id: string;
  union_id: string;
  source: JsonObject;
  raw_data: JsonObject;
  user_content_blocks: JsonObject[];
}

export interface AgentJob {
  job_id: string;
  session_id: string;
  session_key: string;
  response_route_id: string;
  user_id: string;
  conversation_id: string;
  is_group: boolean;
  message_id: string;
  user_input: string;
  job_kind: string;
  sender_nick: string;
  source: JsonObject;
  raw_data: JsonObject;
  user_content_blocks: JsonObject[];
}

export type ToolStepStatus = "running" | "success" | "error";

export interface ToolDisplayBlock extends JsonObject {
  language: "json" | "text";
  content: string;
}

export interface ToolStep {
  id: string;
  name: string;
  title: string;
  detail: string;
  icon_token: string;
  status: ToolStepStatus;
  duration_ms: number;
  result_block?: ToolDisplayBlock;
  error_block?: ToolDisplayBlock;
}

export type TurnDisplayStatus = "running" | "completed" | "error" | "cancelled";

export interface DisplayMetrics extends JsonObject {
  status: TurnDisplayStatus;
  elapsed_ms: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  context_tokens: number;
  context_window_tokens: number;
}

interface EmitRequestPayload {
  session_id: string;
  response_route_id: string;
  content: string;
  thinking: string;
  redacted_thinking_count: number;
  thinking_elapsed_ms: number;
  tool_pending: boolean;
  tool_elapsed_ms: number;
  tool_steps: ToolStep[];
  files: string[];
  emit_id: string;
}

export type EmitRequest = EmitRequestPayload & (
  | {
      emit_kind: "stream";
      stream_type: "final_answer";
      state: "delta" | "final" | "error";
      seq: number;
      display_metrics: DisplayMetrics;
    }
  | {
      emit_kind: "final" | "tool" | "progress";
      stream_type: "";
      state: "";
      seq: 0;
      display_metrics?: never;
    }
);

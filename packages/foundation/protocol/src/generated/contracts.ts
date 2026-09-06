/** Generated from protocol/schemas. DO NOT EDIT. Run bun run protocol:generate.
 * Schema SHA-256: 76a5ab0c9e784ea75082c34d79449c3113a38299fc300be5483e011275bfcda0
 */

export type ProtocolContracts = AgentJob | EmitRequest | DesktopStreamBatchRequest;
export type AgentJob = {
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
  workspace: WorkspaceContext;
  source: JsonObject;
  raw_data: JsonObject;
  user_content_blocks: JsonObject[];
  /**
   * @maxItems 16
   */
  diagnostics: AgentDiagnostic[];
};
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonPrimitive = boolean | number | string | null;
export type AgentDiagnostic = {
  type: "operation_failure";
  provider: string;
  operation: string;
  stage: string;
  error_name: string;
  observed_error: string;
  redacted: boolean;
  truncated: boolean;
  cause_known: boolean;
  verified_reason?: string;
  mapping_id?: string;
  http_status?: number;
  provider_code?: number | string;
  provider_subcode?: number | string;
  log_id?: string;
  endpoint?: string;
};
export type EmitRequest = {
  session_id: string;
  turn_id: string;
  response_route_id: string;
  content: string;
  thinking: string;
  redacted_thinking_count: number;
  thinking_elapsed_ms: number;
  tool_pending: boolean;
  tool_elapsed_ms: number;
  tool_steps: ToolStep[];
  process_parts?: TurnProcessPart[];
  files: string[];
  emit_kind: "final" | "tool" | "progress" | "stream";
  emit_id: string;
  stream_type: string;
  state: string;
  seq: number;
  display_metrics?: DisplayMetrics;
} & (
  | {
      display_metrics: DisplayMetrics;
      process_parts: TurnProcessPart[];
      stream_type: "final_answer";
      state: "delta" | "final" | "error";
      seq: number;
      emit_kind: "stream";
    }
  | {
      display_metrics?: never;
      process_parts?: never;
      stream_type: "";
      state: "";
      seq: 0;
      emit_kind: "final" | "tool" | "progress";
    }
);
export type ToolStepStatus = "running" | "success" | "error";
export type TurnProcessPart =
  | {
      type: "thinking";
      part_id: string;
      sequence: number;
      status: "streaming" | "completed" | "error";
      text: string;
      redacted_count: number;
    }
  | {
      type: "text";
      part_id: string;
      sequence: number;
      status: "streaming" | "completed" | "error";
      presentation: "process" | "final";
      text: string;
    }
  | {
      type: "tool";
      part_id: string;
      sequence: number;
      tool_step: ToolStep;
    };
export type TurnDisplayStatus = "running" | "completed" | "error" | "cancelled";
export type TurnDisplayPhase =
  "preparing_context" | "waiting_model" | "thinking" | "running_tool" | "generating_answer";
export type DesktopStreamMutation =
  | {
      kind: "part_updated";
      part: TurnProcessPart;
    }
  | {
      kind: "part_delta";
      part_id: string;
      field: "text";
      delta: string;
    }
  | {
      kind: "stream_updated";
      state: "delta" | "final" | "error";
      display_metrics: DisplayMetrics;
    };

export type WorkspaceContext = {
  directory: string;
  worktree: string;
};
export type JsonObject = {
  [k: string]: JsonValue;
};
export type ToolStep = {
  id: string;
  name: string;
  title: string;
  detail: string;
  icon_token: string;
  status: ToolStepStatus;
  duration_ms: number;
  result_block?: ToolDisplayBlock;
  error_block?: ToolDisplayBlock;
};
export type ToolDisplayBlock = {
  language: "json" | "text";
  content: string;
};
export type DisplayMetrics = {
  status: TurnDisplayStatus;
  phase: TurnDisplayPhase;
  elapsed_ms: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  context_tokens: number;
  context_source?: "estimated" | "usage_calibrated";
  context_window_tokens: number;
};
export type DesktopStreamBatchRequest = {
  session_id: string;
  turn_id: string;
  response_route_id: string;
  emit_id: string;
  seq: number;
  /**
   * @minItems 1
   */
  mutations: DesktopStreamMutation[];
};

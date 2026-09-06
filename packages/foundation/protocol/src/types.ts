import type { AgentDiagnostic, JsonObject, WorkspaceContext } from "./generated/contracts";

export type * from "./generated/contracts";

export interface SessionWorkspaceRequest {
  session_id: string;
  source: JsonObject;
  workspace: WorkspaceContext;
  entry_text?: string;
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
  diagnostics: AgentDiagnostic[];
}

export type PendingSystemEvent = JsonObject & {
  event_id: string;
  job_id: string;
  created_at: number;
  text: string;
  response_route_id?: string;
};

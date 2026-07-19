import type { AgentDiagnostic, JsonObject } from "@lxe/protocol";

export interface SessionContext {
  platform: string;
  user_input: string;
  user_id: string;
  response_route_id: string;
  conversation_id: string;
  is_group: boolean;
  message_id: string;
  sender_nick: string;
  session_key: string;
  source: JsonObject;
  raw_data: JsonObject;
  user_content_blocks: JsonObject[];
  diagnostics: AgentDiagnostic[];
}

export interface RouteDecision {
  route_kind: "permission_denied" | "agent_control" | "agent_steer" | "agent_message";
  platform: string;
}

export interface OutboundRequest {
  action: string;
  platform: string;
  payload: JsonObject;
  session_id: string;
  turn_id: string;
  response_route_id: string;
  event_id: string;
}

export interface ResponseRouteRecord {
  response_route_id: string;
  owner_user_id: string;
  platform: string;
  platform_message_id: string | null;
  conversation_id: string | null;
  conversation_type: string | null;
  sender_nick: string | null;
  extra_data: JsonObject;
  created_at: string | null;
  updated_at: string | null;
}

export interface ResponseRoutePatch {
  patch?: JsonObject;
  deliveryHandle?: {
    platform?: string;
    platform_message_id?: string;
  };
}

export const responseRoutePayload = (context: SessionContext): JsonObject => ({
  platform: context.platform,
  user_input: context.user_input,
  user_id: context.user_id,
  response_route_id: context.response_route_id,
  conversation_id: context.conversation_id,
  conversation_type: context.is_group ? "2" : "1",
  is_group: context.is_group,
  message_id: context.message_id,
  sender_nick: context.sender_nick,
  session_key: context.session_key,
  source: { ...context.source },
  raw_data: { ...context.raw_data },
  extra_data: { platform: context.platform },
});

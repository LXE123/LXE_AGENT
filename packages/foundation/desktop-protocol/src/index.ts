import type { AgentJob, EmitRequest, JsonObject, JsonValue } from "@lxe/protocol";

export const AGENT_PROTOCOL_VERSION = 1 as const;

export type AgentInitializePayload = {
  resource_root: string;
  data_root: string;
  workspace_root: string;
  allowed_skill_types?: string[];
};

export type DashboardRequestPayload = {
  method: "GET" | "PATCH";
  path: string;
  body?: JsonObject;
};

export type AgentCommandPayloads = {
  initialize: AgentInitializePayload;
  run_turn: { job: AgentJob };
  cancel_turn: { run_id: string };
  steer_turn: {
    run_id: string;
    text: string;
    response_route_id: string;
    message_id: string;
  };
  ensure_session: { request: JsonObject };
  rebind_session: { request: JsonObject };
  pop_pending_events: { session_id: string };
  append_pending_event: { session_id: string; event: JsonObject };
  has_pending_events: { session_id: string };
  dashboard_request: DashboardRequestPayload;
  health: Record<string, never>;
  shutdown: Record<string, never>;
};

export type AgentCommand = keyof AgentCommandPayloads;

export type AgentRequest<C extends AgentCommand = AgentCommand> = C extends AgentCommand
  ? {
      version: typeof AGENT_PROTOCOL_VERSION;
      id: string;
      command: C;
      payload: AgentCommandPayloads[C];
    }
  : never;

export type AgentSuccessResponse = {
  version: typeof AGENT_PROTOCOL_VERSION;
  id: string;
  ok: true;
  result: JsonValue;
};

export type AgentErrorResponse = {
  version: typeof AGENT_PROTOCOL_VERSION;
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type AgentResponse = AgentSuccessResponse | AgentErrorResponse;

export type AgentEvent =
  | {
      version: typeof AGENT_PROTOCOL_VERSION;
      type: "item.completed";
      thread_id: string;
      turn_id: string;
      payload: EmitRequest;
    }
  | {
      version: typeof AGENT_PROTOCOL_VERSION;
      type: "typing.changed";
      thread_id: string;
      turn_id: string;
      payload: {
        session_id: string;
        turn_id: string;
        response_route_id: string;
        operation: "start" | "stop";
        emit_id: string;
      };
    }
  | {
      version: typeof AGENT_PROTOCOL_VERSION;
      type: "agent.wake";
      payload: JsonObject;
    }
  | {
      version: typeof AGENT_PROTOCOL_VERSION;
      type: "system.ready" | "system.status";
      payload: JsonObject;
    }
  | {
      version: typeof AGENT_PROTOCOL_VERSION;
      type: "thread.started";
      thread_id: string;
      payload: JsonObject;
    }
  | {
      version: typeof AGENT_PROTOCOL_VERSION;
      type: "turn.started" | "turn.completed" | "turn.failed";
      thread_id: string;
      turn_id: string;
      payload: JsonObject;
    };

export type AgentWireMessage = AgentRequest | AgentResponse | AgentEvent;

export type DashboardTransportRequest = DashboardRequestPayload;

export interface DashboardTransport {
  request<T = JsonValue>(request: DashboardTransportRequest): Promise<T>;
}

export type DesktopComponentState = "stopped" | "starting" | "ready" | "error";

export type DesktopPlatform = "win32" | "darwin" | "linux";

export interface DesktopHealth {
  gateway: DesktopComponentState;
  agent_cli: DesktopComponentState;
  lxeskill: DesktopComponentState;
  message: string;
  version: string;
  resource_root: string;
  data_root: string;
  workspace_root: string;
}

export interface DesktopSetupState {
  complete: boolean;
  provider: string;
  provider_key_configured: boolean;
  workspace_root: string;
  feishu_configured: boolean;
  feishu_app_id_masked: string;
}

export interface DesktopSetupInput {
  provider: "kimi_coding" | "deepseek" | "glm";
  api_key?: string;
  workspace_root: string;
  feishu_app_id?: string;
  feishu_app_secret?: string;
}

export interface LxeDesktopBridge {
  dashboard: DashboardTransport;
  desktop: {
    readonly platform: DesktopPlatform;
    selectWorkspace(): Promise<string | null>;
    getHealth(): Promise<DesktopHealth>;
    restartAgent(): Promise<DesktopHealth>;
    getSetupState(): Promise<DesktopSetupState>;
    saveSetup(input: DesktopSetupInput): Promise<DesktopSetupState>;
    onStatusChanged(listener: (health: DesktopHealth) => void): () => void;
  };
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const agentCommands = new Set<AgentCommand>([
  "initialize",
  "run_turn",
  "cancel_turn",
  "steer_turn",
  "ensure_session",
  "rebind_session",
  "pop_pending_events",
  "append_pending_event",
  "has_pending_events",
  "dashboard_request",
  "health",
  "shutdown",
]);
const agentEventTypes = new Set<AgentEvent["type"]>([
  "item.completed",
  "typing.changed",
  "agent.wake",
  "system.ready",
  "system.status",
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
]);

const isAgentCommand = (value: string): value is AgentCommand =>
  agentCommands.has(value as AgentCommand);

const validateRequestPayload = (command: AgentCommand, payload: Record<string, unknown>): void => {
  const requireText = (name: string): void => {
    if (typeof payload[name] !== "string" || !payload[name].trim()) {
      throw new Error(`agent protocol ${command}.${name} must be a non-empty string`);
    }
  };
  const requireObject = (name: string): void => {
    if (!objectValue(payload[name])) throw new Error(`agent protocol ${command}.${name} must be an object`);
  };
  switch (command) {
    case "initialize":
      requireText("resource_root");
      requireText("data_root");
      requireText("workspace_root");
      if (payload.allowed_skill_types !== undefined
        && (!Array.isArray(payload.allowed_skill_types)
          || payload.allowed_skill_types.some((value) => typeof value !== "string"))) {
        throw new Error("agent protocol initialize.allowed_skill_types must be a string array");
      }
      break;
    case "run_turn":
      requireObject("job");
      break;
    case "cancel_turn":
      requireText("run_id");
      break;
    case "steer_turn":
      for (const name of ["run_id", "text", "response_route_id", "message_id"]) requireText(name);
      break;
    case "ensure_session":
    case "rebind_session":
      requireObject("request");
      break;
    case "pop_pending_events":
    case "has_pending_events":
      requireText("session_id");
      break;
    case "append_pending_event":
      requireText("session_id");
      requireObject("event");
      break;
    case "dashboard_request":
      if (payload.method !== "GET" && payload.method !== "PATCH") {
        throw new Error("agent protocol dashboard_request.method is unsupported");
      }
      requireText("path");
      if (payload.body !== undefined) requireObject("body");
      break;
    case "health":
    case "shutdown":
      break;
  }
};

export function parseAgentWireMessage(line: string): AgentWireMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("agent protocol line is not valid JSON");
  }
  const object = objectValue(value);
  if (!object) throw new Error("agent protocol message must be an object");
  if (object.version !== AGENT_PROTOCOL_VERSION) {
    throw new Error(`unsupported agent protocol version: ${String(object.version ?? "")}`);
  }
  if (typeof object.id === "string" && typeof object.command === "string") {
    if (!object.id.trim()) throw new Error("agent protocol request id must be non-empty");
    if (!isAgentCommand(object.command)) throw new Error(`unsupported agent protocol command: ${object.command}`);
    const payload = objectValue(object.payload);
    if (!payload) throw new Error("agent protocol request payload must be an object");
    validateRequestPayload(object.command, payload);
    return object as AgentRequest;
  }
  if (typeof object.id === "string" && typeof object.ok === "boolean") {
    if (!object.id.trim()) throw new Error("agent protocol response id must be non-empty");
    if (!object.ok && !objectValue(object.error)) throw new Error("agent protocol error response is malformed");
    if (object.ok && !("result" in object)) throw new Error("agent protocol success response is malformed");
    return object as AgentResponse;
  }
  if (typeof object.type === "string" && objectValue(object.payload)) {
    if (!agentEventTypes.has(object.type as AgentEvent["type"])) {
      throw new Error(`unsupported agent protocol event: ${object.type}`);
    }
    return object as AgentEvent;
  }
  throw new Error("unrecognized agent protocol message");
}

export function isAgentResponse(message: AgentWireMessage): message is AgentResponse {
  return "id" in message && "ok" in message;
}

export function isAgentEvent(message: AgentWireMessage): message is AgentEvent {
  return "type" in message;
}

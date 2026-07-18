import {
  validateAgentJob,
  type AgentJob,
  type EmitRequest,
  type JsonObject,
  type JsonValue,
  type SessionWorkspaceRequest,
  type WorkspaceContext,
} from "@lxe/protocol";
import {
  parseAgentDashboardRpcCall,
  type AgentDashboardRpcCall,
  type DashboardTransport,
} from "./dashboard-rpc";

export * from "./dashboard-rpc";

export const AGENT_PROTOCOL_VERSION = 2 as const;

export type AgentInitializePayload = {
  resource_root: string;
  data_root: string;
  legacy_workspace: WorkspaceContext;
  allowed_skill_types?: string[];
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
  ensure_session: { request: SessionWorkspaceRequest };
  rebind_session: { request: SessionWorkspaceRequest };
  append_pending_event: { session_id: string; event: JsonObject };
  has_pending_events: { session_id: string };
  dashboard_call: AgentDashboardRpcCall;
  health: Record<string, never>;
  shutdown: Record<string, never>;
};

export type AgentCommand = keyof AgentCommandPayloads;

export type AgentSteeringMessage = {
  text: string;
  response_route_id?: string;
  message_id?: string;
};

export type AgentRunTurnResult = {
  status: "completed" | "cancelled" | "error";
  reply: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  /** Steering messages the agent never consumed before the turn ended. */
  remaining_steering?: AgentSteeringMessage[];
};

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

export type DesktopComponentState = "stopped" | "starting" | "ready" | "error";

export type DesktopPlatform = "win32" | "darwin" | "linux";

export type DesktopLogProfile = "off" | "standard" | "diagnostic";

export type DesktopLogRetentionDays = 3 | 7 | 14 | 30;

export type DesktopLogLevel = "debug" | "info" | "warn" | "error";

export interface DesktopLoggingSinkStatus extends JsonObject {
  local_file_enabled: boolean;
  file_path: string;
  disabled_reason: "" | "disabled_by_config" | "missing_log_file" | "sink_failed";
  last_error: string;
  console_level: DesktopLogLevel;
  file_level: DesktopLogLevel;
}

export type DesktopZiniaoVersion = "v5" | "v6";

export type DesktopCloudConnectionState =
  | "not_configured"
  | "provisioning"
  | "connecting"
  | "connected"
  | "offline"
  | "error"
  | "unsupported";

export interface DesktopCloudState {
  configured: boolean;
  device_name: string;
  device_id: string;
  vpn_ip: string;
  connection: DesktopCloudConnectionState;
  last_error: string;
}

export interface DesktopCloudEnrollmentSelection {
  enrollment_id: string;
  file_name: string;
  expires_at: number;
}

export interface DesktopCloudActivationInput {
  enrollment_id: string;
  password: string;
}

export type DesktopConfigImportGroupName = "base" | "ziniao" | "mabang" | "feishu" | "logging";

export interface DesktopConfigImportGroupPreview {
  group: DesktopConfigImportGroupName;
  label: string;
  status: "ready" | "pending";
  detected_fields: string[];
  overwritten_fields: string[];
  issues: string[];
}

export interface DesktopConfigImportPreview {
  import_id: string;
  file_name: string;
  expires_at: number;
  groups: DesktopConfigImportGroupPreview[];
  warnings: string[];
  unknown_variable_count: number;
  diagnostic_logging: boolean;
}

export interface DesktopConfigImportApplyResult {
  state: DesktopSetupState;
  applied_groups: string[];
  pending_groups: string[];
  warnings: string[];
}

export type DesktopDashboardDataDomain =
  | "sessions"
  | "stats"
  | "background_tasks"
  | "channels"
  | "models"
  | "connectors"
  | "skills"
  | "tools"
  | "docs";

export interface DesktopDashboardInvalidation {
  revision: number;
  domains: DesktopDashboardDataDomain[];
  session_ids: string[];
}

export interface DesktopHealth {
  gateway: DesktopComponentState;
  agent_cli: DesktopComponentState;
  lxeskill: DesktopComponentState;
  message: string;
  version: string;
  resource_root: string;
  data_root: string;
  workspace_root: string;
  logging: {
    desktop: DesktopLoggingSinkStatus;
    agent_cli?: DesktopLoggingSinkStatus;
  };
}

export interface DesktopSetupState {
  complete: boolean;
  provider: string;
  provider_key_configured: boolean;
  workspace_root: string;
  ziniao: {
    managed: boolean;
    configured: boolean;
    issues: string[];
    company: string;
    username: string;
    password_configured: boolean;
    app_version: DesktopZiniaoVersion;
    app_path: string;
    webdriver_path: string;
  };
  mabang: {
    managed: boolean;
    configured: boolean;
    issues: string[];
    account: string;
    password_configured: boolean;
  };
  feishu: {
    managed: boolean;
    configured: boolean;
    issues: string[];
    app_id: string;
    app_secret_configured: boolean;
  };
  logging: {
    profile: DesktopLogProfile;
    retention_days: DesktopLogRetentionDays;
    directory: string;
  };
  legacy_environment_imported: boolean;
}

export type DesktopZiniaoSetupInput =
  | { action: "clear" }
  | {
      action: "save";
      company: string;
      username: string;
      password?: string;
      app_version: DesktopZiniaoVersion;
      app_path: string;
      webdriver_path: string;
    };

export type DesktopMabangSetupInput =
  | { action: "clear" }
  | { action: "save"; account: string; password?: string };

export type DesktopFeishuSetupInput =
  | { action: "clear" }
  | { action: "save"; app_id: string; app_secret?: string };

export interface DesktopSetupInput {
  provider: "kimi_coding" | "deepseek" | "glm";
  api_key?: string;
  workspace_root: string;
  ziniao?: DesktopZiniaoSetupInput;
  mabang?: DesktopMabangSetupInput;
  feishu?: DesktopFeishuSetupInput;
  logging?: {
    profile: DesktopLogProfile;
    retention_days: DesktopLogRetentionDays;
  };
}

export interface LxeDesktopBridge {
  dashboard: DashboardTransport;
  desktop: {
    readonly platform: DesktopPlatform;
    selectWorkspace(): Promise<string | null>;
    selectZiniaoApp(): Promise<string | null>;
    selectZiniaoWebDriverDirectory(): Promise<string | null>;
    selectConfigImport(): Promise<DesktopConfigImportPreview | null>;
    selectCloudEnrollment(): Promise<DesktopCloudEnrollmentSelection | null>;
    activateCloudEnrollment(input: DesktopCloudActivationInput): Promise<DesktopCloudState>;
    getCloudState(): Promise<DesktopCloudState>;
    retryCloudConnection(): Promise<DesktopCloudState>;
    applyConfigImport(importId: string): Promise<DesktopConfigImportApplyResult>;
    discardConfigImport(importId: string): Promise<void>;
    openLogsDirectory(): Promise<void>;
    getHealth(): Promise<DesktopHealth>;
    restartAgent(): Promise<DesktopHealth>;
    getSetupState(): Promise<DesktopSetupState>;
    saveSetup(input: DesktopSetupInput): Promise<DesktopSetupState>;
    onDashboardInvalidated(listener: (invalidation: DesktopDashboardInvalidation) => void): () => void;
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
  "append_pending_event",
  "has_pending_events",
  "dashboard_call",
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
  const requireWorkspace = (value: unknown, field: string): void => {
    const workspace = objectValue(value);
    if (!workspace) throw new Error(`agent protocol ${field} must be an object`);
    const unsupported = Object.keys(workspace).filter((name) => name !== "directory" && name !== "worktree");
    if (unsupported.length > 0) {
      throw new Error(`agent protocol ${field} has unsupported fields: ${unsupported.join(", ")}`);
    }
    for (const name of ["directory", "worktree"]) {
      if (typeof workspace[name] !== "string" || !String(workspace[name]).trim()) {
        throw new Error(`agent protocol ${field}.${name} must be a non-empty string`);
      }
    }
  };
  switch (command) {
    case "initialize":
      requireText("resource_root");
      requireText("data_root");
      requireWorkspace(payload.legacy_workspace, "initialize.legacy_workspace");
      if (payload.allowed_skill_types !== undefined
        && (!Array.isArray(payload.allowed_skill_types)
          || payload.allowed_skill_types.some((value) => typeof value !== "string"))) {
        throw new Error("agent protocol initialize.allowed_skill_types must be a string array");
      }
      break;
    case "run_turn":
      requireObject("job");
      if (!validateAgentJob(payload.job)) throw new Error("agent protocol run_turn.job is invalid");
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
      requireWorkspace(objectValue(payload.request)?.workspace, `${command}.request.workspace`);
      break;
    case "has_pending_events":
      requireText("session_id");
      break;
    case "append_pending_event":
      requireText("session_id");
      requireObject("event");
      break;
    case "dashboard_call":
      parseAgentDashboardRpcCall(payload);
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
    if (object.command === "dashboard_call") {
      object.payload = parseAgentDashboardRpcCall(payload);
    }
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

import {
  validateAgentJob,
  validateDesktopStreamBatchRequest,
  type AgentJob,
  type DesktopStreamBatchRequest,
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
import type {
  DesktopConversationEvent,
  DesktopConversationStreamEvent,
  DesktopInputAttachmentPayload,
} from "./dashboard-rpc";

export * from "./dashboard-rpc";

export const AGENT_PROTOCOL_VERSION = 17 as const;

/** Session-owned exec snapshot used only for completion events and card refresh. */
export type ExecTaskSnapshotPayload = {
  exec_id: string;
  session_id: string;
  origin_turn_id: string;
  status: "completed" | "failed" | "killed";
  pid: number | null;
  command: string;
  cwd: string;
  started_at: number;
  ended_at: number | null;
  duration_sec: number;
  exit_code: number | null;
  truncated: boolean;
  output_path?: string;
  output_tail: string;
};

export type CredentialSource = "local" | "cloud";

export type DesktopModelProvider = string;

export interface DesktopLocalModelProvider {
  provider: DesktopModelProvider;
  label: string;
  configured: boolean;
}

export interface ManagedLlmTarget {
  provider: string;
  model: string;
}

export interface ManagedLlmCredential extends ManagedLlmTarget {
  api_key: string;
  credential_revision: string;
  fetched_at: number;
  invalid_revision: string;
}

export class AgentProtocolError extends Error {
  readonly code = "AgentProtocolError";

  constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

export type AgentInitializePayload = {
  agent_soul_path: string;
  skills_root: string;
  user_skills_root: string;
  lxeskill_catalog_path: string;
  llm_config_root: string;
  data_root: string;
  legacy_workspace: WorkspaceContext;
  allowed_skill_types?: string[];
};

export type AgentCommandPayloads = {
  initialize: AgentInitializePayload;
  update_skill_permissions: { allowed_skill_types: string[] };
  update_managed_llm_credential: {
    credential: ManagedLlmCredential | null;
    target?: ManagedLlmTarget;
  };
  run_turn: { job: AgentJob };
  cancel_turn: { run_id: string };
  steer_turn: {
    run_id: string;
    text: string;
    response_route_id: string;
    message_id: string;
  };
  ensure_session: { request: SessionWorkspaceRequest };
  append_pending_event: { session_id: string; event: JsonObject };
  has_pending_events: { session_id: string };
  resolve_artifact: { session_id: string; artifact_id: string };
  resolve_attachment: { session_id: string; attachment_id: string };
  dashboard_call: AgentDashboardRpcCall;
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
  remaining_steering: AgentSteeringMessage[];
};

export function parseAgentRunTurnResult(value: unknown): AgentRunTurnResult {
  const object = objectValue(value);
  if (!object) throw new AgentProtocolError("agent protocol run_turn result must be an object");

  const status = object.status;
  if (status !== "completed" && status !== "cancelled" && status !== "error") {
    throw new AgentProtocolError("agent protocol run_turn result.status is invalid");
  }
  if (typeof object.reply !== "string") {
    throw new AgentProtocolError("agent protocol run_turn result.reply must be a string");
  }

  const safeCounter = (name: "input_tokens" | "output_tokens" | "tool_calls"): number => {
    const counter = object[name];
    if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) {
      throw new AgentProtocolError(`agent protocol run_turn result.${name} must be a non-negative safe integer`);
    }
    return counter;
  };

  if (!Array.isArray(object.remaining_steering)) {
    throw new AgentProtocolError("agent protocol run_turn result.remaining_steering must be an array");
  }
  const remainingSteering = object.remaining_steering.map((value, index): AgentSteeringMessage => {
    const item = objectValue(value);
    if (!item) {
      throw new AgentProtocolError(
        `agent protocol run_turn result.remaining_steering[${index}] must be an object`,
      );
    }
    if (typeof item.text !== "string" || !item.text.trim()) {
      throw new AgentProtocolError(
        `agent protocol run_turn result.remaining_steering[${index}].text must be a non-empty string`,
      );
    }
    const responseRouteId = item.response_route_id;
    const messageId = item.message_id;
    for (const [field, fieldValue] of [
      ["response_route_id", responseRouteId],
      ["message_id", messageId],
    ] as const) {
      if (fieldValue !== undefined && typeof fieldValue !== "string") {
        throw new AgentProtocolError(
          `agent protocol run_turn result.remaining_steering[${index}].${field} must be a string`,
        );
      }
    }
    return {
      text: item.text.trim(),
      ...(typeof responseRouteId === "string" ? { response_route_id: responseRouteId.trim() } : {}),
      ...(typeof messageId === "string" ? { message_id: messageId.trim() } : {}),
    };
  });

  return {
    status,
    reply: object.reply,
    input_tokens: safeCounter("input_tokens"),
    output_tokens: safeCounter("output_tokens"),
    tool_calls: safeCounter("tool_calls"),
    remaining_steering: remainingSteering,
  };
}

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

export type AgentSessionChange = "messages" | "usage" | "artifacts" | "attachments";

export type AgentSessionChangedPayload = {
  changes: AgentSessionChange[];
};

export type BackgroundTaskChangedPayload = {
  tool_call_id: string;
  task: ExecTaskSnapshotPayload;
};

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
      type: "conversation.stream.delta";
      thread_id: string;
      turn_id: string;
      payload: DesktopStreamBatchRequest;
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
      type: "background_task.changed";
      thread_id: string;
      turn_id: string;
      payload: BackgroundTaskChangedPayload;
    }
  | {
      version: typeof AGENT_PROTOCOL_VERSION;
      type: "managed_llm.authentication_failed";
      payload: {
        provider: string;
        model: string;
        credential_revision: string;
      };
    }
  | {
      version: typeof AGENT_PROTOCOL_VERSION;
      type: "session.changed";
      thread_id: string;
      payload: AgentSessionChangedPayload;
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

export type DesktopCloudDestination =
  | "agent_dashboard"
  | "erp_dashboard"
  | "admin_dashboard";

export type DesktopPermissionProfile = string;

export type DesktopCloudPermissionStatus =
  | "pending_verification"
  | "verified"
  | "cached"
  | "unassigned";

export interface DesktopCloudPermissionSnapshot {
  device_id: string;
  permission_schema: 1 | 2;
  permission_profile: DesktopPermissionProfile | null;
  permission_version: number;
  profile_revision: number;
  profile_labels: Record<string, string>;
  allowed_skill_types: string[];
  desktop_features: string[];
  verified_at: number;
}

export interface DesktopCloudState {
  configured: boolean;
  is_admin: boolean;
  device_name: string;
  device_id: string;
  vpn_ip: string;
  connection: DesktopCloudConnectionState;
  last_error: string;
  last_checked_at: number;
  permission_status: DesktopCloudPermissionStatus;
  permission_profile: DesktopPermissionProfile | null;
  permission_version: number;
  profile_revision: number;
  profile_labels: Record<string, string>;
  desktop_features: string[];
  permission_verified_at: number;
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

export type DesktopDashboardDataDomain =
  | "sessions"
  | "stats"
  | "channels"
  | "models"
  | "connectors"
  | "skills"
  | "tools";

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
  provider: DesktopModelProvider;
  local_provider: DesktopModelProvider;
  credential_source: CredentialSource;
  managed_model_configured: boolean;
  local_model_providers: DesktopLocalModelProvider[];
  local_auth_path: string;
  local_auth_error: string;
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
  workspace_root: string;
  ziniao?: DesktopZiniaoSetupInput;
  mabang?: DesktopMabangSetupInput;
  feishu?: DesktopFeishuSetupInput;
  logging?: {
    profile: DesktopLogProfile;
    retention_days: DesktopLogRetentionDays;
  };
}

export interface DesktopLocalModelCredentialInput {
  provider: DesktopModelProvider;
  api_key: string;
}

export type DesktopSyntheticPerformerSourceKind = "files" | "folder";

export interface DesktopSyntheticPerformerSourceSelection {
  selection_id: string;
  kind: DesktopSyntheticPerformerSourceKind;
  display_path: string;
  selected_count: number;
}

export interface DesktopSyntheticPerformerOutputSelection {
  output_id: string;
  display_path: string;
}

export type DesktopSyntheticPerformerScanStatus =
  | "needs_tag"
  | "already_tagged"
  | "unsupported"
  | "failed";

export type DesktopSyntheticPerformerApplyStatus = "tagged" | "copied" | "failed";

export interface DesktopSyntheticPerformerItem {
  name: string;
  relative_path: string;
  media_type: "image" | "video";
  status: DesktopSyntheticPerformerScanStatus | DesktopSyntheticPerformerApplyStatus;
  size_bytes: number;
  error?: string;
}

export type DesktopSyntheticPerformerTaskInput =
  | {
      action: "scan";
      selection_id: string;
      recursive: boolean;
    }
  | {
      action: "apply";
      selection_id: string;
      output_id: string;
      recursive: boolean;
    };

export interface DesktopSyntheticPerformerTask {
  task_id: string;
  action: "scan" | "apply";
  state: "queued" | "running" | "completed" | "cancelled" | "failed";
  stage: "idle" | "scan" | "apply" | "verify" | "done";
  processed: number;
  total: number;
  current_file: string;
  selection_id: string;
  recursive: boolean;
  items: DesktopSyntheticPerformerItem[];
  counts: Record<string, number>;
  error: string;
}

/** One stored generation of a long-lived user asset. */
export interface DesktopInputAssetVersion {
  file_name: string;
  path: string;
  size_bytes: number;
  updated_at: string;
}

export interface DesktopInputAssetSlot {
  slot: string;
  display_name: string;
  used_by: string[];
  holds: string;
  directory: string;
  /** The version commands use when the field is omitted; null when never filled. */
  current: DesktopInputAssetVersion | null;
  /** Retained rollback copy. Shown to the user, never to the model. */
  previous: DesktopInputAssetVersion | null;
}

export interface LxeDesktopBridge {
  dashboard: DashboardTransport;
  desktop: {
    readonly platform: DesktopPlatform;
    selectWorkspace(): Promise<string | null>;
    selectZiniaoApp(): Promise<string | null>;
    selectZiniaoWebDriverDirectory(): Promise<string | null>;
    selectCloudEnrollment(): Promise<DesktopCloudEnrollmentSelection | null>;
    activateCloudEnrollment(input: DesktopCloudActivationInput): Promise<DesktopCloudState>;
    getCloudState(): Promise<DesktopCloudState>;
    retryCloudConnection(): Promise<DesktopCloudState>;
    openCloudDestination(destination: DesktopCloudDestination): Promise<void>;
    openLogsDirectory(): Promise<void>;
    /** Hand the resolved theme to the window chrome the renderer cannot paint. */
    applyAppearance(appearance: "light" | "dark"): Promise<void>;
    getHealth(): Promise<DesktopHealth>;
    restartAgent(): Promise<DesktopHealth>;
    getSetupState(): Promise<DesktopSetupState>;
    saveSetup(input: DesktopSetupInput): Promise<DesktopSetupState>;
    saveLocalModelCredential(input: DesktopLocalModelCredentialInput): Promise<DesktopSetupState>;
    deleteLocalModelCredential(provider: DesktopModelProvider): Promise<DesktopSetupState>;
    selectSyntheticPerformerSources(
      kind: DesktopSyntheticPerformerSourceKind,
    ): Promise<DesktopSyntheticPerformerSourceSelection | null>;
    selectSyntheticPerformerOutput(): Promise<DesktopSyntheticPerformerOutputSelection | null>;
    selectConversationFiles(): Promise<DesktopInputAttachmentPayload[]>;
    stageDroppedConversationFiles(files: File[]): Promise<DesktopInputAttachmentPayload[]>;
    discardConversationFiles(attachmentIds: string[]): Promise<void>;
    startSyntheticPerformerTask(
      input: DesktopSyntheticPerformerTaskInput,
    ): Promise<DesktopSyntheticPerformerTask>;
    getSyntheticPerformerTask(): Promise<DesktopSyntheticPerformerTask | null>;
    cancelSyntheticPerformerTask(taskId: string): Promise<DesktopSyntheticPerformerTask | null>;
    openSyntheticPerformerOutput(taskId: string): Promise<void>;
    listInputAssets(): Promise<DesktopInputAssetSlot[]>;
    revealInputAssetSlot(slot: string): Promise<void>;
    onSyntheticPerformerTaskChanged(
      listener: (task: DesktopSyntheticPerformerTask) => void,
    ): () => void;
    onCloudStateChanged(listener: (state: DesktopCloudState) => void): () => void;
    onConversationEvent(listener: (event: DesktopConversationEvent) => void): () => void;
    onConversationStreamEvent(listener: (event: DesktopConversationStreamEvent) => void): () => void;
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
  "update_skill_permissions",
  "update_managed_llm_credential",
  "run_turn",
  "cancel_turn",
  "steer_turn",
  "ensure_session",
  "append_pending_event",
  "has_pending_events",
  "resolve_artifact",
  "resolve_attachment",
  "dashboard_call",
  "shutdown",
]);
const agentEventTypes = new Set<AgentEvent["type"]>([
  "item.completed",
  "conversation.stream.delta",
  "typing.changed",
  "agent.wake",
  "background_task.changed",
  "managed_llm.authentication_failed",
  "session.changed",
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
      requireText("agent_soul_path");
      requireText("skills_root");
      requireText("user_skills_root");
      requireText("lxeskill_catalog_path");
      requireText("llm_config_root");
      requireText("data_root");
      requireWorkspace(payload.legacy_workspace, "initialize.legacy_workspace");
      if (payload.allowed_skill_types !== undefined
        && (!Array.isArray(payload.allowed_skill_types)
          || payload.allowed_skill_types.some((value) => typeof value !== "string"))) {
        throw new Error("agent protocol initialize.allowed_skill_types must be a string array");
      }
      break;
    case "update_skill_permissions":
      if (!Array.isArray(payload.allowed_skill_types)
        || payload.allowed_skill_types.some((value) => typeof value !== "string")) {
        throw new Error(
          "agent protocol update_skill_permissions.allowed_skill_types must be a string array",
        );
      }
      break;
    case "update_managed_llm_credential": {
      if (payload.target !== undefined) {
        const target = objectValue(payload.target);
        if (!target
          || typeof target.provider !== "string"
          || !/^[a-z][a-z0-9_-]{0,63}$/u.test(target.provider)
          || typeof target.model !== "string"
          || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(target.model)) {
          throw new Error("agent protocol update_managed_llm_credential.target is invalid");
        }
      }
      if (payload.credential === null) break;
      const credential = objectValue(payload.credential);
      if (!credential
        || typeof credential.provider !== "string"
        || !/^[a-z][a-z0-9_-]{0,63}$/u.test(credential.provider)
        || typeof credential.model !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(credential.model)
        || typeof credential.api_key !== "string"
        || !credential.api_key.trim()
        || credential.api_key.length > 4_096
        || typeof credential.credential_revision !== "string"
        || !/^[a-f0-9]{64}$/u.test(credential.credential_revision)
        || typeof credential.fetched_at !== "number"
        || !Number.isSafeInteger(credential.fetched_at)
        || credential.fetched_at <= 0
        || typeof credential.invalid_revision !== "string"
        || (credential.invalid_revision !== ""
          && !/^[a-f0-9]{64}$/u.test(credential.invalid_revision))) {
        throw new Error("agent protocol update_managed_llm_credential.credential is invalid");
      }
      break;
    }
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
      requireObject("request");
      requireWorkspace(objectValue(payload.request)?.workspace, `${command}.request.workspace`);
      break;
    case "has_pending_events":
      requireText("session_id");
      break;
    case "resolve_artifact":
      requireText("session_id");
      requireText("artifact_id");
      break;
    case "resolve_attachment":
      requireText("session_id");
      requireText("attachment_id");
      break;
    case "append_pending_event":
      requireText("session_id");
      requireObject("event");
      break;
    case "dashboard_call":
      parseAgentDashboardRpcCall(payload);
      break;
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
    if (object.type === "session.changed") {
      if (typeof object.thread_id !== "string" || !object.thread_id.trim()) {
        throw new Error("agent protocol session.changed.thread_id must be a non-empty string");
      }
      const payload = objectValue(object.payload)!;
      const unsupported = Object.keys(payload).filter((name) => name !== "changes");
      if (unsupported.length > 0) {
        throw new Error(`agent protocol session.changed payload has unsupported fields: ${unsupported.join(", ")}`);
      }
      if (!Array.isArray(payload.changes) || payload.changes.length === 0) {
        throw new Error("agent protocol session.changed.changes must be a non-empty array");
      }
      const changes = [...new Set(payload.changes)];
      if (changes.some((change) => change !== "messages" && change !== "usage"
        && change !== "artifacts" && change !== "attachments")) {
        throw new Error("agent protocol session.changed.changes contains an unsupported change type");
      }
      payload.changes = changes;
    }
    if (object.type === "managed_llm.authentication_failed") {
      const payload = objectValue(object.payload)!;
      const unsupported = Object.keys(payload).filter((name) =>
        name !== "provider" && name !== "model" && name !== "credential_revision");
      if (unsupported.length > 0
        || typeof payload.provider !== "string"
        || !/^[a-z][a-z0-9_-]{0,63}$/u.test(payload.provider)
        || typeof payload.model !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(payload.model)
        || typeof payload.credential_revision !== "string"
        || !/^[a-f0-9]{64}$/u.test(payload.credential_revision)) {
        throw new Error("agent protocol managed LLM authentication event is invalid");
      }
    }
    if (object.type === "background_task.changed") {
      if (typeof object.thread_id !== "string" || !object.thread_id.trim()
        || typeof object.turn_id !== "string" || !object.turn_id.trim()) {
        throw new Error("agent protocol background_task.changed identifiers must be non-empty strings");
      }
      const payload = objectValue(object.payload)!;
      const task = objectValue(payload.task);
      const status = task?.status;
      const payloadFields = Object.keys(payload).filter((name) => name !== "tool_call_id" && name !== "task");
      const taskFields = task ? Object.keys(task).filter((name) => ![
        "exec_id", "session_id", "origin_turn_id", "status", "pid", "command", "cwd", "started_at",
        "ended_at", "duration_sec", "exit_code", "truncated", "output_path", "output_tail",
      ].includes(name)) : [];
      if (payloadFields.length > 0 || taskFields.length > 0
        || typeof payload.tool_call_id !== "string" || !payload.tool_call_id.trim()
        || !task
        || typeof task.exec_id !== "string" || !task.exec_id.trim()
        || task.session_id !== object.thread_id
        || task.origin_turn_id !== object.turn_id
        || (status !== "completed" && status !== "failed" && status !== "killed")
        || (task.pid !== null && (typeof task.pid !== "number" || !Number.isSafeInteger(task.pid) || task.pid <= 0))
        || typeof task.command !== "string" || typeof task.cwd !== "string"
        || typeof task.started_at !== "number" || !Number.isFinite(task.started_at)
        || (task.ended_at !== null && (typeof task.ended_at !== "number" || !Number.isFinite(task.ended_at)))
        || typeof task.duration_sec !== "number" || !Number.isFinite(task.duration_sec) || task.duration_sec < 0
        || (task.exit_code !== null && (typeof task.exit_code !== "number" || !Number.isSafeInteger(task.exit_code)))
        || typeof task.truncated !== "boolean"
        || (task.output_path !== undefined && typeof task.output_path !== "string")
        || typeof task.output_tail !== "string") {
        throw new Error("agent protocol background_task.changed payload is invalid");
      }
    }
    if (object.type === "conversation.stream.delta") {
      if (typeof object.thread_id !== "string" || !object.thread_id.trim()
        || typeof object.turn_id !== "string" || !object.turn_id.trim()) {
        throw new Error("agent protocol conversation.stream.delta identifiers must be non-empty strings");
      }
      const payload = objectValue(object.payload)!;
      if (!validateDesktopStreamBatchRequest(payload)) {
        throw new Error(
          `agent protocol conversation.stream.delta payload is invalid: ${validateDesktopStreamBatchRequest.errors?.[0]?.message ?? "invalid request"}`,
        );
      }
      if (payload.session_id !== object.thread_id || payload.turn_id !== object.turn_id) {
        throw new Error("agent protocol conversation.stream.delta envelope does not match payload");
      }
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

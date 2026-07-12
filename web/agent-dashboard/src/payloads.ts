// Shared API payload shapes for the dashboard.

export type CapabilityPayload = {
  provider: string;
  model: string;
  context_window_tokens: number;
  max_tokens: number;
  max_output_tokens?: number;
  supports_vision: boolean;
  supports_thinking: boolean;
  supports_temperature: boolean;
};

export type ThinkingStatePayload = {
  enabled: boolean;
  level: string;
  editable: boolean;
};

export type ModelOptionPayload = {
  model: string;
  thinking_request_style: string;
  thinking_levels: string[];
  thinking_level_labels: Record<string, string>;
  thinking_default: string;
  capabilities: CapabilityPayload;
};

export type ModelPayload = {
  provider: string;
  label: string;
  api_style: string;
  model: string;
  configured: boolean;
  selectable: boolean;
  disabled_reason: string;
  model_options: ModelOptionPayload[];
  thinking_request_style: string;
  thinking_levels: string[];
  thinking_level_labels: Record<string, string>;
  thinking_default: string;
  thinking_state: ThinkingStatePayload;
  capabilities: CapabilityPayload;
};

export type SessionPayload = {
  session_id: string;
  title: string;
  source: Record<string, unknown>;
  source_summary: SourceSummary;
  model: string;
  model_config: Record<string, unknown>;
  created_at: number;
  last_active_at: number;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  api_call_count: number;
};

export type SourceSummary = {
  platform: string;
  chat_type: string;
};

export type SessionMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: unknown;
  [key: string]: unknown;
};

export type MessagesPagePayload = {
  total: number;
  raw_message_total: number;
  start: number;
  end: number;
  limit: number;
  current_page: number;
  total_pages: number;
  has_previous: boolean;
  has_next: boolean;
};

export type SessionDetailPayload = {
  session: SessionPayload;
  messages: SessionMessage[];
  messages_page: MessagesPagePayload;
};

export type ConversationToolGroup = {
  messages: SessionMessage[];
  startIndex: number;
  key: string;
};

export type ConversationRenderItem =
  | { type: "message"; message: SessionMessage; index: number; toolGroups: ConversationToolGroup[] }
  | { type: "tool_group"; group: ConversationToolGroup };

export type SkillReferencePayload = {
  path: string;
  description: string;
};

export type SkillPayload = {
  name: string;
  type: string;
  description: string;
  commands: string[];
  enabled: boolean;
  location: string;
  references: SkillReferencePayload[];
};

export type CliCommandPayload = {
  command: string;
  name: string;
  visibility: "business" | "browser" | "maintenance" | "internal";
  ownerSkills: string[];
};

export type SkillStatPayload = {
  name: string;
  module: string;
  activations: number;
  executions: number;
  failures: number;
  execution_turns: number;
  duration_ms: number;
  last_used_at: number;
};

export type ToolStatPayload = {
  name: string;
  calls: number;
  errors: number;
  duration_ms: number;
  turns: number;
  last_used_at: number;
};

export type StatsOverviewPayload = {
  days: number;
  totals: {
    turns: number;
    error_turns: number;
    tool_calls: number;
    llm_calls: number;
    input_tokens: number;
    output_tokens: number;
    skill_executions: number;
    skill_failures: number;
  };
  modules: Array<{
    module: string;
    skills: number;
    turns: number;
    executions: number;
    failures: number;
    duration_ms: number;
  }>;
  daily: Array<{
    day: string;
    turns: number;
    tool_calls: number;
    executions: number;
    failures: number;
  }>;
};

export type ConnectorPayload = {
  id: string;
  name: string;
  description: string;
  kind: string;
  enabled: boolean;
  everConnected: boolean;
  userDisabled: boolean;
  skill_names: string[];
  skill_count: number;
};

export type ChannelHealthPayload = {
  running?: boolean;
  thread_alive?: boolean;
  connection_alive?: boolean;
  connection_state?: string;
  restart_monitor_alive?: boolean;
  restart_in_progress?: boolean;
  next_restart_at?: string;
  last_restart_at?: string;
  last_restart_error?: string;
  last_connected_at?: string;
  last_disconnected_at?: string;
  last_error?: string;
};

export type ChannelHealthList = {
  items: Record<string, ChannelHealthPayload>;
  total: number;
};

export type SkillContentPayload = {
  name: string;
  type: string;
  description: string;
  location: string;
  references: SkillReferencePayload[];
  content: string;
};

export type SkillReferenceContentPayload = {
  skill_name: string;
  path: string;
  description: string;
  location: string;
  content: string;
};

export type SkillContentView = {
  title: string;
  subtitle: string;
  content: string;
};

export type SkillContentMode = "preview" | "source";

export type ProjectDocPayload = {
  path: string;
  title: string;
  section: string;
  status: string;
  size: number;
};

export type ProjectDocContentPayload = ProjectDocPayload & {
  content: string;
};

export type DocsContentMode = "preview" | "source";

export type DocsTreeFileNode = {
  kind: "file";
  name: string;
  path: string;
  doc: ProjectDocPayload;
};

export type DocsTreeFolderNode = {
  kind: "folder";
  name: string;
  path: string;
  children: DocsTreeNode[];
};

export type DocsTreeNode = DocsTreeFileNode | DocsTreeFolderNode;

export type ToolPayload = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requires_resource: string | null;
  enabled: boolean;
};

export type McpServerPayload = {
  name: string;
  enabled: boolean;
  transport: string;
  status: string;
  tool_count: number;
  error: string;
  server_title: string;
  connector_name: string;
};

export type ToolsetPayload = {
  name: string;
  label: string;
  enabled: boolean;
  tools: ToolPayload[];
  servers?: McpServerPayload[];
};

export type BackgroundTaskPayload = {
  task_id: string;
  session_id: string;
  session_title: string;
  origin_turn_id: string;
  card_id: string;
  status: string;
  pid: number | null;
  command: string;
  cwd: string;
  started_at: number;
  ended_at: number | null;
  duration_sec: number;
  background: boolean;
  exit_code: number | null;
  truncated: boolean;
  output_tail: string;
};

export type ApiList<T> = {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
};

export type SessionSummaryPayload = {
  total_sessions: number;
  tool_call_count: number;
  token_count: number;
};

export type SessionListPayload = ApiList<SessionPayload> & {
  summary: SessionSummaryPayload;
};

// Dashboard wire payloads live with the RPC contract. This module keeps the
// existing Renderer import surface and owns UI-only view models.

import type {
  SessionArtifactPayload,
  SessionMessage,
  SessionTurnDisplayPayload,
} from "@lxe/desktop-protocol";

export type {
  ApiList,
  BackgroundTaskPayload,
  CapabilityPayload,
  ChannelHealthList,
  ChannelHealthPayload,
  CliCommandPayload,
  ConnectorPayload,
  DashboardContentTruncationPayload,
  DesktopConversationActivityPayload,
  DesktopConversationEvent,
  DesktopConversationSendPayload,
  DesktopConversationStopPayload,
  DesktopConversationStreamPayload,
  DesktopConversationTurnPayload,
  TurnProcessPart,
  DesktopInputAttachmentPayload,
  McpServerListPayload,
  McpServerPayload,
  MessagesPagePayload,
  ModelMutationPayload,
  ModelOptionPayload,
  ModelPayload,
  SessionDetailPayload,
  SessionArtifactPayload,
  SessionListPayload,
  SessionMessage,
  SessionTurnDisplayPayload,
  SessionPayload,
  SessionSummaryPayload,
  SkillContentPayload,
  SkillPayload,
  SkillReferenceContentPayload,
  SkillReferencePayload,
  SkillStatPayload,
  SkillUsageDetailPayload,
  SourceSummary,
  StatsOverviewPayload,
  ThinkingStatePayload,
  ToolPayload,
  ToolsetPayload,
  ToolStatPayload,
  WorkspacePayload,
  WorkspaceReloadPayload,
} from "@lxe/desktop-protocol";

export type ConversationToolGroup = {
  messages: SessionMessage[];
  startIndex: number;
  key: string;
};

export type ConversationArtifactGroup = {
  turnId: string;
  files: SessionArtifactPayload[];
  key: string;
};

export type ConversationProcessItem =
  | { type: "message"; message: SessionMessage; key: string }
  | { type: "tool_group"; group: ConversationToolGroup };

export type ConversationLiveToolGroup = {
  parts: Array<Extract<import("@lxe/desktop-protocol").TurnProcessPart, { type: "tool" }>>;
  key: string;
};

export type ConversationLiveProcessItem =
  | { type: "message"; message: SessionMessage; key: string }
  | { type: "tool_group"; group: ConversationLiveToolGroup };

export type ConversationResponseGroup = {
  displayGroupId: string;
  messages: SessionMessage[];
  process: ConversationProcessItem[];
  finalMessage?: SessionMessage;
  turn?: SessionTurnDisplayPayload;
  key: string;
};

export type ConversationRenderItem =
  | { type: "message"; message: SessionMessage; index: number; toolGroups: ConversationToolGroup[] }
  | { type: "tool_group"; group: ConversationToolGroup }
  | { type: "response_group"; group: ConversationResponseGroup }
  | { type: "artifact_group"; group: ConversationArtifactGroup };

export type SkillContentView = {
  title: string;
  subtitle: string;
  content: string;
};

export type SkillContentMode = "preview" | "source";

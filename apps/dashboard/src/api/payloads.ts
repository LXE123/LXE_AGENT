// Dashboard wire payloads live with the RPC contract. This module keeps the
// existing Renderer import surface and owns UI-only view models.

import type {
  ProjectDocPayload,
  SessionMessage,
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
  McpServerListPayload,
  McpServerPayload,
  MessagesPagePayload,
  ModelMutationPayload,
  ModelOptionPayload,
  ModelPayload,
  ProjectDocContentPayload,
  ProjectDocPayload,
  SessionDetailPayload,
  SessionListPayload,
  SessionMessage,
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

export type ConversationRenderItem =
  | { type: "message"; message: SessionMessage; index: number; toolGroups: ConversationToolGroup[] }
  | { type: "tool_group"; group: ConversationToolGroup };

export type SkillContentView = {
  title: string;
  subtitle: string;
  content: string;
};

export type SkillContentMode = "preview" | "source";

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

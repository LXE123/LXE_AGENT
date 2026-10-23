export const dashboardQueryKeys = {
  sessions: {
    approvals: ["sessions", "approvals"] as const,
    permission: (sessionId: string) => ["sessions", "permission", sessionId] as const,
    questions: ["sessions", "questions"] as const,
    all: ["sessions"] as const,
    lists: ["sessions", "list"] as const,
    list: (query: string, workspace_id?: string | null) => workspace_id === undefined
      ? ["sessions", "list", query.trim()] as const
      : ["sessions", "list", query.trim(), { workspace_id }] as const,
    workspaces: ["sessions", "list", { kind: "workspaces" }] as const,
    details: ["sessions", "detail"] as const,
    detail: (sessionId: string, cursor: string | "latest") =>
      ["sessions", "detail", sessionId, cursor] as const,
    detailSession: (sessionId: string) => ["sessions", "detail", sessionId] as const,
    activity: (sessionId: string) => ["sessions", "activity", sessionId] as const,
    attachmentPreview: (sessionId: string, id: string, variant: "thumbnail" | "expanded") =>
      ["sessions", "attachment-preview", sessionId, id, variant] as const,
  },
  stats: {
    all: ["stats"] as const,
    byType: (type: "overview" | "skills" | "tools", days: number) =>
      ["stats", type, days] as const,
  },
  channelHealth: {
    all: ["channel-health"] as const,
  },
  models: {
    all: ["models"] as const,
    list: ["models", "list"] as const,
    current: ["models", "current"] as const,
    session: (sessionId: string) => ["models", "session", sessionId] as const,
  },
  skills: {
    all: ["skills"] as const,
    list: ["skills", "list"] as const,
    userList: ["skills", "user", "list"] as const,
    userContent: (id: string, path: string) => ["skills", "user", "content", id, path] as const,
    content: (name: string) => ["skills", "content", name] as const,
    reference: (name: string, path: string) => ["skills", "content", name, "reference", path] as const,
  },
  tools: {
    all: ["tools"] as const,
  },
  commands: {
    all: ["commands"] as const,
  },
} as const;

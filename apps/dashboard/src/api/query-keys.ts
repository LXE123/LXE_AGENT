export const dashboardQueryKeys = {
  sessions: {
    all: ["sessions"] as const,
    lists: ["sessions", "list"] as const,
    list: (query: string) => ["sessions", "list", query.trim()] as const,
    details: ["sessions", "detail"] as const,
    detail: (sessionId: string, page: number | "latest") =>
      ["sessions", "detail", sessionId, page] as const,
    detailSession: (sessionId: string) => ["sessions", "detail", sessionId] as const,
  },
  stats: {
    all: ["stats"] as const,
    byType: (type: "overview" | "skills" | "tools", days: number) =>
      ["stats", type, days] as const,
  },
  backgroundTasks: {
    all: ["background-tasks"] as const,
  },
  channelHealth: {
    all: ["channel-health"] as const,
  },
  models: {
    all: ["models"] as const,
    list: ["models", "list"] as const,
    current: ["models", "current"] as const,
  },
  connectors: {
    all: ["connectors"] as const,
  },
  skills: {
    all: ["skills"] as const,
    list: ["skills", "list"] as const,
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

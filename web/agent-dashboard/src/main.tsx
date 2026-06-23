import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  Info,
  Layers3,
  MessageSquareText,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings2,
  Sparkles,
  UserRound,
  Wrench,
  X
} from "lucide-react";
import "./styles.css";

type CapabilityPayload = {
  provider: string;
  model: string;
  context_window_tokens: number;
  max_tokens: number;
  max_output_tokens?: number;
  supports_vision: boolean;
  supports_thinking: boolean;
  supports_temperature: boolean;
};

type ThinkingStatePayload = {
  enabled: boolean;
  level: string;
  editable: boolean;
};

type ModelOptionPayload = {
  model: string;
  thinking_request_style: string;
  thinking_levels: string[];
  thinking_level_labels: Record<string, string>;
  thinking_default: string;
  capabilities: CapabilityPayload;
};

type ModelPayload = {
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

type SessionPayload = {
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

type SourceSummary = {
  platform: string;
  chat_type: string;
};

type SessionMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: unknown;
  [key: string]: unknown;
};

type MessagesPagePayload = {
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

type SessionDetailPayload = {
  session: SessionPayload;
  messages: SessionMessage[];
  messages_page: MessagesPagePayload;
};

type ConversationToolGroup = {
  messages: SessionMessage[];
  startIndex: number;
  key: string;
};

type ConversationRenderItem =
  | { type: "message"; message: SessionMessage; index: number; toolGroups: ConversationToolGroup[] }
  | { type: "tool_group"; group: ConversationToolGroup };

type SkillReferencePayload = {
  path: string;
  description: string;
};

type SkillPayload = {
  name: string;
  type: string;
  description: string;
  enabled: boolean;
  location: string;
  references: SkillReferencePayload[];
};

type SkillContentPayload = {
  name: string;
  type: string;
  description: string;
  location: string;
  references: SkillReferencePayload[];
  content: string;
};

type SkillReferenceContentPayload = {
  skill_name: string;
  path: string;
  description: string;
  location: string;
  content: string;
};

type SkillContentView = {
  title: string;
  subtitle: string;
  content: string;
};

type SkillContentMode = "preview" | "source";

type ProjectDocPayload = {
  path: string;
  title: string;
  section: string;
  status: string;
  size: number;
};

type ProjectDocContentPayload = ProjectDocPayload & {
  content: string;
};

type DocsContentMode = "preview" | "source";

type DocsTreeFileNode = {
  kind: "file";
  name: string;
  path: string;
  doc: ProjectDocPayload;
};

type DocsTreeFolderNode = {
  kind: "folder";
  name: string;
  path: string;
  children: DocsTreeNode[];
};

type DocsTreeNode = DocsTreeFileNode | DocsTreeFolderNode;

type ToolPayload = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requires_resource: string | null;
  enabled: boolean;
};

type ToolsetPayload = {
  name: string;
  label: string;
  enabled: boolean;
  tools: ToolPayload[];
};

type BackgroundTaskPayload = {
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

type ApiList<T> = {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
};

type SessionSummaryPayload = {
  total_sessions: number;
  tool_call_count: number;
  token_count: number;
};

type SessionListPayload = ApiList<SessionPayload> & {
  summary: SessionSummaryPayload;
};

const SESSION_MESSAGE_PAGE_LIMIT = 10;
const SESSION_LIST_PAGE_SIZE = 10;
const LANGUAGE_STORAGE_KEY = "agent-dashboard-language";
const DOCS_HOME_PATH = "README.md";
const DOCS_ROUTE_PREFIX = "/docs";
const DASHBOARD_TAB_IDS = new Set(["home", "sessions", "models", "tools", "skills", "background-tasks"]);

const EMPTY_SESSION_SUMMARY: SessionSummaryPayload = {
  total_sessions: 0,
  tool_call_count: 0,
  token_count: 0
};

const EMPTY_SESSION_LIST: SessionListPayload = {
  items: [],
  total: 0,
  limit: SESSION_LIST_PAGE_SIZE,
  offset: 0,
  summary: EMPTY_SESSION_SUMMARY
};

const EMPTY_PROJECT_DOCS: ApiList<ProjectDocPayload> = {
  items: [],
  total: 0
};

type Language = "zh" | "en";

const ZH_TEXT = {
  language: {
    label: "语言",
    zh: "中文",
    en: "EN"
  },
  app: {
    eyebrow: "本地 Agent",
    title: "Agent Dashboard",
    subtitle: "查看当前 gateway 的会话、模型、工具和技能。",
    apiOnline: "API 在线",
    apiOffline: "API 离线"
  },
  nav: {
    sessions: "会话",
    docs: "文档",
    models: "模型",
    tools: "工具",
    skills: "技能",
    tasks: "任务",
    aria: "Dashboard 区域"
  },
  sidebar: {
    brand: "Agent",
    collapse: "收起侧边栏",
    expand: "展开侧边栏"
  },
  home: {
    title: "欢迎使用 Agent Dashboard",
    subtitle: "进入会话页面查看历史记录，或使用左侧导航查看模型、工具、技能、任务和文档。"
  },
  stats: {
    sessions: "会话",
    toolCalls: "工具调用",
    tokens: "Token",
    messages: "消息",
    apiCalls: "API 调用"
  },
  common: {
    loading: "加载中",
    copied: "已复制",
    unknown: "unknown",
    unnamedSession: "未命名会话",
    previous: "上一页",
    next: "下一页",
    pageIndex: (current: string, total: string) => `第 ${current} / ${total} 页`,
    errorPrefix: (label: string, message: string) => `${label}：${message}`,
    countItems: (count: string, unit: string) => `${count} ${unit}`,
    yes: "是",
    no: "否",
    none: "无",
    notSupported: "不支持",
    fallbackTool: "工具",
    block: "块"
  },
  role: {
    user: "user",
    assistant: "assistant",
    tool: "tool",
    system: "system",
    unknown: "unknown"
  },
  sessions: {
    title: "会话",
    searchPlaceholder: "搜索 sessions",
    searchAria: "搜索 sessions",
    selectPrompt: "选择一个会话查看详情。",
    searchResults: (count: string) => `搜索结果 ${count} 条`,
    total: (count: string) => `共 ${count} 条`,
    empty: "暂无 session 记录。",
    emptySearch: "没有匹配的 session。",
    loading: "正在加载 sessions...",
    errorLabel: "Sessions 错误",
    columnSession: "会话",
    tokenSuffix: "Token"
  },
  docs: {
    title: "文档",
    searchPlaceholder: "搜索文档",
    searchAria: "搜索文档",
    backToDashboard: "返回控制台",
    loading: "正在加载文档...",
    loadingContent: "正在加载文档内容...",
    empty: "暂无文档。",
    emptySearch: "没有匹配的文档。",
    errorLabel: "文档错误",
    selectPrompt: "选择一篇文档阅读。",
    preview: "预览",
    source: "原文",
    copySource: "复制原文",
    path: "路径",
    status: "状态",
    size: "大小",
    rootGroup: "根目录",
    untitled: "未命名文档"
  },
  sessionDetail: {
    back: "会话",
    eyebrow: "Session 详情",
    details: "详情",
    hideDetails: "收起详情",
    sessionId: "Session ID",
    source: "来源",
    model: "历史模型",
    lastActive: "最后活跃",
    loading: "正在加载对话...",
    errorLabel: "Session 错误",
    empty: "该 session 暂无对话记录。",
    pageBlocks: (visible: string, total: string) => `当前页 ${visible} / 总 ${total} 对话块`,
    rawMessages: (count: string) => `原始消息 ${count} 条`
  },
  message: {
    thinking: "思考",
    redactedThinking: "部分思考已加密，无法展示",
    toolCalls: "工具调用",
    toolResult: "工具结果",
    toolResultError: "工具结果错误",
    copyResult: "复制结果",
    toolActivity: "工具活动",
    toolOperation: "工具操作",
    toolContinuation: "工具操作续段",
    calls: "调用",
    results: "结果",
    error: "错误"
  },
  models: {
    model: "模型",
    current: "当前",
    switching: "切换中",
    setCurrent: "设为当前",
    context: "上下文",
    output: "输出",
    vision: "视觉",
    thinking: "思考",
    modelOptionUnavailable: "模型选项不可用",
    providerNotSelectable: "WebUI 暂不支持切换",
    missingApiKey: "缺少 API Key"
  },
  tools: {
    itemUnit: "个工具",
    emptyToolset: "该 toolset 暂无可展示工具。"
  },
  tasks: {
    empty: "暂无后台任务。",
    itemUnit: "个任务",
    task: "任务",
    status: "状态",
    session: "Session",
    command: "命令",
    duration: "耗时",
    startedAt: "开始时间"
  },
  skills: {
    itemUnit: "个技能",
    empty: "当前 agent 暂无可用 skill。",
    refs: (count: string) => `${count} 个引用`,
    defaultGroup: "默认",
    uncategorized: "未分类"
  },
  skillModal: {
    location: "位置",
    references: "引用文件",
    loadingReference: "加载中...",
    noReferences: "无引用文件。",
    copySource: "复制原文",
    loadingContent: "正在加载 skill 内容...",
    modeAria: "Skill 内容展示模式",
    preview: "预览",
    source: "原文"
  },
  detailModal: {
    tool: "工具",
    skill: "技能",
    task: "后台任务",
    close: "关闭",
    inputSchema: "输入结构",
    status: "状态",
    sessionTitle: "会话标题",
    session: "Session",
    turn: "Turn",
    card: "Card",
    pid: "PID",
    started: "开始时间",
    ended: "结束时间",
    duration: "耗时",
    exitCode: "退出码",
    cwd: "CWD",
    command: "命令",
    outputTail: "输出尾部",
    noOutput: "无输出"
  },
  skillTypes: {
    default: "默认",
    amazon_fba: "Amazon FBA",
    amazon_replenish: "Amazon Replenish",
    uncategorized: "未分类"
  },
  mermaid: {
    renderError: (message: string) => `Mermaid 渲染错误：${message}`,
    rendering: "正在渲染 Mermaid 图..."
  },
  errors: {
    dashboardLoad: "Dashboard 数据加载中...",
    api: "API 错误"
  }
};

type UiText = typeof ZH_TEXT;

const UI_TEXT: Record<Language, UiText> = {
  zh: ZH_TEXT,
  en: {
    language: {
      label: "Language",
      zh: "中文",
      en: "EN"
    },
    app: {
      eyebrow: "Local Harness Agent",
      title: "Agent Dashboard",
      subtitle: "Sessions, models, tools and skills from the running gateway.",
      apiOnline: "API online",
      apiOffline: "API offline"
    },
    nav: {
      sessions: "Sessions",
      docs: "Docs",
      models: "Models",
      tools: "Tools",
      skills: "Skills",
      tasks: "Tasks",
      aria: "Dashboard sections"
    },
    sidebar: {
      brand: "Agent",
      collapse: "Collapse sidebar",
      expand: "Expand sidebar"
    },
    home: {
      title: "Welcome to Agent Dashboard",
      subtitle: "Open Sessions to review history, or use the sidebar to view Models, Tools, Skills, Tasks, and Docs."
    },
    stats: {
      sessions: "Sessions",
      toolCalls: "Tool Calls",
      tokens: "Tokens",
      messages: "Messages",
      apiCalls: "API Calls"
    },
    common: {
      loading: "loading",
      copied: "Copied",
      unknown: "unknown",
      unnamedSession: "Untitled session",
      previous: "Previous",
      next: "Next",
      pageIndex: (current: string, total: string) => `Page ${current} / ${total}`,
      errorPrefix: (label: string, message: string) => `${label}: ${message}`,
      countItems: (count: string, unit: string) => `${count} ${unit}`,
      yes: "yes",
      no: "no",
      none: "none",
      notSupported: "not supported",
      fallbackTool: "tool",
      block: "block"
    },
    role: {
      user: "user",
      assistant: "assistant",
      tool: "tool",
      system: "system",
      unknown: "unknown"
    },
    sessions: {
      title: "Sessions",
      searchPlaceholder: "Search sessions",
      searchAria: "Search sessions",
      selectPrompt: "Select a session to view details.",
      searchResults: (count: string) => `${count} search results`,
      total: (count: string) => `${count} total`,
      empty: "No sessions yet.",
      emptySearch: "No matching sessions.",
      loading: "Loading sessions...",
      errorLabel: "Sessions error",
      columnSession: "Session",
      tokenSuffix: "Token"
    },
    docs: {
      title: "Docs",
      searchPlaceholder: "Search docs",
      searchAria: "Search docs",
      backToDashboard: "Back to dashboard",
      loading: "Loading docs...",
      loadingContent: "Loading document...",
      empty: "No docs found.",
      emptySearch: "No matching docs.",
      errorLabel: "Docs error",
      selectPrompt: "Select a document to read.",
      preview: "Preview",
      source: "Source",
      copySource: "Copy source",
      path: "Path",
      status: "Status",
      size: "Size",
      rootGroup: "Root",
      untitled: "Untitled doc"
    },
    sessionDetail: {
      back: "Sessions",
      eyebrow: "Session Detail",
      details: "Details",
      hideDetails: "Hide details",
      sessionId: "Session ID",
      source: "Source",
      model: "Historical model",
      lastActive: "Last active",
      loading: "Loading conversation...",
      errorLabel: "Session error",
      empty: "This session has no conversation records.",
      pageBlocks: (visible: string, total: string) => `${visible} / ${total} conversation blocks on this page`,
      rawMessages: (count: string) => `${count} raw messages`
    },
    message: {
      thinking: "Thinking",
      redactedThinking: "Some thinking is encrypted and cannot be displayed",
      toolCalls: "tool calls",
      toolResult: "tool result",
      toolResultError: "tool result error",
      copyResult: "Copy result",
      toolActivity: "tool activity",
      toolOperation: "Tool activity",
      toolContinuation: "Tool activity continuation",
      calls: "calls",
      results: "results",
      error: "error"
    },
    models: {
      model: "Model",
      current: "Current",
      switching: "Switching",
      setCurrent: "Set current",
      context: "Context",
      output: "Output",
      vision: "Vision",
      thinking: "Thinking",
      modelOptionUnavailable: "Model option is not available",
      providerNotSelectable: "Not selectable in WebUI",
      missingApiKey: "Missing API key"
    },
    tools: {
      itemUnit: "tools",
      emptyToolset: "This toolset has no tools to show."
    },
    tasks: {
      empty: "No background tasks.",
      itemUnit: "tasks",
      task: "Task",
      status: "Status",
      session: "Session",
      command: "Command",
      duration: "Duration",
      startedAt: "Started"
    },
    skills: {
      itemUnit: "skills",
      empty: "No skills are available for the current agent.",
      refs: (count: string) => `${count} refs`,
      defaultGroup: "Default",
      uncategorized: "Uncategorized"
    },
    skillModal: {
      location: "Location",
      references: "References",
      loadingReference: "loading...",
      noReferences: "No references.",
      copySource: "Copy source",
      loadingContent: "Loading skill content...",
      modeAria: "Skill content display mode",
      preview: "Preview",
      source: "Source"
    },
    detailModal: {
      tool: "Tool",
      skill: "Skill",
      task: "Background Task",
      close: "Close",
      inputSchema: "Input schema",
      status: "Status",
      sessionTitle: "Session title",
      session: "Session",
      turn: "Turn",
      card: "Card",
      pid: "PID",
      started: "Started",
      ended: "Ended",
      duration: "Duration",
      exitCode: "Exit code",
      cwd: "CWD",
      command: "Command",
      outputTail: "Output tail",
      noOutput: "no output"
    },
    skillTypes: {
      default: "Default",
      amazon_fba: "Amazon FBA",
      amazon_replenish: "Amazon Replenish",
      uncategorized: "Uncategorized"
    },
    mermaid: {
      renderError: (message: string) => `Mermaid render error: ${message}`,
      rendering: "Rendering Mermaid diagram..."
    },
    errors: {
      dashboardLoad: "Loading dashboard data...",
      api: "API error"
    }
  }
};

const I18nContext = React.createContext<UiText>(ZH_TEXT);

function useUiText(): UiText {
  return React.useContext(I18nContext);
}

function isLanguage(value: string | null): value is Language {
  return value === "zh" || value === "en";
}

function initialLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : "zh";
  } catch {
    return "zh";
  }
}

type DashboardData = {
  skills: ApiList<SkillPayload>;
  toolsets: ApiList<ToolsetPayload>;
  backgroundTasks: ApiList<BackgroundTaskPayload>;
  models: ApiList<ModelPayload>;
  currentModel: ModelPayload | null;
};

type DetailTarget =
  | { type: "tool"; item: ToolPayload; title: string }
  | { type: "skill"; item: SkillPayload; title: string }
  | { type: "task"; item: BackgroundTaskPayload; title: string }
  | null;

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const MERMAID_LANGUAGE_PATTERN = /\blanguage-mermaid\b/;

type MermaidApi = typeof import("mermaid").default;

let mermaidLoader: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base"
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const isExternal = Boolean(href && /^(https?:)?\/\//i.test(href));
    return (
      <a
        {...props}
        href={href}
        rel={isExternal ? "noreferrer noopener" : undefined}
        target={isExternal ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  },
  pre({ children, ...props }) {
    const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
      const className = String(child.props.className || "");
      if (MERMAID_LANGUAGE_PATTERN.test(className)) {
        return <MermaidBlock chart={String(child.props.children || "").replace(/\n$/, "")} />;
      }
    }
    return <pre {...props}>{children}</pre>;
  },
  code({ className, children, ...props }) {
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  }
};

function docsMarkdownComponents(currentPath: string, onNavigate: (path: string) => void): Components {
  return {
    ...markdownComponents,
    a({ href, children, ...props }) {
      const docPath = resolveDocsMarkdownHref(currentPath, href);
      if (docPath) {
        return (
          <a
            {...props}
            href={docsHrefForPath(docPath)}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(docPath);
            }}
          >
            {children}
          </a>
        );
      }
      const isExternal = Boolean(href && /^(https?:)?\/\//i.test(href));
      return (
        <a
          {...props}
          href={href}
          rel={isExternal ? "noreferrer noopener" : undefined}
          target={isExternal ? "_blank" : undefined}
        >
          {children}
        </a>
      );
    }
  };
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function patchJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (body.detail) {
        detail = String(body.detail);
      }
    } catch {
      // Keep the HTTP status fallback.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

function modelThinkingLevelLabel(model: ModelPayload, level: string): string {
  const normalized = String(level || "").trim().toLowerCase();
  return model.thinking_level_labels[normalized] || normalized || "-";
}

function modelWithThinkingLevel(model: ModelPayload, level: string): ModelPayload {
  const normalized = String(level || "").trim().toLowerCase();
  return {
    ...model,
    thinking_state: {
      enabled: normalized !== "off",
      level: normalized,
      editable: Boolean(model.thinking_state?.editable)
    }
  };
}

function defaultEnabledThinkingLevel(model: Pick<ModelPayload, "thinking_levels" | "thinking_default">): string {
  const levels = model.thinking_levels || [];
  const defaultLevel = String(model.thinking_default || "").trim().toLowerCase();
  if (defaultLevel && defaultLevel !== "off" && levels.includes(defaultLevel)) {
    return defaultLevel;
  }
  return levels.find((level) => level !== "off") || "off";
}

function thinkingStateForModelOption(option: ModelOptionPayload, previous?: ThinkingStatePayload): ThinkingStatePayload {
  const levels = option.thinking_levels || [];
  const editable = levels.includes("off");
  if (!previous?.enabled) {
    return {
      enabled: false,
      level: "off",
      editable
    };
  }
  const previousLevel = String(previous.level || "").trim().toLowerCase();
  const nextLevel = levels.includes(previousLevel) ? previousLevel : defaultEnabledThinkingLevel(option);
  return {
    enabled: nextLevel !== "off",
    level: nextLevel,
    editable
  };
}

function modelWithOption(
  model: ModelPayload,
  option: ModelOptionPayload,
  previousThinking?: ThinkingStatePayload
): ModelPayload {
  return {
    ...model,
    model: option.model,
    thinking_request_style: option.thinking_request_style,
    thinking_levels: option.thinking_levels,
    thinking_level_labels: option.thinking_level_labels,
    thinking_default: option.thinking_default,
    thinking_state: thinkingStateForModelOption(option, previousThinking ?? model.thinking_state),
    capabilities: option.capabilities
  };
}

function modelDisabledReasonLabel(t: UiText, reason: string): string {
  if (reason === "not selectable in WebUI") {
    return t.models.providerNotSelectable;
  }
  if (reason === "missing API key") {
    return t.models.missingApiKey;
  }
  return reason;
}

function dataWithCurrentModel(current: DashboardData, model: ModelPayload): DashboardData {
  return {
    ...current,
    currentModel: model,
    models: {
      ...current.models,
      items: current.models.items.map((item) =>
        item.provider === model.provider ? { ...item, ...model } : item
      )
    }
  };
}

function normalizeSessionList(payload: SessionListPayload): SessionListPayload {
  const summary = payload.summary || EMPTY_SESSION_SUMMARY;
  return {
    ...payload,
    items: Array.isArray(payload.items) ? payload.items : [],
    total: Math.max(0, Number(payload.total) || 0),
    limit: Math.max(1, Number(payload.limit) || SESSION_LIST_PAGE_SIZE),
    offset: Math.max(0, Number(payload.offset) || 0),
    summary: {
      total_sessions: Math.max(0, Number(summary.total_sessions) || 0),
      tool_call_count: Math.max(0, Number(summary.tool_call_count) || 0),
      token_count: Math.max(0, Number(summary.token_count) || 0)
    }
  };
}

function mergeSessionLists(current: SessionListPayload, next: SessionListPayload): SessionListPayload {
  const seen = new Set<string>();
  const items: SessionPayload[] = [];
  [...current.items, ...next.items].forEach((session) => {
    if (seen.has(session.session_id)) {
      return;
    }
    seen.add(session.session_id);
    items.push(session);
  });
  return {
    ...next,
    items
  };
}

function normalizeProjectDocs(payload: ApiList<ProjectDocPayload>): ApiList<ProjectDocPayload> {
  return {
    ...payload,
    items: Array.isArray(payload.items) ? payload.items : [],
    total: Math.max(0, Number(payload.total) || 0)
  };
}

function compareDocsTreeNode(a: DocsTreeNode, b: DocsTreeNode): number {
  if (a.kind !== b.kind) {
    return a.kind === "folder" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function sortDocsTreeNodes(nodes: DocsTreeNode[]): DocsTreeNode[] {
  nodes.sort(compareDocsTreeNode);
  nodes.forEach((node) => {
    if (node.kind === "folder") {
      sortDocsTreeNodes(node.children);
    }
  });
  return nodes;
}

function findOrCreateDocsFolder(parent: DocsTreeFolderNode, name: string): DocsTreeFolderNode {
  const existing = parent.children.find((node): node is DocsTreeFolderNode => node.kind === "folder" && node.name === name);
  if (existing) {
    return existing;
  }
  const path = parent.path ? `${parent.path}/${name}` : name;
  const folder: DocsTreeFolderNode = {
    kind: "folder",
    name,
    path,
    children: []
  };
  parent.children.push(folder);
  return folder;
}

function buildDocsTree(docs: ProjectDocPayload[]): DocsTreeNode[] {
  const root: DocsTreeFolderNode = {
    kind: "folder",
    name: "",
    path: "",
    children: []
  };
  const rootFiles: DocsTreeFileNode[] = [];

  docs.forEach((doc) => {
    const safePath = normalizeDocPath(doc.path);
    if (!safePath) {
      return;
    }
    const parts = safePath.split("/").filter(Boolean);
    const fileName = parts.pop() || doc.title || safePath;
    const fileNode: DocsTreeFileNode = {
      kind: "file",
      name: fileName,
      path: safePath,
      doc
    };
    if (!parts.length) {
      rootFiles.push(fileNode);
      return;
    }
    let folder = root;
    parts.forEach((part) => {
      folder = findOrCreateDocsFolder(folder, part);
    });
    folder.children.push(fileNode);
  });

  const nodes = sortDocsTreeNodes(root.children);
  if (rootFiles.length) {
    nodes.push(...sortDocsTreeNodes(rootFiles));
  }
  return nodes;
}

function docsAncestorFolders(path: string): string[] {
  const parts = normalizeDocPath(path).split("/").filter(Boolean);
  parts.pop();
  const ancestors: string[] = [];
  let current = "";
  parts.forEach((part) => {
    current = current ? `${current}/${part}` : part;
    ancestors.push(current);
  });
  return ancestors;
}

function formatDate(value: number): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value * 1000));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Number(value) || 0));
}

function formatDuration(value: number | null | undefined): string {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) {
    return "-";
  }
  return `${duration.toFixed(duration >= 10 ? 0 : 1)}s`;
}

function sourceLabel(source: SourceSummary | Record<string, unknown>): string {
  const platform = String(source.platform || "unknown");
  const chatType = String(source.chat_type || "");
  return [platform, chatType].filter(Boolean).join(" / ");
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function encodePathSegments(value: string): string {
  return String(value || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodePathSegments(value: string): string {
  return String(value || "")
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function normalizeDocPath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function routeStateFromLocation(useHistoryState = true): { tab: string; docPath: string } {
  const pathname = window.location.pathname;
  if (pathname === DOCS_ROUTE_PREFIX || pathname.startsWith(`${DOCS_ROUTE_PREFIX}/`)) {
    const docPath = pathname.startsWith(`${DOCS_ROUTE_PREFIX}/`)
      ? normalizeDocPath(decodePathSegments(pathname.slice(DOCS_ROUTE_PREFIX.length + 1)))
      : "";
    return { tab: "docs", docPath };
  }
  const tab = useHistoryState && typeof window.history.state?.tab === "string" ? window.history.state.tab : "home";
  return { tab: DASHBOARD_TAB_IDS.has(tab) ? tab : "home", docPath: "" };
}

function docsHrefForPath(path: string): string {
  const safePath = normalizeDocPath(path);
  return safePath ? `${DOCS_ROUTE_PREFIX}/${encodePathSegments(safePath)}` : DOCS_ROUTE_PREFIX;
}

function markdownWithoutFrontMatter(markdown: string): string {
  return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function resolveDocsMarkdownHref(currentPath: string, href: string | undefined): string {
  const rawHref = String(href || "").trim();
  if (!rawHref || rawHref.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(rawHref) || rawHref.startsWith("//")) {
    return "";
  }
  const withoutHash = rawHref.split("#", 1)[0].split("?", 1)[0];
  if (!withoutHash.toLowerCase().endsWith(".md")) {
    return "";
  }
  const baseParts = normalizeDocPath(currentPath).split("/").filter(Boolean).slice(0, -1);
  const parts = [...baseParts, ...withoutHash.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (!resolved.length) {
        return "";
      }
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return normalizeDocPath(resolved.join("/"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text || "";
}

function shortText(value: unknown, limit = 2200): string {
  const text = displayText(value);
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
}

function sanitizeForDisplay(value: unknown, options: { truncateStrings?: boolean } = {}): unknown {
  const truncateStrings = options.truncateStrings ?? true;
  if (typeof value === "string") {
    return truncateStrings && value.length > 600 ? `${value.slice(0, 600)}... [${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDisplay(item, options));
  }
  if (!isRecord(value)) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "data" || key === "base64") && typeof item === "string" && item.length > 120) {
      cleaned[key] = `[omitted ${item.length} chars]`;
    } else {
      cleaned[key] = sanitizeForDisplay(item, options);
    }
  }
  return cleaned;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}

function roleLabel(role: string): string {
  const normalized = String(role || "unknown").toLowerCase();
  if (["user", "assistant", "tool", "system"].includes(normalized)) {
    return normalized;
  }
  return "unknown";
}

function RoleBadge({ role }: { role: string }) {
  const t = useUiText();
  const normalized = roleLabel(role);
  const label = t.role[normalized as keyof typeof t.role] || normalized;
  const icon =
    normalized === "user" ? (
      <UserRound aria-hidden="true" size={13} />
    ) : normalized === "assistant" ? (
      <Brain aria-hidden="true" size={13} />
    ) : normalized === "tool" ? (
      <Wrench aria-hidden="true" size={13} />
    ) : normalized === "system" ? (
      <Settings2 aria-hidden="true" size={13} />
    ) : (
      <Info aria-hidden="true" size={13} />
    );

  return (
    <span className={`role-badge role-${normalized}`}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone = "neutral"
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "neutral" | "green" | "blue" | "amber";
}) {
  return (
    <div className={`stat-tile stat-${tone}`}>
      <div className="stat-icon">{icon}</div>
      <div>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="empty-state">
      <Info size={18} />
      <span>{label}</span>
    </div>
  );
}

function DashboardHome() {
  const t = useUiText();
  return (
    <section className="dashboard-home" aria-labelledby="dashboard-home-title">
      <div className="dashboard-home-copy">
        <h2 id="dashboard-home-title">{t.home.title}</h2>
        <p>{t.home.subtitle}</p>
      </div>
    </section>
  );
}

function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="message-markdown">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MessageBlock({ block }: { block: unknown }) {
  const t = useUiText();
  if (!isRecord(block)) {
    return (
      <pre className="message-json">{shortText(sanitizeForDisplay(block))}</pre>
    );
  }
  const type = String(block.type || "unknown");
  if (type === "text") {
    return <MessageMarkdown text={String(block.text || "")} />;
  }
  if (type === "thinking") {
    return <ThinkingBlock block={block} />;
  }
  if (type === "redacted_thinking") {
    return <RedactedThinkingBlock />;
  }
  if (type === "tool_use" || type === "tool_call") {
    const input = block.input ?? block.arguments ?? {};
    const blockName = String(block.name || "");
    return (
      <div className="message-block tool-block">
        <div className="block-title">
          <Wrench size={14} />
          <span>{blockName === "__tool_calls__" ? t.message.toolCalls : blockName || t.common.fallbackTool}</span>
          {block.id ? <code>{String(block.id)}</code> : null}
        </div>
        <pre className="message-json">{shortText(sanitizeForDisplay(input))}</pre>
      </div>
    );
  }
  if (type === "tool_result") {
    return <ToolResultBlock block={block} />;
  }
  if (type === "image" || type === "file") {
    return (
      <div className="message-block media-block">
        <div className="block-title">
          <FileText size={14} />
          <span>{type} {t.common.block}</span>
        </div>
        <pre className="message-json">{shortText(sanitizeForDisplay(block))}</pre>
      </div>
    );
  }
  return (
    <div className="message-block">
      <div className="block-title">
        <Info size={14} />
        <span>{type}</span>
      </div>
      <pre className="message-json">{shortText(sanitizeForDisplay(block))}</pre>
    </div>
  );
}

function ThinkingBlock({ block }: { block: Record<string, unknown> }) {
  const t = useUiText();
  const [expanded, setExpanded] = useState(false);
  const thinking = String(block.thinking || "").trim();
  const canExpand = Boolean(thinking);

  return (
    <div className="message-block thinking-block">
      <button
        aria-expanded={expanded}
        className="block-title block-title-split thinking-block-toggle"
        disabled={!canExpand}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <div className="block-title-main">
          <Brain size={14} />
          <span>{t.message.thinking}</span>
        </div>
      </button>
      {expanded && canExpand ? (
        <div className="thinking-block-body">
          <div className="message-text">{thinking}</div>
        </div>
      ) : null}
    </div>
  );
}

function RedactedThinkingBlock() {
  const t = useUiText();
  return (
    <div className="message-block thinking-block redacted">
      <div className="block-title">
        <Brain size={14} />
        <span>{t.message.thinking}</span>
      </div>
      <div className="thinking-block-body">
        <div className="muted">{t.message.redactedThinking}</div>
      </div>
    </div>
  );
}

function ToolResultBlock({ block }: { block: Record<string, unknown> }) {
  const t = useUiText();
  const [copied, setCopied] = useState(false);
  const resultText = displayText(sanitizeForDisplay(block.content ?? "", { truncateStrings: false }));
  const copyLabel = copied ? t.common.copied : t.message.copyResult;

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(resultText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={block.is_error ? "message-block result-block error" : "message-block result-block"}>
      <div className="block-title block-title-split">
        <div className="block-title-main">
          <PackageCheck size={14} />
          <span>{block.is_error ? t.message.toolResultError : t.message.toolResult}</span>
          {block.tool_call_id ? <code>{String(block.tool_call_id)}</code> : null}
        </div>
        <div className="tool-result-actions">
          <button className="tool-result-button" type="button" onClick={handleCopy}>
            {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
            <span>{copyLabel}</span>
          </button>
        </div>
      </div>
      <pre className="message-json tool-result-full">{resultText}</pre>
    </div>
  );
}

function MessageContent({ content, message }: { content: unknown; message: SessionMessage }) {
  const t = useUiText();
  const toolCalls = message.tool_calls;
  return (
    <div className="message-content">
      {typeof content === "string" ? <MessageMarkdown text={content} /> : null}
      {Array.isArray(content) ? (
        <div className="message-block-list">
          {content.map((block, index) => (
            <MessageBlock block={block} key={index} />
          ))}
        </div>
      ) : null}
      {content !== undefined && typeof content !== "string" && !Array.isArray(content) ? (
        <pre className="message-json">{shortText(sanitizeForDisplay(content))}</pre>
      ) : null}
      {toolCalls ? (
        <div className="message-block tool-block">
          <div className="block-title">
            <Wrench size={14} />
            <span>{t.message.toolCalls}</span>
          </div>
          <pre className="message-json">{shortText(sanitizeForDisplay(toolCalls))}</pre>
        </div>
      ) : null}
    </div>
  );
}

function blockType(block: unknown): string {
  return isRecord(block) ? String(block.type || "") : "";
}

function isToolCallBlock(block: unknown): boolean {
  const type = blockType(block);
  return type === "tool_use" || type === "tool_call";
}

function isToolResultBlock(block: unknown): boolean {
  return blockType(block) === "tool_result";
}

function isPureToolAssistantMessage(message: SessionMessage): boolean {
  if (roleLabel(message.role) !== "assistant") {
    return false;
  }
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every(isToolCallBlock);
}

function isToolGroupMessage(message: SessionMessage): boolean {
  return isPureToolAssistantMessage(message) || roleLabel(message.role) === "tool";
}

function splitAssistantInlineToolCalls(message: SessionMessage): {
  message: SessionMessage;
  toolCallMessage: SessionMessage | null;
} {
  if (roleLabel(message.role) !== "assistant") {
    return { message, toolCallMessage: null };
  }

  const content = message.content;
  const contentToolCalls = Array.isArray(content) ? content.filter(isToolCallBlock) : [];
  const nonToolContent = Array.isArray(content) ? content.filter((block) => !isToolCallBlock(block)) : null;
  const hasFallbackToolCalls = message.tool_calls !== undefined && message.tool_calls !== null;

  if (!contentToolCalls.length && !hasFallbackToolCalls) {
    return { message, toolCallMessage: null };
  }

  const visibleMessage: SessionMessage = { ...message };
  if (nonToolContent) {
    if (nonToolContent.length) {
      visibleMessage.content = nonToolContent;
    } else {
      delete visibleMessage.content;
    }
  }
  delete visibleMessage.tool_calls;

  const toolContent = [...contentToolCalls];
  if (!contentToolCalls.length && hasFallbackToolCalls) {
    toolContent.push({
      type: "tool_call",
      name: "__tool_calls__",
      input: message.tool_calls
    });
  }

  const toolCallMessage: SessionMessage = {
    ...message,
    content: toolContent
  };
  delete toolCallMessage.tool_calls;

  return { message: visibleMessage, toolCallMessage };
}

function buildConversationItems(messages: SessionMessage[]): ConversationRenderItem[] {
  const items: ConversationRenderItem[] = [];
  let pending: SessionMessage[] = [];
  let pendingStart = 0;

  const flushPending = () => {
    if (!pending.length) {
      return;
    }
    const group: ConversationToolGroup = {
      messages: pending,
      startIndex: pendingStart,
      key: `tools-${pendingStart}-${pending.length}`,
    };
    const previous = items[items.length - 1];
    if (previous?.type === "message" && roleLabel(previous.message.role) === "assistant") {
      const existingGroup = previous.toolGroups[previous.toolGroups.length - 1];
      if (existingGroup) {
        existingGroup.messages.push(...pending);
      } else {
        previous.toolGroups.push(group);
      }
    } else {
      items.push({ type: "tool_group", group });
    }
    pending = [];
  };

  messages.forEach((message, index) => {
    if (isToolGroupMessage(message)) {
      if (!pending.length) {
        pendingStart = index;
      }
      pending.push(message);
      return;
    }
    flushPending();
    const splitMessage = splitAssistantInlineToolCalls(message);
    const item: Extract<ConversationRenderItem, { type: "message" }> = {
      type: "message",
      message: splitMessage.message,
      index,
      toolGroups: []
    };
    if (splitMessage.toolCallMessage) {
      item.toolGroups.push({
        messages: [splitMessage.toolCallMessage],
        startIndex: index,
        key: `tools-${index}-inline`
      });
    }
    items.push(item);
  });
  flushPending();
  return items;
}

function toolCallBlocks(message: SessionMessage): unknown[] {
  const content = message.content;
  if (Array.isArray(content)) {
    return content.filter(isToolCallBlock);
  }
  return [];
}

function toolResultBlocks(message: SessionMessage): unknown[] {
  const content = message.content;
  if (Array.isArray(content)) {
    return content.filter(isToolResultBlock);
  }
  return [];
}

function messageToolNames(message: SessionMessage): string[] {
  const names: string[] = [];
  for (const block of toolCallBlocks(message)) {
    if (isRecord(block)) {
      const name = String(block.name || "").trim();
      if (name) {
        names.push(name);
      }
    }
  }
  const toolName = String(message.tool_name || "").trim();
  if (toolName) {
    names.push(toolName);
  }
  return names;
}

function toolGroupStats(messages: SessionMessage[], t: UiText) {
  let callCount = 0;
  let resultCount = 0;
  let hasError = false;
  const names: string[] = [];

  for (const message of messages) {
    const calls = toolCallBlocks(message);
    const results = toolResultBlocks(message);
    callCount += calls.length;
    if (roleLabel(message.role) === "tool") {
      resultCount += Math.max(results.length, 1);
    } else {
      resultCount += results.length;
    }
    for (const result of results) {
      if (isRecord(result) && result.is_error) {
        hasError = true;
      }
    }
    names.push(...messageToolNames(message));
  }

  const uniqueNames = Array.from(new Set(names)).slice(0, 3);
  return {
    callCount,
    resultCount,
    hasError,
    summary: uniqueNames.length ? uniqueNames.join(", ") : t.message.toolActivity,
  };
}

function ToolTurnGroup({
  group,
  expanded,
  embedded = false,
  onToggle
}: {
  group: ConversationToolGroup;
  expanded: boolean;
  embedded?: boolean;
  onToggle: () => void;
}) {
  const t = useUiText();
  const stats = toolGroupStats(group.messages, t);
  const className = [
    "tool-turn-group",
    embedded ? "embedded" : "standalone",
    stats.hasError ? "has-error" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={className}>
      <button
        className="tool-turn-summary"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <div>
          <div className="tool-turn-title">
            {embedded ? t.message.toolOperation : t.message.toolContinuation} · {formatNumber(stats.callCount)}{" "}
            {t.message.calls} · {formatNumber(stats.resultCount)} {t.message.results}
          </div>
          <div className="tool-turn-subtitle">{stats.summary}</div>
        </div>
        {stats.hasError ? <span className="pill warn">{t.message.error}</span> : null}
      </button>
      {expanded ? (
        <div className="tool-turn-body">
          {group.messages.map((message, index) => {
            const role = roleLabel(message.role);
            return (
              <div className="tool-turn-message" key={`${group.key}-${index}`}>
                <div className="message-header">
                  <RoleBadge role={role} />
                  {message.tool_name ? <span className="muted">{message.tool_name}</span> : null}
                  {message.tool_call_id ? <code>{message.tool_call_id}</code> : null}
                </div>
                <MessageContent content={message.content} message={message} />
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function SessionDetailView({
  fallbackSession,
  detail,
  loading,
  error,
  pageLoading,
  pageError,
  onPageChange
}: {
  fallbackSession: SessionPayload;
  detail: SessionDetailPayload | null;
  loading: boolean;
  error: string;
  pageLoading: boolean;
  pageError: string;
  onPageChange: (page: number) => void;
}) {
  const t = useUiText();
  const session = detail?.session || fallbackSession;
  const messages = detail?.messages || [];
  const page = detail?.messages_page;
  const visibleItemCount = page ? Math.max(0, page.end - page.start) : 0;
  const renderItems = useMemo(() => buildConversationItems(messages), [messages]);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setSessionInfoOpen(false);
  }, [session.session_id]);
  const detailItems = [
    { label: t.sessionDetail.sessionId, value: session.session_id, mono: true },
    { label: t.sessionDetail.source, value: sourceLabel(session.source_summary || session.source) },
    { label: t.sessionDetail.model, value: session.model || "-" },
    { label: t.sessionDetail.lastActive, value: formatDate(session.last_active_at) },
    { label: t.stats.messages, value: formatNumber(session.message_count) },
    { label: t.stats.toolCalls, value: formatNumber(session.tool_call_count) },
    { label: t.stats.tokens, value: formatNumber(session.input_tokens + session.output_tokens) },
    { label: t.stats.apiCalls, value: formatNumber(session.api_call_count) }
  ];
  const toggleToolGroup = (key: string) => {
    setExpandedToolGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  return (
    <div className="session-detail">
      <div className="session-detail-toolbar">
        <button
          className="session-detail-toggle"
          type="button"
          aria-expanded={sessionInfoOpen}
          onClick={() => setSessionInfoOpen((current) => !current)}
        >
          <Info size={15} />
          <span>{sessionInfoOpen ? t.sessionDetail.hideDetails : t.sessionDetail.details}</span>
          <ChevronRight size={15} className={sessionInfoOpen ? "expanded" : ""} />
        </button>
      </div>
      {sessionInfoOpen ? (
        <section className="session-detail-panel">
          <div className="session-detail-grid">
            {detailItems.map((item) => (
              <div className="session-detail-field" key={item.label}>
                <span>{item.label}</span>
                <strong className={item.mono ? "mono" : ""}>{item.value}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {loading ? <EmptyState label={t.sessionDetail.loading} /> : null}
      {error ? <EmptyState label={t.common.errorPrefix(t.sessionDetail.errorLabel, error)} /> : null}
      {!loading && !error ? (
        messages.length ? (
          <>
            <div className="message-list">
              {renderItems.map((item, itemIndex) => {
                if (item.type === "tool_group") {
                  return (
                    <ToolTurnGroup
                      expanded={expandedToolGroups.has(item.group.key)}
                      group={item.group}
                      key={item.group.key}
                      onToggle={() => toggleToolGroup(item.group.key)}
                    />
                  );
                }
                const { message, index, toolGroups } = item;
                const role = roleLabel(message.role);
                const previousItem = renderItems[itemIndex - 1];
                const nextItem = renderItems[itemIndex + 1];
                const previousIsAssistant =
                  previousItem?.type === "message" && roleLabel(previousItem.message.role) === "assistant";
                const nextIsAssistant =
                  nextItem?.type === "message" && roleLabel(nextItem.message.role) === "assistant";
                const showRoleBadge = !(role === "assistant" && previousIsAssistant);
                const hasMessageHeader = showRoleBadge || Boolean(message.tool_name || message.tool_call_id);
                const chainClass =
                  role === "assistant"
                    ? [
                        previousIsAssistant ? "assistant-chain-from-previous" : "",
                        nextIsAssistant ? "assistant-chain-to-next" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")
                    : "";
                return (
                  <article className={`message-card role-${role} ${chainClass}`} key={`${role}-${index}`}>
                    {hasMessageHeader ? (
                      <div className="message-header">
                        {showRoleBadge ? <RoleBadge role={role} /> : null}
                        {message.tool_name ? <span className="muted">{message.tool_name}</span> : null}
                        {message.tool_call_id ? <code>{message.tool_call_id}</code> : null}
                      </div>
                    ) : null}
                    <MessageContent content={message.content} message={message} />
                    {toolGroups.length ? (
                      <div className="assistant-tool-stack">
                        {toolGroups.map((group) => (
                          <ToolTurnGroup
                            embedded
                            expanded={expandedToolGroups.has(group.key)}
                            group={group}
                            key={group.key}
                            onToggle={() => toggleToolGroup(group.key)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            <div className="message-page-toolbar">
              <button
                className="page-nav-button"
                type="button"
                disabled={pageLoading || !page?.has_previous}
                onClick={() => page && onPageChange(page.current_page - 1)}
              >
                {t.common.previous}
              </button>
              <div className="message-page-center">
                <div className="message-page-count">
                  {t.sessionDetail.pageBlocks(formatNumber(visibleItemCount), formatNumber(page?.total || renderItems.length))}
                  {page ? <span> · {t.sessionDetail.rawMessages(formatNumber(page.raw_message_total))}</span> : null}
                </div>
                <div className="message-page-index">
                  {t.common.pageIndex(formatNumber(page?.current_page || 1), formatNumber(page?.total_pages || 1))}
                </div>
                {pageError ? <div className="message-page-error">{pageError}</div> : null}
              </div>
              <button
                className="page-nav-button"
                type="button"
                disabled={pageLoading || !page?.has_next}
                onClick={() => page && onPageChange(page.current_page + 1)}
              >
                {t.common.next}
              </button>
            </div>
          </>
        ) : (
          <EmptyState label={t.sessionDetail.empty} />
        )
      ) : null}
    </div>
  );
}

function SessionsIndex({
  sessions,
  query,
  searchOpen,
  searchFocusKey = 0,
  loading,
  error,
  hasMore,
  loadMoreError,
  selectedSessionId,
  onQueryChange,
  onLoadMore,
  onOpen
}: {
  sessions: SessionPayload[];
  query: string;
  searchOpen: boolean;
  searchFocusKey?: number;
  loading: boolean;
  error: string;
  hasMore: boolean;
  loadMoreError: string;
  selectedSessionId: string;
  onQueryChange: (value: string) => void;
  onLoadMore: () => void;
  onOpen: (session: SessionPayload) => void;
}) {
  const t = useUiText();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const trimmedQuery = query.trim();
  const emptyLabel = trimmedQuery ? t.sessions.emptySearch : t.sessions.empty;
  const showTable = sessions.length > 0;

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen, searchFocusKey]);

  function maybeLoadMore() {
    const list = sessionListRef.current;
    if (!list || loading || !hasMore || loadMoreError) {
      return;
    }
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceToBottom <= 80) {
      onLoadMore();
    }
  }

  useEffect(() => {
    maybeLoadMore();
  }, [sessions.length, loading, hasMore, loadMoreError]);

  return (
    <div className="session-index-panel">
      {searchOpen ? (
        <div className="search-box">
          <Search size={16} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t.sessions.searchPlaceholder}
            aria-label={t.sessions.searchAria}
          />
        </div>
      ) : null}
      {error ? <EmptyState label={t.common.errorPrefix(t.sessions.errorLabel, error)} /> : null}
      {!showTable && loading && !error ? <EmptyState label={t.sessions.loading} /> : null}
      {!showTable && !loading && !error ? <EmptyState label={emptyLabel} /> : null}
      {showTable ? (
        <div className="session-index-list" onScroll={maybeLoadMore} ref={sessionListRef}>
          {sessions.map((session) => {
            const selected = selectedSessionId === session.session_id;
            return (
              <button
                aria-current={selected ? "page" : undefined}
                className={selected ? "session-index-item active" : "session-index-item"}
                key={session.session_id}
                type="button"
                onClick={() => onOpen(session)}
              >
                <span className="primary-cell">{session.title || t.common.unnamedSession}</span>
                <span className="session-meta-line">
                  <span>{formatDate(session.last_active_at)}</span>
                  <span aria-hidden="true" className="session-meta-separator">
                    ·
                  </span>
                  <span>{formatNumber(session.input_tokens + session.output_tokens)} {t.sessions.tokenSuffix}</span>
                </span>
              </button>
            );
          })}
          {loading ? <span className="pill sessions-loading-pill">{t.common.loading}</span> : null}
          {loadMoreError ? (
            <div className="session-load-more-error">{t.common.errorPrefix(t.sessions.errorLabel, loadMoreError)}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DocsIndex({
  docs,
  query,
  loading,
  error,
  selectedPath,
  onQueryChange,
  onOpen
}: {
  docs: ProjectDocPayload[];
  query: string;
  loading: boolean;
  error: string;
  selectedPath: string;
  onQueryChange: (value: string) => void;
  onOpen: (path: string) => void;
}) {
  const t = useUiText();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const trimmedQuery = query.trim().toLowerCase();
  const treeNodes = useMemo(() => buildDocsTree(docs), [docs]);
  const filteredDocs = useMemo(() => {
    if (!trimmedQuery) {
      return docs;
    }
    return docs.filter((doc) =>
      [doc.title, doc.path, doc.section, doc.status]
        .join(" ")
        .toLowerCase()
        .includes(trimmedQuery)
    );
  }, [docs, trimmedQuery]);
  const showSearchResults = Boolean(trimmedQuery) && filteredDocs.length > 0;
  const showTree = !trimmedQuery && treeNodes.length > 0;
  const emptyLabel = trimmedQuery ? t.docs.emptySearch : t.docs.empty;

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const ancestors = docsAncestorFolders(selectedPath);
    if (!ancestors.length) {
      return;
    }
    setExpandedFolders((current) => {
      let changed = false;
      const next = new Set(current);
      ancestors.forEach((path) => {
        if (!next.has(path)) {
          next.add(path);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [selectedPath]);

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderTreeNode(node: DocsTreeNode, level: number): React.ReactNode {
    const depth = Math.min(level, 6);
    const depthStyle = { paddingLeft: `${8 + depth * 12}px` } as React.CSSProperties;
    if (node.kind === "folder") {
      const expanded = expandedFolders.has(node.path);
      return (
        <div className="docs-tree-folder" key={`folder:${node.path}`}>
          <button
            aria-expanded={expanded}
            className={expanded ? "docs-tree-folder-button expanded" : "docs-tree-folder-button"}
            onClick={() => toggleFolder(node.path)}
            style={depthStyle}
            type="button"
          >
            <ChevronRight size={14} />
            <span>{node.name}</span>
          </button>
          {expanded ? <div className="docs-tree-children">{node.children.map((child) => renderTreeNode(child, level + 1))}</div> : null}
        </div>
      );
    }
    const selected = selectedPath === node.path;
    return (
      <button
        aria-current={selected ? "page" : undefined}
        className={selected ? "docs-tree-file active" : "docs-tree-file"}
        key={`file:${node.path}`}
        onClick={() => onOpen(node.path)}
        style={depthStyle}
        title={node.path}
        type="button"
      >
        <FileText size={13} />
        <span className="docs-tree-file-copy">
          <span className="primary-cell">{node.doc.title || t.docs.untitled}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="docs-index-panel">
      <div className="search-box">
        <Search size={16} />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t.docs.searchPlaceholder}
          aria-label={t.docs.searchAria}
        />
      </div>
      {error ? <EmptyState label={t.common.errorPrefix(t.docs.errorLabel, error)} /> : null}
      {!showSearchResults && !showTree && loading && !error ? <EmptyState label={t.docs.loading} /> : null}
      {!showSearchResults && !showTree && !loading && !error ? <EmptyState label={emptyLabel} /> : null}
      {showSearchResults ? (
        <div className="docs-index-list">
          {filteredDocs.map((doc) => {
            const selected = selectedPath === doc.path;
            return (
              <button
                aria-current={selected ? "page" : undefined}
                className={selected ? "docs-index-item active" : "docs-index-item"}
                key={doc.path}
                type="button"
                onClick={() => onOpen(doc.path)}
                title={doc.path}
              >
                <span className="primary-cell">{doc.title || t.docs.untitled}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {showTree ? <div className="docs-tree-list">{treeNodes.map((node) => renderTreeNode(node, 0))}</div> : null}
    </div>
  );
}

function DocsView({
  doc,
  loading,
  error,
  mode,
  copied,
  onModeChange,
  onCopy,
  onNavigateDoc
}: {
  doc: ProjectDocContentPayload | null;
  loading: boolean;
  error: string;
  mode: DocsContentMode;
  copied: boolean;
  onModeChange: (mode: DocsContentMode) => void;
  onCopy: () => void;
  onNavigateDoc: (path: string) => void;
}) {
  const t = useUiText();
  const components = useMemo(
    () => docsMarkdownComponents(doc?.path || "", onNavigateDoc),
    [doc?.path, onNavigateDoc]
  );

  if (loading && !doc) {
    return <EmptyState label={t.docs.loadingContent} />;
  }
  if (error && !doc) {
    return <EmptyState label={t.common.errorPrefix(t.docs.errorLabel, error)} />;
  }
  if (!doc) {
    return <EmptyState label={t.docs.selectPrompt} />;
  }

  return (
    <div className="docs-view">
      <div className="docs-toolbar">
        <div className="docs-actions">
          <div className="skill-content-mode-row" role="group" aria-label={t.docs.title}>
            <button
              className={mode === "preview" ? "skill-mode-button active" : "skill-mode-button"}
              onClick={() => onModeChange("preview")}
              type="button"
            >
              {t.docs.preview}
            </button>
            <button
              className={mode === "source" ? "skill-mode-button active" : "skill-mode-button"}
              onClick={() => onModeChange("source")}
              type="button"
            >
              {t.docs.source}
            </button>
          </div>
          <button className="skill-copy-button" onClick={onCopy} type="button">
            {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
            <span>{copied ? t.common.copied : t.docs.copySource}</span>
          </button>
        </div>
      </div>
      {error ? <div className="skill-content-status error">{t.common.errorPrefix(t.docs.errorLabel, error)}</div> : null}
      {loading ? <div className="skill-content-status">{t.docs.loadingContent}</div> : null}
      {mode === "preview" ? (
        <div className="docs-markdown">
          <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
            {doc.content}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="docs-content-pre">{doc.content}</pre>
      )}
    </div>
  );
}

function DocsShell({
  docs,
  docsLoading,
  docsError,
  docQuery,
  selectedPath,
  doc,
  docLoading,
  docError,
  mode,
  copied,
  language,
  onLanguageChange,
  onDocQueryChange,
  onOpenDoc,
  onBackToDashboard,
  onModeChange,
  onCopy
}: {
  docs: ProjectDocPayload[];
  docsLoading: boolean;
  docsError: string;
  docQuery: string;
  selectedPath: string;
  doc: ProjectDocContentPayload | null;
  docLoading: boolean;
  docError: string;
  mode: DocsContentMode;
  copied: boolean;
  language: Language;
  onLanguageChange: (language: Language) => void;
  onDocQueryChange: (value: string) => void;
  onOpenDoc: (path: string) => void;
  onBackToDashboard: () => void;
  onModeChange: (mode: DocsContentMode) => void;
  onCopy: () => void;
}) {
  const t = useUiText();
  const docsContent = (() => {
    if (!selectedPath) {
      if (docsError) {
        return <EmptyState label={t.common.errorPrefix(t.docs.errorLabel, docsError)} />;
      }
      return <EmptyState label={docsLoading || docs.length ? t.docs.selectPrompt : t.docs.empty} />;
    }
    return (
      <DocsView
        doc={doc}
        loading={docLoading}
        error={docError}
        mode={mode}
        copied={copied}
        onModeChange={onModeChange}
        onCopy={onCopy}
        onNavigateDoc={onOpenDoc}
      />
    );
  })();

  return (
    <main className="docs-shell">
      <aside className="docs-shell-sidebar">
        <div className="docs-shell-sidebar-header">
          <div className="docs-shell-brand">
            <FileText size={18} />
            <span>{t.docs.title}</span>
          </div>
          <div className="docs-shell-sidebar-actions">
            <LanguageSwitch language={language} onLanguageChange={onLanguageChange} />
            <button className="docs-back-button" onClick={onBackToDashboard} type="button">
              <ArrowLeft size={15} />
              <span>{t.docs.backToDashboard}</span>
            </button>
          </div>
        </div>
        <DocsIndex
          docs={docs}
          query={docQuery}
          loading={docsLoading}
          error={docsError}
          selectedPath={selectedPath}
          onQueryChange={onDocQueryChange}
          onOpen={onOpenDoc}
        />
      </aside>
      <section className="docs-shell-main">
        <section className="docs-shell-content">{docsContent}</section>
      </section>
    </main>
  );
}

function ModelsView({
  models,
  current,
  modelSaving,
  thinkingSaving,
  onCurrentModelChange,
  onThinkingLevelChange
}: {
  models: ModelPayload[];
  current: ModelPayload | null;
  modelSaving: boolean;
  thinkingSaving: boolean;
  onCurrentModelChange: (provider: string, model: string) => void;
  onThinkingLevelChange: (level: string) => void;
}) {
  const t = useUiText();
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});

  useEffect(() => {
    setSelectedModels((existing) => {
      const next: Record<string, string> = {};
      models.forEach((model) => {
        const optionModels = model.model_options.map((option) => option.model);
        const existingSelection = existing[model.provider];
        if (existingSelection && optionModels.includes(existingSelection) && current?.provider !== model.provider) {
          next[model.provider] = existingSelection;
          return;
        }
        next[model.provider] = optionModels.includes(model.model) ? model.model : optionModels[0] || model.model;
      });
      return next;
    });
  }, [models, current?.provider]);

  return (
    <div className="grid-list models-grid">
      {models.map((model) => {
        const providerActive = current?.provider === model.provider;
        const selectedModel = selectedModels[model.provider] || model.model;
        const selectedOption =
          model.model_options.find((option) => option.model === selectedModel) ||
          model.model_options.find((option) => option.model === model.model) ||
          model.model_options[0];
        const displayedModel = selectedOption
          ? modelWithOption(model, selectedOption, providerActive ? model.thinking_state : undefined)
          : model;
        const selectedIsCurrent = providerActive && current?.model === displayedModel.model;
        const thinkingLevels = displayedModel.thinking_levels || [];
        const showThinkingControl =
          selectedIsCurrent && Boolean(displayedModel.thinking_state?.editable) && thinkingLevels.length > 0;
        const showThinkingReadout = !showThinkingControl && thinkingLevels.length > 0;
        const showThinkingUnsupported = !displayedModel.capabilities.supports_thinking;
        const showThinkingPanel = showThinkingControl || showThinkingReadout || showThinkingUnsupported;
        const switchDisabled = modelSaving || !model.selectable || !selectedOption || selectedIsCurrent;
        return (
          <article className={`item-card ${providerActive ? "item-active" : ""}`} key={model.provider}>
            <div className="item-heading">
              <div className="item-icon">
                <Brain size={18} />
              </div>
              <div className="model-heading-copy">
                <h3>{model.label}</h3>
                <div className="model-heading-model">{displayedModel.model}</div>
              </div>
            </div>
            <div className="model-select-panel">
              <label className="model-select-label" htmlFor={`model-select-${model.provider}`}>
                {t.models.model}
              </label>
              <div className="model-select-row">
                <select
                  aria-label={`${model.label} model`}
                  className="model-select"
                  disabled={!model.selectable || model.model_options.length <= 1 || modelSaving}
                  id={`model-select-${model.provider}`}
                  onChange={(event) =>
                    setSelectedModels((currentSelections) => ({
                      ...currentSelections,
                      [model.provider]: event.target.value
                    }))
                  }
                  value={displayedModel.model}
                >
                  {model.model_options.map((option) => (
                    <option key={option.model} value={option.model}>
                      {option.model}
                    </option>
                  ))}
                </select>
                <button
                  className="model-switch-button"
                  disabled={switchDisabled}
                  onClick={() => onCurrentModelChange(model.provider, displayedModel.model)}
                  type="button"
                >
                  <Settings2 size={14} />
                  <span>{selectedIsCurrent ? t.models.current : modelSaving ? t.models.switching : t.models.setCurrent}</span>
                </button>
              </div>
              {!model.selectable && model.disabled_reason ? (
                <div className="model-disabled-reason">{modelDisabledReasonLabel(t, model.disabled_reason)}</div>
              ) : null}
            </div>
            <dl className="compact-metrics">
              <div>
                <dt>{t.models.context}</dt>
                <dd>{formatNumber(displayedModel.capabilities.context_window_tokens)}</dd>
              </div>
              <div>
                <dt>{t.models.output}</dt>
                <dd>
                  {formatNumber(
                    displayedModel.capabilities.max_tokens ?? displayedModel.capabilities.max_output_tokens ?? 0
                  )}
                </dd>
              </div>
              <div>
                <dt>{t.models.vision}</dt>
                <dd>{displayedModel.capabilities.supports_vision ? t.common.yes : t.common.no}</dd>
              </div>
            </dl>
            {showThinkingPanel ? (
              <div className="model-thinking-panel">
                <div className="model-thinking-title">
                  <span>{t.models.thinking}</span>
                </div>
                {showThinkingControl ? (
                  <div className="thinking-level-control" role="group" aria-label={`${model.label} thinking level`}>
                    {thinkingLevels.map((level) => {
                      const selected = displayedModel.thinking_state?.level === level;
                      return (
                        <button
                          aria-pressed={selected}
                          className={selected ? "thinking-level-button active" : "thinking-level-button"}
                          disabled={thinkingSaving}
                          key={level}
                          onClick={() => onThinkingLevelChange(level)}
                          type="button"
                        >
                          {modelThinkingLevelLabel(displayedModel, level)}
                        </button>
                      );
                    })}
                  </div>
                ) : showThinkingReadout ? (
                  <div className="thinking-level-readout">
                    {thinkingLevels.map((level) => modelThinkingLevelLabel(displayedModel, level)).join(" / ")}
                  </div>
                ) : (
                  <div className="thinking-level-readout">{t.common.notSupported}</div>
                )}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function ToolsView({
  toolsets,
  onOpen
}: {
  toolsets: ToolsetPayload[];
  onOpen: (target: DetailTarget) => void;
}) {
  const t = useUiText();
  const [expandedToolsets, setExpandedToolsets] = useState<Record<string, boolean>>({});

  return (
    <div className="toolset-stack">
      {toolsets.map((toolset) => {
        const expanded = expandedToolsets[toolset.name] ?? false;
        return (
          <section className="toolset-section" key={toolset.name}>
            <button
              className="section-title-button"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedToolsets((current) => ({ ...current, [toolset.name]: !expanded }))}
            >
              <ChevronRight className={expanded ? "section-chevron expanded" : "section-chevron"} size={16} />
              <div>
                <h2>{toolset.label}</h2>
                <p>{t.common.countItems(formatNumber(toolset.tools.length), t.tools.itemUnit)}</p>
              </div>
              <span className={toolset.enabled ? "status-dot on" : "status-dot"} />
            </button>
            {expanded ? (
              toolset.tools.length ? (
                <div className="grid-list">
                  {toolset.tools.map((tool) => (
                    <button
                      className="item-card item-button"
                      key={tool.name}
                      type="button"
                      onClick={() => onOpen({ type: "tool", item: tool, title: tool.name })}
                    >
                      <div className="item-heading">
                        <div className="item-icon">
                          <Wrench size={18} />
                        </div>
                        <div>
                          <h3>{tool.name}</h3>
                        </div>
                        <ChevronRight className="chevron" size={18} />
                      </div>
                      <p className="description">{tool.description}</p>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState label={t.tools.emptyToolset} />
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

const TASK_STATUS_ORDER = ["running", "completed", "failed", "timeout", "killed"];

function taskStatusRank(status: string): number {
  const index = TASK_STATUS_ORDER.indexOf(String(status || "").trim());
  return index >= 0 ? index : TASK_STATUS_ORDER.length;
}

function groupTasksByStatus(tasks: BackgroundTaskPayload[]): Array<{ status: string; tasks: BackgroundTaskPayload[] }> {
  const groups = new Map<string, BackgroundTaskPayload[]>();
  for (const task of tasks) {
    const status = String(task.status || "unknown").trim() || "unknown";
    groups.set(status, [...(groups.get(status) || []), task]);
  }
  return Array.from(groups.entries())
    .map(([status, items]) => ({
      status,
      tasks: items.slice().sort((left, right) => right.started_at - left.started_at)
    }))
    .sort((left, right) => {
      const leftRank = taskStatusRank(left.status);
      const rightRank = taskStatusRank(right.status);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.status.localeCompare(right.status);
    });
}

function statusPillClass(status: string): string {
  const normalized = String(status || "").trim();
  if (normalized === "running" || normalized === "completed") {
    return "pill ok";
  }
  if (normalized === "failed" || normalized === "timeout" || normalized === "killed") {
    return "pill warn";
  }
  return "pill";
}

function BackgroundTasksView({
  tasks,
  onOpen
}: {
  tasks: BackgroundTaskPayload[];
  onOpen: (target: DetailTarget) => void;
}) {
  const t = useUiText();
  if (!tasks.length) {
    return <EmptyState label={t.tasks.empty} />;
  }
  const groups = groupTasksByStatus(tasks);
  return (
    <div className="toolset-stack">
      {groups.map((group) => (
        <section className="toolset-section" key={group.status}>
          <div className="section-title-row">
            <div>
              <h2>{group.status}</h2>
              <p>{t.common.countItems(formatNumber(group.tasks.length), t.tasks.itemUnit)}</p>
            </div>
            <span className={group.status === "running" ? "status-dot on" : "status-dot"} />
          </div>
          <div className="table-shell">
            <table className="session-table task-table">
              <thead>
                <tr>
                  <th>{t.tasks.task}</th>
                  <th>{t.tasks.status}</th>
                  <th>{t.tasks.session}</th>
                  <th>{t.tasks.command}</th>
                  <th>{t.tasks.duration}</th>
                  <th>{t.tasks.startedAt}</th>
                </tr>
              </thead>
              <tbody>
                {group.tasks.map((task) => (
                  <tr
                    className="clickable-row"
                    key={task.task_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen({ type: "task", item: task, title: task.task_id })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen({ type: "task", item: task, title: task.task_id });
                      }
                    }}
                  >
                    <td>
                      <div className="primary-cell">{shortId(task.task_id)}</div>
                      <div className="muted mono">pid {task.pid ?? "-"}</div>
                    </td>
                    <td>
                      <span className={statusPillClass(task.status)}>{task.status || "unknown"}</span>
                    </td>
                    <td>
                      <div className="primary-cell" title={task.session_title || t.common.unnamedSession}>
                        {task.session_title || t.common.unnamedSession}
                      </div>
                      <div className="muted mono" title={task.session_id || ""}>
                        {task.session_id ? shortId(task.session_id) : "-"}
                      </div>
                    </td>
                    <td>
                      <div className="task-command">{task.command || "-"}</div>
                      <div className="muted mono">{task.cwd || "-"}</div>
                    </td>
                    <td>{formatDuration(task.duration_sec)}</td>
                    <td>
                      <div className="row-action-cell">
                        <span>{formatDate(task.started_at)}</span>
                        <ChevronRight size={16} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

const SKILL_TYPE_ORDER = ["default", "amazon_fba", "amazon_replenish"];

function skillTypeLabel(type: string, t: UiText): string {
  const normalized = String(type || "").trim();
  const labels: Record<string, string> = {
    default: t.skillTypes.default,
    amazon_fba: t.skillTypes.amazon_fba,
    amazon_replenish: t.skillTypes.amazon_replenish
  };
  return labels[normalized] || normalized || t.skillTypes.uncategorized;
}

function skillTypeRank(type: string): number {
  const index = SKILL_TYPE_ORDER.indexOf(String(type || "").trim());
  return index >= 0 ? index : SKILL_TYPE_ORDER.length;
}

function groupSkillsByType(skills: SkillPayload[], t: UiText): Array<{ type: string; label: string; skills: SkillPayload[] }> {
  const groups = new Map<string, SkillPayload[]>();
  for (const skill of skills) {
    const type = String(skill.type || "").trim() || "uncategorized";
    groups.set(type, [...(groups.get(type) || []), skill]);
  }
  return Array.from(groups.entries())
    .map(([type, items]) => ({
      type,
      label: skillTypeLabel(type, t),
      skills: items.slice().sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => {
      const leftRank = skillTypeRank(left.type);
      const rightRank = skillTypeRank(right.type);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.label.localeCompare(right.label);
    });
}

function SkillsView({
  skills,
  onOpen
}: {
  skills: SkillPayload[];
  onOpen: (target: DetailTarget) => void;
}) {
  const t = useUiText();
  const [expandedSkillGroups, setExpandedSkillGroups] = useState<Record<string, boolean>>({});

  if (!skills.length) {
    return <EmptyState label={t.skills.empty} />;
  }
  const groups = groupSkillsByType(skills, t);
  return (
    <div className="toolset-stack">
      {groups.map((group) => {
        const expanded = expandedSkillGroups[group.type] ?? false;
        return (
          <section className="toolset-section" key={group.type}>
            <button
              className="section-title-button"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedSkillGroups((current) => ({ ...current, [group.type]: !expanded }))}
            >
              <ChevronRight className={expanded ? "section-chevron expanded" : "section-chevron"} size={16} />
              <div>
                <h2>{group.label}</h2>
                <p>{t.common.countItems(formatNumber(group.skills.length), t.skills.itemUnit)}</p>
              </div>
              <span className="status-dot on" />
            </button>
            {expanded ? (
              <div className="grid-list">
                {group.skills.map((skill) => (
                  <button
                    className="item-card item-button"
                    key={skill.name}
                    type="button"
                    onClick={() => onOpen({ type: "skill", item: skill, title: skill.name })}
                  >
                    <div className="item-heading">
                      <div className="item-icon skill-icon">
                        <Sparkles size={18} />
                      </div>
                      <div>
                        <h3>{skill.name}</h3>
                      </div>
                      <ChevronRight className="chevron" size={18} />
                    </div>
                    <p className="description">{skill.description}</p>
                    {skill.references.length ? (
                      <div className="pill-row">
                        <span className="pill">{t.skills.refs(formatNumber(skill.references.length))}</span>
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function MermaidBlock({ chart }: { chart: string }) {
  const t = useUiText();
  const reactId = useId();
  const mermaidId = useMemo(
    () => `skill-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    [reactId]
  );
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const chartText = chart.trim();

  useEffect(() => {
    let cancelled = false;

    async function renderMermaid() {
      setSvg("");
      setError("");
      if (!chartText) {
        return;
      }
      try {
        const mermaid = await loadMermaid();
        const result = await mermaid.render(mermaidId, chartText);
        if (!cancelled) {
          setSvg(result.svg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    renderMermaid();
    return () => {
      cancelled = true;
    };
  }, [chartText, mermaidId]);

  if (error) {
    return (
      <div className="mermaid-block error">
        <div className="mermaid-block-status error">{t.mermaid.renderError(error)}</div>
        <pre className="mermaid-source-fallback">{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-block-status">{t.mermaid.rendering}</div>;
  }

  return (
    <div
      className="mermaid-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function SkillDetailContent({ skill }: { skill: SkillPayload }) {
  const t = useUiText();
  const [payload, setPayload] = useState<SkillContentPayload | null>(null);
  const [contentView, setContentView] = useState<SkillContentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [referenceLoading, setReferenceLoading] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [contentMode, setContentMode] = useState<SkillContentMode>("preview");
  const references = payload?.references || skill.references;
  const copyDisabled = !contentView?.content || loading || Boolean(referenceLoading);
  const previewContent = contentView?.title === "SKILL.md"
    ? markdownWithoutFrontMatter(contentView.content)
    : contentView?.content || "";

  useEffect(() => {
    let cancelled = false;

    async function loadSkillContent() {
      setPayload(null);
      setContentView(null);
      setLoading(true);
      setReferenceLoading("");
      setError("");
      setCopied(false);
      setContentMode("preview");
      try {
        const nextPayload = await fetchJson<SkillContentPayload>(
          `/api/skills/${encodeURIComponent(skill.name)}/content`
        );
        if (cancelled) {
          return;
        }
        setPayload(nextPayload);
        setContentView({
          title: "SKILL.md",
          subtitle: nextPayload.description || skill.description,
          content: nextPayload.content || ""
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSkillContent();
    return () => {
      cancelled = true;
    };
  }, [skill.name, skill.description]);

  async function openReference(reference: SkillReferencePayload) {
    if (referenceLoading === reference.path) {
      return;
    }
    setReferenceLoading(reference.path);
    setError("");
    setCopied(false);
    try {
      const nextPayload = await fetchJson<SkillReferenceContentPayload>(
        `/api/skills/${encodeURIComponent(skill.name)}/references/${encodePathSegments(reference.path)}`
      );
      setContentView({
        title: nextPayload.path,
        subtitle: nextPayload.description || reference.description,
        content: nextPayload.content || ""
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReferenceLoading("");
    }
  }

  function showSkillBody() {
    if (!payload) {
      return;
    }
    setContentView({
      title: "SKILL.md",
      subtitle: payload.description || skill.description,
      content: payload.content || ""
    });
    setError("");
    setCopied(false);
  }

  async function copyCurrentContent() {
    if (!contentView?.content) {
      return;
    }
    try {
      await copyTextToClipboard(contentView.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="modal-content">
      <p>{skill.description}</p>
      <div className="schema-block">
        <div className="schema-title">{t.skillModal.references}</div>
        {references.length ? (
          <div className="reference-list">
            {payload ? (
              <button
                className={contentView?.title === "SKILL.md" ? "reference-button active" : "reference-button"}
                disabled={Boolean(referenceLoading)}
                onClick={showSkillBody}
                type="button"
              >
                <span className="mono">SKILL.md</span>
                <small>{payload.description || skill.description}</small>
              </button>
            ) : null}
            {references.map((reference) => {
              const active = contentView?.title === reference.path;
              const loadingReference = referenceLoading === reference.path;
              return (
                <button
                  className={active ? "reference-button active" : "reference-button"}
                  disabled={Boolean(referenceLoading)}
                  key={reference.path}
                  onClick={() => openReference(reference)}
                  type="button"
                >
                  <span className="mono">{reference.path}</span>
                  <small>{loadingReference ? t.skillModal.loadingReference : reference.description}</small>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="muted reference-empty">{t.skillModal.noReferences}</p>
        )}
      </div>
      <div className="schema-block skill-content-block">
        <div className="schema-title skill-content-title">
          <div>
            <span>{contentView?.title || "SKILL.md"}</span>
          </div>
          <button
            className="skill-copy-button"
            disabled={copyDisabled}
            onClick={copyCurrentContent}
            type="button"
          >
            {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
            <span>{copied ? t.common.copied : t.skillModal.copySource}</span>
          </button>
        </div>
        {error ? <div className="skill-content-status error">{error}</div> : null}
        {loading ? <div className="skill-content-status">{t.skillModal.loadingContent}</div> : null}
        {!loading && contentView ? (
          <>
            <div className="skill-content-mode-row" role="group" aria-label={t.skillModal.modeAria}>
              <button
                className={contentMode === "preview" ? "skill-mode-button active" : "skill-mode-button"}
                onClick={() => setContentMode("preview")}
                type="button"
              >
                {t.skillModal.preview}
              </button>
              <button
                className={contentMode === "source" ? "skill-mode-button active" : "skill-mode-button"}
                onClick={() => setContentMode("source")}
                type="button"
              >
                {t.skillModal.source}
              </button>
            </div>
            {contentMode === "preview" ? (
              <div className="skill-markdown">
                <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                  {previewContent}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="skill-content-pre">{contentView.content}</pre>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function DetailModal({ target, onClose }: { target: DetailTarget; onClose: () => void }) {
  const t = useUiText();
  if (!target) {
    return null;
  }
  const modalType = target.type === "tool" ? t.detailModal.tool : target.type === "skill" ? t.detailModal.skill : t.detailModal.task;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={target.title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-kicker">{modalType}</div>
            <h2>{target.title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t.detailModal.close}>
            <X size={18} />
          </button>
        </div>
        {target.type === "tool" ? (
          <div className="modal-content">
            <p>{target.item.description}</p>
            <div className="schema-block">
              <div className="schema-title">{t.detailModal.inputSchema}</div>
              <pre>{JSON.stringify(target.item.parameters, null, 2)}</pre>
            </div>
          </div>
        ) : target.type === "skill" ? (
          <SkillDetailContent skill={target.item} />
        ) : (
          <div className="modal-content">
            <dl className="detail-list">
              <div>
                <dt>{t.detailModal.status}</dt>
                <dd>
                  <span className={statusPillClass(target.item.status)}>{target.item.status || t.common.unknown}</span>
                </dd>
              </div>
              <div>
                <dt>{t.detailModal.sessionTitle}</dt>
                <dd>{target.item.session_title || t.common.unnamedSession}</dd>
              </div>
              <div>
                <dt>{t.detailModal.session}</dt>
                <dd className="mono">{target.item.session_id || "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.turn}</dt>
                <dd className="mono">{target.item.origin_turn_id || "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.card}</dt>
                <dd className="mono">{target.item.card_id || "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.pid}</dt>
                <dd>{target.item.pid ?? "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.started}</dt>
                <dd>{formatDate(target.item.started_at)}</dd>
              </div>
              <div>
                <dt>{t.detailModal.ended}</dt>
                <dd>{target.item.ended_at ? formatDate(target.item.ended_at) : "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.duration}</dt>
                <dd>{formatDuration(target.item.duration_sec)}</dd>
              </div>
              <div>
                <dt>{t.detailModal.exitCode}</dt>
                <dd>{target.item.exit_code ?? "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.cwd}</dt>
                <dd className="mono">{target.item.cwd || "-"}</dd>
              </div>
            </dl>
            <div className="schema-block">
              <div className="schema-title">{t.detailModal.command}</div>
              <pre>{target.item.command || "-"}</pre>
            </div>
            <div className="schema-block">
              <div className="schema-title">{t.detailModal.outputTail}</div>
              <pre>{target.item.output_tail || `(${t.detailModal.noOutput})`}</pre>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function LanguageSwitch({
  language,
  onLanguageChange
}: {
  language: Language;
  onLanguageChange: (language: Language) => void;
}) {
  const t = useUiText();
  return (
    <div className="language-switch" role="group" aria-label={t.language.label}>
      {(["zh", "en"] as const).map((option) => (
        <button
          aria-pressed={language === option}
          className={language === option ? "language-option active" : "language-option"}
          key={option}
          onClick={() => onLanguageChange(option)}
          type="button"
        >
          {option === "zh" ? t.language.zh : t.language.en}
        </button>
      ))}
    </div>
  );
}

function DashboardStatusModal({
  open,
  onClose,
  summary,
  currentModel,
  apiOnline,
  language,
  onLanguageChange
}: {
  open: boolean;
  onClose: () => void;
  summary: SessionSummaryPayload;
  currentModel: ModelPayload | null;
  apiOnline: boolean;
  language: Language;
  onLanguageChange: (language: Language) => void;
}) {
  const t = useUiText();

  if (!open) {
    return null;
  }

  const statusLabel = apiOnline ? t.app.apiOnline : t.app.apiOffline;
  const currentModelLabel = currentModel?.model || "-";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        aria-label={t.app.title}
        aria-modal="true"
        className="modal dashboard-status-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="modal-header">
          <div>
            <div className="modal-kicker">{t.app.eyebrow}</div>
            <h2>{t.app.title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t.detailModal.close}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-content dashboard-status-content">
          <div className="dashboard-status-grid">
            <div className="dashboard-status-item">
              <span>{t.stats.sessions}</span>
              <strong>{formatNumber(summary.total_sessions)}</strong>
            </div>
            <div className="dashboard-status-item">
              <span>{t.stats.toolCalls}</span>
              <strong>{formatNumber(summary.tool_call_count)}</strong>
            </div>
            <div className="dashboard-status-item">
              <span>{t.stats.tokens}</span>
              <strong>{formatNumber(summary.token_count)}</strong>
            </div>
            <div className="dashboard-status-item">
              <span>{t.detailModal.status}</span>
              <strong>{statusLabel}</strong>
            </div>
          </div>
          <div className="dashboard-status-row">
            <span>{t.models.current}</span>
            <strong>{currentModelLabel}</strong>
          </div>
          <div className="dashboard-status-row">
            <span>{t.language.label}</span>
            <LanguageSwitch language={language} onLanguageChange={onLanguageChange} />
          </div>
        </div>
      </section>
    </div>
  );
}

function App() {
  const [initialRoute] = useState(() => routeStateFromLocation(false));
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const t = UI_TEXT[language];
  const [activeTab, setActiveTab] = useState(initialRoute.tab);
  const [lastDashboardTab, setLastDashboardTab] = useState(
    initialRoute.tab === "docs" ? "home" : initialRoute.tab
  );
  const [data, setData] = useState<DashboardData | null>(null);
  const [sessionsData, setSessionsData] = useState<SessionListPayload>(EMPTY_SESSION_LIST);
  const [docsData, setDocsData] = useState<ApiList<ProjectDocPayload>>(EMPTY_PROJECT_DOCS);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState("");
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [docsError, setDocsError] = useState("");
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [docQuery, setDocQuery] = useState("");
  const [sessionRequest, setSessionRequest] = useState({ query: "", offset: 0 });
  const [selectedSession, setSelectedSession] = useState<SessionPayload | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [selectedDocPath, setSelectedDocPath] = useState(initialRoute.docPath);
  const [docContent, setDocContent] = useState<ProjectDocContentPayload | null>(null);
  const [docContentLoading, setDocContentLoading] = useState(false);
  const [docContentError, setDocContentError] = useState("");
  const [docContentMode, setDocContentMode] = useState<DocsContentMode>("preview");
  const [docCopied, setDocCopied] = useState(false);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [sessionDetailPageLoading, setSessionDetailPageLoading] = useState(false);
  const [sessionDetailError, setSessionDetailError] = useState("");
  const [sessionDetailPageError, setSessionDetailPageError] = useState("");
  const [sessionLoadMoreError, setSessionLoadMoreError] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [thinkingSaving, setThinkingSaving] = useState(false);
  const [dashboardStatusOpen, setDashboardStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionSearchFocusKey, setSessionSearchFocusKey] = useState(0);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Ignore storage failures; the in-memory language still updates.
    }
  }, [language]);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = routeStateFromLocation();
      setActiveTab(nextRoute.tab);
      setSelectedDocPath(nextRoute.docPath);
      if (nextRoute.tab !== "docs") {
        setLastDashboardTab(nextRoute.tab);
      }
      if (nextRoute.tab === "home") {
        setSelectedSession(null);
        setSessionDetail(null);
        setSessionDetailError("");
        setSessionDetailPageError("");
        setSessionDetailLoading(false);
        setSessionDetailPageLoading(false);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [skills, toolsets, backgroundTasks, models, currentModel] = await Promise.all([
          fetchJson<ApiList<SkillPayload>>("/api/skills"),
          fetchJson<ApiList<ToolsetPayload>>("/api/tools/toolsets"),
          fetchJson<ApiList<BackgroundTaskPayload>>("/api/background-tasks"),
          fetchJson<ApiList<ModelPayload>>("/api/models"),
          fetchJson<ModelPayload>("/api/models/current")
        ]);
        if (!cancelled) {
          setData({ skills, toolsets, backgroundTasks, models, currentModel });
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const debounce = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(debounce);
  }, [query]);

  useEffect(() => {
    setSessionRequest((current) =>
      current.query === debouncedQuery && current.offset === 0 ? current : { query: debouncedQuery, offset: 0 }
    );
  }, [debouncedQuery]);

  useEffect(() => {
    let cancelled = false;

    async function loadSessions() {
      const replacing = sessionRequest.offset === 0;
      const params = new URLSearchParams({
        limit: String(SESSION_LIST_PAGE_SIZE),
        offset: String(sessionRequest.offset)
      });
      if (sessionRequest.query) {
        params.set("q", sessionRequest.query);
      }

      setSessionsLoading(true);
      if (replacing) {
        setSessionsError("");
        setSessionLoadMoreError("");
        setSessionsData((current) => ({
          ...current,
          items: [],
          total: 0,
          limit: SESSION_LIST_PAGE_SIZE,
          offset: 0
        }));
      } else {
        setSessionLoadMoreError("");
      }
      try {
        const payload = normalizeSessionList(
          await fetchJson<SessionListPayload>(`/api/sessions?${params.toString()}`)
        );
        if (cancelled) {
          return;
        }
        setSessionsData((current) => (replacing ? payload : mergeSessionLists(current, payload)));
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          if (replacing) {
            setSessionsError(message);
          } else {
            setSessionLoadMoreError(message);
          }
        }
      } finally {
        if (!cancelled) {
          setSessionsLoading(false);
        }
      }
    }

    loadSessions();
    return () => {
      cancelled = true;
    };
  }, [sessionRequest]);

  useEffect(() => {
    if (activeTab !== "docs" || docsLoaded || docsError) {
      return;
    }
    let cancelled = false;

    async function loadDocs() {
      setDocsLoading(true);
      setDocsError("");
      try {
        const payload = normalizeProjectDocs(await fetchJson<ApiList<ProjectDocPayload>>("/api/project-docs"));
        if (!cancelled) {
          setDocsData(payload);
          setDocsLoaded(true);
        }
      } catch (err) {
        if (!cancelled) {
          setDocsError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setDocsLoading(false);
        }
      }
    }

    void loadDocs();
    return () => {
      cancelled = true;
    };
  }, [activeTab, docsLoaded, docsError]);

  const defaultDocPath = useMemo(() => {
    if (!docsData.items.length) {
      return "";
    }
    return docsData.items.find((doc) => doc.path === DOCS_HOME_PATH)?.path || docsData.items[0].path;
  }, [docsData.items]);

  const effectiveDocPath = activeTab === "docs" ? selectedDocPath || defaultDocPath : "";

  useEffect(() => {
    if (activeTab !== "docs" || !effectiveDocPath) {
      return;
    }
    let cancelled = false;

    async function loadDocContent() {
      setDocContentLoading(true);
      setDocContentError("");
      setDocCopied(false);
      try {
        const payload = await fetchJson<ProjectDocContentPayload>(
          `/api/project-docs/${encodePathSegments(effectiveDocPath)}`
        );
        if (!cancelled) {
          setDocContent(payload);
        }
      } catch (err) {
        if (!cancelled) {
          setDocContent(null);
          setDocContentError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setDocContentLoading(false);
        }
      }
    }

    void loadDocContent();
    return () => {
      cancelled = true;
    };
  }, [activeTab, effectiveDocPath]);

  function handleSessionQueryChange(value: string) {
    setQuery(value);
  }

  function loadMoreSessions() {
    if (sessionsLoading || sessionsData.items.length >= sessionsData.total) {
      return;
    }
    setSessionRequest((current) => {
      const nextOffset = sessionsData.items.length;
      if (current.query === debouncedQuery && current.offset === nextOffset) {
        return current;
      }
      return { query: debouncedQuery, offset: nextOffset };
    });
  }

  function handleSessionSearchToggle() {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
    pushDashboardRoute("sessions");
    setActiveTab("sessions");
    setLastDashboardTab("sessions");
    setSelectedSession(null);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailPageError("");
    setSessionDetailLoading(false);
    setSessionDetailPageLoading(false);
    setSessionSearchFocusKey((current) => current + 1);
  }

  function handleSidebarToggle() {
    setSidebarCollapsed((current) => !current);
  }

  function pushDashboardRoute(tab: string) {
    const nextTab = DASHBOARD_TAB_IDS.has(tab) && tab !== "docs" ? tab : "home";
    if (window.location.pathname !== "/" || window.history.state?.tab !== nextTab) {
      window.history.pushState({ tab: nextTab }, "", "/");
    }
  }

  function openDashboardTab(tab: string) {
    if (tab === "docs") {
      openDocRoute("");
      return;
    }
    pushDashboardRoute(tab);
    setActiveTab(tab);
    setLastDashboardTab(tab);
    if (tab === "sessions") {
      setSelectedSession(null);
      setSessionDetail(null);
      setSessionDetailError("");
      setSessionDetailPageError("");
      setSessionDetailLoading(false);
      setSessionDetailPageLoading(false);
    }
  }

  function openDashboardHome() {
    pushDashboardRoute("home");
    setActiveTab("home");
    setLastDashboardTab("home");
    setSelectedSession(null);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailPageError("");
    setSessionDetailLoading(false);
    setSessionDetailPageLoading(false);
  }

  function openDocRoute(path: string) {
    const safePath = normalizeDocPath(path);
    const nextUrl = docsHrefForPath(safePath);
    if (window.location.pathname !== nextUrl) {
      window.history.pushState({ tab: "docs", docPath: safePath }, "", nextUrl);
    }
    setActiveTab("docs");
    setSelectedDocPath(safePath);
    setDocContentMode("preview");
  }

  function backToDashboard() {
    const nextTab = DASHBOARD_TAB_IDS.has(lastDashboardTab) ? lastDashboardTab : "home";
    pushDashboardRoute(nextTab);
    setActiveTab(nextTab);
    setLastDashboardTab(nextTab);
    setSelectedDocPath("");
  }

  async function copyCurrentDoc() {
    if (!docContent?.content) {
      return;
    }
    try {
      await copyTextToClipboard(docContent.content);
      setDocCopied(true);
      window.setTimeout(() => setDocCopied(false), 1600);
    } catch {
      setDocCopied(false);
    }
  }

  async function openSession(session: SessionPayload) {
    pushDashboardRoute("sessions");
    setActiveTab("sessions");
    setLastDashboardTab("sessions");
    setSelectedSession(session);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailPageError("");
    setSessionDetailLoading(true);
    setSessionDetailPageLoading(false);
    try {
      const detail = await fetchJson<SessionDetailPayload>(
        `/api/sessions/${encodeURIComponent(session.session_id)}?message_limit=${SESSION_MESSAGE_PAGE_LIMIT}`
      );
      setSessionDetail(detail);
    } catch (err) {
      setSessionDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionDetailLoading(false);
    }
  }

  async function loadSessionMessagesPage(page: number) {
    if (!selectedSession || !sessionDetail || sessionDetailPageLoading) {
      return;
    }
    setSessionDetailPageLoading(true);
    setSessionDetailPageError("");
    try {
      const nextDetail = await fetchJson<SessionDetailPayload>(
        `/api/sessions/${encodeURIComponent(selectedSession.session_id)}?message_limit=${SESSION_MESSAGE_PAGE_LIMIT}&message_page=${page}`
      );
      setSessionDetail((current) => {
        if (!current || current.session.session_id !== selectedSession.session_id) {
          return nextDetail;
        }
        return nextDetail;
      });
    } catch (err) {
      setSessionDetailPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionDetailPageLoading(false);
    }
  }

  async function setCurrentThinkingLevel(level: string) {
    if (!data?.currentModel || thinkingSaving || !data.currentModel.thinking_state?.editable) {
      return;
    }
    const previousData = data;
    setThinkingSaving(true);
    setError("");
    setData(dataWithCurrentModel(data, modelWithThinkingLevel(data.currentModel, level)));
    try {
      const currentModel = await patchJson<ModelPayload>("/api/models/current/thinking", { level });
      setData((current) => (current ? dataWithCurrentModel(current, currentModel) : current));
    } catch (err) {
      setData(previousData);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinkingSaving(false);
    }
  }

  async function setCurrentModel(provider: string, modelName: string) {
    if (!data || modelSaving) {
      return;
    }
    const providerModel = data.models.items.find((item) => item.provider === provider);
    const selectedOption = providerModel?.model_options.find((option) => option.model === modelName);
    if (!providerModel || !selectedOption) {
      setError(t.models.modelOptionUnavailable);
      return;
    }
    if (!providerModel.selectable) {
      setError(
        providerModel.disabled_reason ? modelDisabledReasonLabel(t, providerModel.disabled_reason) : t.models.providerNotSelectable
      );
      return;
    }

    const previousData = data;
    const optimisticModel = modelWithOption(providerModel, selectedOption, data.currentModel?.thinking_state);
    setModelSaving(true);
    setError("");
    setData(dataWithCurrentModel(data, optimisticModel));
    try {
      const currentModel = await patchJson<ModelPayload>("/api/models/current", { provider, model: modelName });
      setData((current) => (current ? dataWithCurrentModel(current, currentModel) : current));
    } catch (err) {
      setData(previousData);
      const message = err instanceof Error ? err.message : String(err);
      setError(modelDisabledReasonLabel(t, message));
    } finally {
      setModelSaving(false);
    }
  }

  const sessionSummary = sessionsData.summary || EMPTY_SESSION_SUMMARY;
  const hasMoreSessions = sessionsData.items.length < sessionsData.total;
  const dashboardApiOnline = Boolean(data) && !loading;
  const showSessionSearch = activeTab === "sessions" || Boolean(query.trim());
  const showDashboardHome = activeTab === "home";

  const tabs = [
    { id: "sessions", label: t.nav.sessions, icon: <MessageSquareText size={16} /> },
    { id: "models", label: t.nav.models, icon: <Brain size={16} /> },
    { id: "tools", label: t.nav.tools, icon: <Wrench size={16} /> },
    { id: "skills", label: t.nav.skills, icon: <Sparkles size={16} /> },
    { id: "background-tasks", label: t.nav.tasks, icon: <Layers3 size={16} /> },
    { id: "docs", label: t.nav.docs, icon: <FileText size={16} /> }
  ];
  const activeTabItem = tabs.find((tab) => tab.id === activeTab);
  const pageTitle = activeTab === "home"
    ? t.home.title
    : activeTab === "sessions"
      ? selectedSession?.title || t.sessions.title
    : activeTab === "docs"
      ? docContent?.title || t.docs.title
      : activeTabItem?.label || t.app.title;
  const pageSubtitle = activeTab === "home"
    ? ""
    : activeTab === "sessions"
      ? selectedSession
        ? `${formatDate(selectedSession.last_active_at)} · ${formatNumber(selectedSession.input_tokens + selectedSession.output_tokens)} ${t.sessions.tokenSuffix}`
        : ""
    : activeTab === "docs"
      ? docContent?.path || effectiveDocPath || t.docs.selectPrompt
      : "";

  if (activeTab === "docs") {
    return (
      <I18nContext.Provider value={t}>
        <DocsShell
          docs={docsData.items}
          docsLoading={docsLoading}
          docsError={docsError}
          docQuery={docQuery}
          selectedPath={effectiveDocPath}
          doc={docContent}
          docLoading={Boolean(effectiveDocPath) && docContentLoading}
          docError={docContentError}
          mode={docContentMode}
          copied={docCopied}
          language={language}
          onLanguageChange={setLanguage}
          onDocQueryChange={setDocQuery}
          onOpenDoc={openDocRoute}
          onBackToDashboard={backToDashboard}
          onModeChange={setDocContentMode}
          onCopy={copyCurrentDoc}
        />
      </I18nContext.Provider>
    );
  }

  return (
    <I18nContext.Provider value={t}>
      <main className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
        <aside className={sidebarCollapsed ? "app-sidebar collapsed" : "app-sidebar"}>
          <div className="sidebar-topbar">
            {!sidebarCollapsed ? (
              <button
                aria-label={t.home.title}
                className="sidebar-brand"
                onClick={openDashboardHome}
                title={t.home.title}
                type="button"
              >
                <span className="sidebar-brand-text">{t.sidebar.brand}</span>
              </button>
            ) : null}
            <div className="sidebar-topbar-actions">
              {!sidebarCollapsed && activeTab !== "docs" ? (
                <button
                  aria-label={t.sessions.searchAria}
                  className={showSessionSearch ? "sidebar-icon-button active" : "sidebar-icon-button"}
                  onClick={handleSessionSearchToggle}
                  title={t.sessions.searchAria}
                  type="button"
                >
                  <Search size={17} />
                </button>
              ) : null}
              <button
                aria-label={sidebarCollapsed ? t.sidebar.expand : t.sidebar.collapse}
                className="sidebar-icon-button"
                onClick={handleSidebarToggle}
                title={sidebarCollapsed ? t.sidebar.expand : t.sidebar.collapse}
                type="button"
              >
                {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              </button>
            </div>
          </div>
          <nav className="tab-list" aria-label={t.nav.aria}>
            {tabs.map((tab) => (
              <button
                className={activeTab === tab.id ? "tab active" : "tab"}
                key={tab.id}
                title={tab.label}
                type="button"
                onClick={() => openDashboardTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <button
            aria-label={t.app.title}
            className="sidebar-status-card"
            title={t.app.title}
            type="button"
            onClick={() => setDashboardStatusOpen(true)}
          >
            <span className="sidebar-status-icon">
              <Bot size={16} />
            </span>
            <span className="sidebar-status-copy">
              <span className="sidebar-status-title">{t.app.title}</span>
              <span className="sidebar-status-meta">
                {data?.currentModel?.model || (loading ? t.common.loading : t.app.apiOffline)}
              </span>
            </span>
          </button>
        </aside>

        <section className={showDashboardHome ? "main-panel dashboard-home-panel" : "main-panel"}>
          {!showDashboardHome ? (
            <header className="main-header">
              <div className="main-title">
                <h2>{pageTitle}</h2>
                {pageSubtitle ? <p>{pageSubtitle}</p> : null}
              </div>
            </header>
          ) : null}
          <section className="content-panel">
            {loading ? <EmptyState label={t.errors.dashboardLoad} /> : null}
            {error ? <EmptyState label={t.common.errorPrefix(t.errors.api, error)} /> : null}
            {!loading && !error && data ? (
              <>
                {activeTab === "sessions" && selectedSession ? (
                  <SessionDetailView
                    fallbackSession={selectedSession}
                    detail={sessionDetail}
                    loading={sessionDetailLoading}
                    error={sessionDetailError}
                    pageLoading={sessionDetailPageLoading}
                    pageError={sessionDetailPageError}
                    onPageChange={loadSessionMessagesPage}
                  />
                ) : null}
                {activeTab === "sessions" && !selectedSession ? (
                  <section className="sessions-page">
                    <SessionsIndex
                      sessions={sessionsData.items}
                      query={query}
                      searchOpen={showSessionSearch}
                      searchFocusKey={sessionSearchFocusKey}
                      loading={sessionsLoading}
                      error={sessionsError}
                      hasMore={hasMoreSessions}
                      loadMoreError={sessionLoadMoreError}
                      selectedSessionId=""
                      onQueryChange={handleSessionQueryChange}
                      onLoadMore={loadMoreSessions}
                      onOpen={openSession}
                    />
                  </section>
                ) : null}
                {activeTab === "home" ? <DashboardHome /> : null}
                {activeTab === "models" ? (
                  <ModelsView
                    models={data.models.items}
                    current={data.currentModel}
                    modelSaving={modelSaving}
                    thinkingSaving={thinkingSaving}
                    onCurrentModelChange={setCurrentModel}
                    onThinkingLevelChange={setCurrentThinkingLevel}
                  />
                ) : null}
                {activeTab === "tools" ? <ToolsView toolsets={data.toolsets.items} onOpen={setDetailTarget} /> : null}
                {activeTab === "skills" ? <SkillsView skills={data.skills.items} onOpen={setDetailTarget} /> : null}
                {activeTab === "background-tasks" ? (
                  <BackgroundTasksView tasks={data.backgroundTasks.items} onOpen={setDetailTarget} />
                ) : null}
              </>
            ) : null}
          </section>
        </section>

        <DetailModal target={detailTarget} onClose={() => setDetailTarget(null)} />
        <DashboardStatusModal
          apiOnline={dashboardApiOnline}
          currentModel={data?.currentModel || null}
          language={language}
          onClose={() => setDashboardStatusOpen(false)}
          onLanguageChange={setLanguage}
          open={dashboardStatusOpen}
          summary={sessionSummary}
        />
      </main>
    </I18nContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

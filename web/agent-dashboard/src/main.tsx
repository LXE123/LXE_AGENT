import React, { useEffect, useId, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  FileText,
  Info,
  Layers3,
  MessageSquareText,
  PackageCheck,
  Search,
  Server,
  Settings2,
  Sparkles,
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
  label: string;
  editable: boolean;
};

type ModelPayload = {
  provider: string;
  label: string;
  api_style: string;
  model: string;
  configured: boolean;
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

type ConversationRenderItem =
  | { type: "message"; message: SessionMessage; index: number }
  | { type: "tool_group"; messages: SessionMessage[]; startIndex: number; key: string };

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
  location: string;
  content: string;
};

type SkillContentMode = "preview" | "source";

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

const SESSION_MESSAGE_PAGE_LIMIT = 25;
const SESSION_LIST_PAGE_SIZE = 10;

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

function modelWithThinkingLevel(model: ModelPayload, level: "off" | "low"): ModelPayload {
  const enabled = level === "low";
  const label = enabled ? model.thinking_level_labels.low || "on" : "off";
  return {
    ...model,
    thinking_state: {
      enabled,
      level,
      label,
      editable: Boolean(model.thinking_state?.editable)
    }
  };
}

function dataWithCurrentModel(current: DashboardData, model: ModelPayload): DashboardData {
  return {
    ...current,
    currentModel: model,
    models: {
      ...current.models,
      items: current.models.items.map((item) =>
        item.provider === model.provider && item.model === model.model ? { ...item, ...model } : item
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

function MessageBlock({ block }: { block: unknown }) {
  if (!isRecord(block)) {
    return (
      <pre className="message-json">{shortText(sanitizeForDisplay(block))}</pre>
    );
  }
  const type = String(block.type || "unknown");
  if (type === "text") {
    return <div className="message-text">{String(block.text || "")}</div>;
  }
  if (type === "thinking") {
    return <ThinkingBlock block={block} />;
  }
  if (type === "redacted_thinking") {
    return <RedactedThinkingBlock />;
  }
  if (type === "tool_use" || type === "tool_call") {
    const input = block.input ?? block.arguments ?? {};
    return (
      <div className="message-block tool-block">
        <div className="block-title">
          <Wrench size={14} />
          <span>{String(block.name || "tool")}</span>
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
          <span>{type} block</span>
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
          {canExpand ? (
            <ChevronRight className={expanded ? "thinking-chevron expanded" : "thinking-chevron"} size={14} />
          ) : null}
          <Brain size={14} />
          <span>思考</span>
        </div>
        {canExpand ? <span className="muted">{expanded ? "收起" : "展开"}</span> : null}
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
  return (
    <div className="message-block thinking-block redacted">
      <div className="block-title">
        <Brain size={14} />
        <span>思考</span>
      </div>
      <div className="thinking-block-body">
        <div className="muted">部分思考已加密，无法展示</div>
      </div>
    </div>
  );
}

function ToolResultBlock({ block }: { block: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewText = shortText(sanitizeForDisplay(block.content ?? ""));
  const fullText = displayText(sanitizeForDisplay(block.content ?? "", { truncateStrings: false }));
  const canExpand = fullText !== previewText;
  const renderedText = expanded ? fullText : previewText;
  const copyLabel = copied ? "已复制" : "复制结果";

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(fullText);
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
          <span>{block.is_error ? "tool result error" : "tool result"}</span>
          {block.tool_call_id ? <code>{String(block.tool_call_id)}</code> : null}
        </div>
        {canExpand ? (
          <div className="tool-result-actions">
            <button
              className="tool-result-button"
              type="button"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "收起" : "查看完整结果"}
            </button>
            <button className="tool-result-button" type="button" onClick={handleCopy}>
              {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              <span>{copyLabel}</span>
            </button>
          </div>
        ) : null}
      </div>
      <pre className={expanded ? "message-json tool-result-full" : "message-json"}>{renderedText}</pre>
    </div>
  );
}

function MessageContent({ content, message }: { content: unknown; message: SessionMessage }) {
  const toolCalls = message.tool_calls;
  return (
    <div className="message-content">
      {typeof content === "string" ? <div className="message-text">{content}</div> : null}
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
            <span>tool calls</span>
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

function buildConversationItems(messages: SessionMessage[]): ConversationRenderItem[] {
  const items: ConversationRenderItem[] = [];
  let pending: SessionMessage[] = [];
  let pendingStart = 0;

  const flushPending = () => {
    if (!pending.length) {
      return;
    }
    items.push({
      type: "tool_group",
      messages: pending,
      startIndex: pendingStart,
      key: `tools-${pendingStart}-${pending.length}`,
    });
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
    items.push({ type: "message", message, index });
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

function toolGroupStats(messages: SessionMessage[]) {
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
    summary: uniqueNames.length ? uniqueNames.join(", ") : "tool activity",
  };
}

function ToolTurnGroup({
  item,
  expanded,
  onToggle
}: {
  item: Extract<ConversationRenderItem, { type: "tool_group" }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const stats = toolGroupStats(item.messages);
  return (
    <section className={stats.hasError ? "tool-turn-group has-error" : "tool-turn-group"}>
      <button
        className="tool-turn-summary"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight className={expanded ? "tool-turn-chevron expanded" : "tool-turn-chevron"} size={16} />
        <div>
          <div className="tool-turn-title">
            工具操作 · {formatNumber(stats.callCount)} calls · {formatNumber(stats.resultCount)} results
          </div>
          <div className="tool-turn-subtitle">{stats.summary}</div>
        </div>
        {stats.hasError ? <span className="pill warn">error</span> : null}
      </button>
      {expanded ? (
        <div className="tool-turn-body">
          {item.messages.map((message, index) => {
            const role = roleLabel(message.role);
            return (
              <div className="tool-turn-message" key={`${item.key}-${index}`}>
                <div className="message-header">
                  <span className={`role-badge role-${role}`}>{role}</span>
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
  onPageChange,
  onBack
}: {
  fallbackSession: SessionPayload;
  detail: SessionDetailPayload | null;
  loading: boolean;
  error: string;
  pageLoading: boolean;
  pageError: string;
  onPageChange: (page: number) => void;
  onBack: () => void;
}) {
  const session = detail?.session || fallbackSession;
  const messages = detail?.messages || [];
  const page = detail?.messages_page;
  const visibleItemCount = page ? Math.max(0, page.end - page.start) : 0;
  const renderItems = useMemo(() => buildConversationItems(messages), [messages]);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(() => new Set());
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
      <div className="detail-toolbar">
        <button className="back-button" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Sessions</span>
        </button>
      </div>
      <section className="session-detail-header">
        <div>
          <div className="eyebrow">Session Detail</div>
          <h2>{session.title || "未命名会话"}</h2>
          <p className="muted mono">{session.session_id}</p>
        </div>
        <div className="detail-meta-grid">
          <span>{sourceLabel(session.source_summary || session.source)}</span>
          <span>{session.model || "-"}</span>
          <span>{formatDate(session.last_active_at)}</span>
        </div>
      </section>
      <div className="detail-stats">
        <StatTile icon={<MessageSquareText size={18} />} label="Messages" value={formatNumber(session.message_count)} />
        <StatTile icon={<Wrench size={18} />} label="Tool Calls" value={formatNumber(session.tool_call_count)} />
        <StatTile icon={<Box size={18} />} label="Tokens" value={formatNumber(session.input_tokens + session.output_tokens)} />
        <StatTile icon={<Activity size={18} />} label="API Calls" value={formatNumber(session.api_call_count)} />
      </div>
      {loading ? <EmptyState label="Loading conversation..." /> : null}
      {error ? <EmptyState label={`Session error: ${error}`} /> : null}
      {!loading && !error ? (
        messages.length ? (
          <>
            <div className="message-list">
              {renderItems.map((item) => {
                if (item.type === "tool_group") {
                  return (
                    <ToolTurnGroup
                      expanded={expandedToolGroups.has(item.key)}
                      item={item}
                      key={item.key}
                      onToggle={() => toggleToolGroup(item.key)}
                    />
                  );
                }
                const { message, index } = item;
                const role = roleLabel(message.role);
                return (
                  <article className={`message-card role-${role}`} key={`${role}-${index}`}>
                    <div className="message-header">
                      <span className={`role-badge role-${role}`}>{role}</span>
                      {message.tool_name ? <span className="muted">{message.tool_name}</span> : null}
                      {message.tool_call_id ? <code>{message.tool_call_id}</code> : null}
                    </div>
                    <MessageContent content={message.content} message={message} />
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
                上一页
              </button>
              <div className="message-page-center">
                <div className="message-page-count">
                  当前页 {formatNumber(visibleItemCount)} / 总 {formatNumber(page?.total || renderItems.length)} conversation items
                  {page ? <span> · {formatNumber(page.raw_message_total)} raw messages</span> : null}
                </div>
                <div className="message-page-index">
                  第 {formatNumber(page?.current_page || 1)} / {formatNumber(page?.total_pages || 1)} 页
                </div>
                {pageError ? <div className="message-page-error">{pageError}</div> : null}
              </div>
              <button
                className="page-nav-button"
                type="button"
                disabled={pageLoading || !page?.has_next}
                onClick={() => page && onPageChange(page.current_page + 1)}
              >
                下一页
              </button>
            </div>
          </>
        ) : (
          <EmptyState label="该 session 暂无对话记录。" />
        )
      ) : null}
    </div>
  );
}

function SessionsView({
  sessions,
  total,
  limit,
  offset,
  query,
  loading,
  error,
  onPageChange,
  onOpen
}: {
  sessions: SessionPayload[];
  total: number;
  limit: number;
  offset: number;
  query: string;
  loading: boolean;
  error: string;
  onPageChange: (page: number) => void;
  onOpen: (session: SessionPayload) => void;
}) {
  const safeLimit = Math.max(1, Number(limit) || SESSION_LIST_PAGE_SIZE);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  const currentPage = Math.floor(safeOffset / safeLimit) + 1;
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));
  const trimmedQuery = query.trim();
  const countLabel = trimmedQuery ? `搜索结果 ${formatNumber(safeTotal)} 条` : `共 ${formatNumber(safeTotal)} 条`;
  const emptyLabel = trimmedQuery ? "没有匹配的 session。" : "暂无 session 记录。";
  const hasPrevious = currentPage > 1;
  const hasNext = currentPage < totalPages;
  const showTable = sessions.length > 0;

  return (
    <div className="sessions-panel">
      <div className="sessions-list-toolbar">
        <div>
          <div className="sessions-list-title">Sessions</div>
          <div className="sessions-list-meta">{countLabel}</div>
        </div>
        {loading ? <span className="pill">loading</span> : null}
      </div>
      {error ? <EmptyState label={`Sessions error: ${error}`} /> : null}
      {!showTable && loading && !error ? <EmptyState label="Loading sessions..." /> : null}
      {!showTable && !loading && !error ? <EmptyState label={emptyLabel} /> : null}
      {showTable ? (
        <div className="table-shell">
          <table className="session-table">
            <thead>
              <tr>
                <th>会话</th>
                <th>来源</th>
                <th>模型</th>
                <th>消息</th>
                <th>工具</th>
                <th>Token</th>
                <th>最后活跃</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr
                  className="clickable-row"
                  key={session.session_id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(session)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen(session);
                    }
                  }}
                >
                  <td>
                    <div className="primary-cell">{session.title || "未命名会话"}</div>
                    <div className="muted mono">{shortId(session.session_id)}</div>
                  </td>
                  <td className="source-cell">{sourceLabel(session.source_summary || session.source)}</td>
                  <td>
                    <div>{session.model || "-"}</div>
                    <div className="muted">{String(session.model_config.provider || "")}</div>
                  </td>
                  <td>{formatNumber(session.message_count)}</td>
                  <td>{formatNumber(session.tool_call_count)}</td>
                  <td>{formatNumber(session.input_tokens + session.output_tokens)}</td>
                  <td>
                    <div className="row-action-cell">
                      <span>{formatDate(session.last_active_at)}</span>
                      <ChevronRight size={16} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {showTable || safeTotal > 0 ? (
        <div className="session-page-toolbar">
          <button
            className="page-nav-button"
            type="button"
            disabled={loading || !hasPrevious}
            onClick={() => onPageChange(currentPage - 1)}
          >
            上一页
          </button>
          <div className="session-page-center">
            <div className="message-page-index">
              第 {formatNumber(currentPage)} / {formatNumber(totalPages)} 页
            </div>
            <div className="message-page-count">{countLabel}</div>
          </div>
          <button
            className="page-nav-button"
            type="button"
            disabled={loading || !hasNext}
            onClick={() => onPageChange(currentPage + 1)}
          >
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ModelsView({ models, current }: { models: ModelPayload[]; current: ModelPayload | null }) {
  return (
    <div className="grid-list models-grid">
      {models.map((model) => {
        const active = current?.provider === model.provider && current?.model === model.model;
        return (
          <article className={`item-card ${active ? "item-active" : ""}`} key={`${model.provider}:${model.model}`}>
            <div className="item-heading">
              <div className="item-icon">
                <Brain size={18} />
              </div>
              <div>
                <h3>{model.label}</h3>
                <p>{model.provider}</p>
              </div>
            </div>
            <div className="model-name">{model.model}</div>
            <div className="pill-row">
              <span className={model.configured ? "pill ok" : "pill warn"}>
                {model.configured ? "configured" : "missing key"}
              </span>
              <span className="pill">{model.api_style}</span>
              {active ? <span className="pill active">current</span> : null}
            </div>
            <dl className="compact-metrics">
              <div>
                <dt>Context</dt>
                <dd>{formatNumber(model.capabilities.context_window_tokens)}</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>{formatNumber(model.capabilities.max_tokens ?? model.capabilities.max_output_tokens ?? 0)}</dd>
              </div>
              <div>
                <dt>Vision</dt>
                <dd>{model.capabilities.supports_vision ? "yes" : "no"}</dd>
              </div>
            </dl>
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
  return (
    <div className="toolset-stack">
      {toolsets.map((toolset) => (
        <section className="toolset-section" key={toolset.name}>
          <div className="section-title-row">
            <div>
              <h2>{toolset.label}</h2>
              <p>{toolset.tools.length} tools</p>
            </div>
            <span className={toolset.enabled ? "status-dot on" : "status-dot"} />
          </div>
          {toolset.tools.length ? (
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
                      <p>{tool.requires_resource || "runtime"}</p>
                    </div>
                    <ChevronRight className="chevron" size={18} />
                  </div>
                  <p className="description">{tool.description}</p>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState label="该 toolset 暂无可展示工具。" />
          )}
        </section>
      ))}
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
  if (!tasks.length) {
    return <EmptyState label="暂无后台任务。" />;
  }
  const groups = groupTasksByStatus(tasks);
  return (
    <div className="toolset-stack">
      {groups.map((group) => (
        <section className="toolset-section" key={group.status}>
          <div className="section-title-row">
            <div>
              <h2>{group.status}</h2>
              <p>{group.tasks.length} tasks</p>
            </div>
            <span className={group.status === "running" ? "status-dot on" : "status-dot"} />
          </div>
          <div className="table-shell">
            <table className="session-table task-table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>Session</th>
                  <th>命令</th>
                  <th>耗时</th>
                  <th>开始时间</th>
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
                      <div className="primary-cell" title={task.session_title || "未命名会话"}>
                        {task.session_title || "未命名会话"}
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

function skillTypeLabel(type: string): string {
  const normalized = String(type || "").trim();
  const labels: Record<string, string> = {
    default: "Default",
    amazon_fba: "Amazon FBA",
    amazon_replenish: "Amazon Replenish"
  };
  return labels[normalized] || normalized || "Uncategorized";
}

function skillTypeRank(type: string): number {
  const index = SKILL_TYPE_ORDER.indexOf(String(type || "").trim());
  return index >= 0 ? index : SKILL_TYPE_ORDER.length;
}

function groupSkillsByType(skills: SkillPayload[]): Array<{ type: string; label: string; skills: SkillPayload[] }> {
  const groups = new Map<string, SkillPayload[]>();
  for (const skill of skills) {
    const type = String(skill.type || "").trim() || "uncategorized";
    groups.set(type, [...(groups.get(type) || []), skill]);
  }
  return Array.from(groups.entries())
    .map(([type, items]) => ({
      type,
      label: skillTypeLabel(type),
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
  if (!skills.length) {
    return <EmptyState label="当前 agent 暂无可用 skill。" />;
  }
  const groups = groupSkillsByType(skills);
  return (
    <div className="toolset-stack">
      {groups.map((group) => {
        return (
          <section className="toolset-section" key={group.type}>
            <div className="section-title-row">
              <div>
                <h2>{group.label}</h2>
                <p>{group.skills.length} skills</p>
              </div>
              <span className="status-dot on" />
            </div>
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
                      <p>{skill.type}</p>
                    </div>
                    <ChevronRight className="chevron" size={18} />
                  </div>
                  <p className="description">{skill.description}</p>
                  <div className="pill-row">
                    <span className="pill">{skill.references.length} refs</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function MermaidBlock({ chart }: { chart: string }) {
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
        <div className="mermaid-block-status error">Mermaid render error: {error}</div>
        <pre className="mermaid-source-fallback">{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-block-status">Rendering Mermaid diagram...</div>;
  }

  return (
    <div
      className="mermaid-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function SkillDetailContent({ skill }: { skill: SkillPayload }) {
  const [payload, setPayload] = useState<SkillContentPayload | null>(null);
  const [contentView, setContentView] = useState<SkillContentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [referenceLoading, setReferenceLoading] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [contentMode, setContentMode] = useState<SkillContentMode>("preview");
  const references = payload?.references || skill.references;
  const copyDisabled = !contentView?.content || loading || Boolean(referenceLoading);

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
          location: nextPayload.location || skill.location,
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
  }, [skill.name, skill.description, skill.location]);

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
        location: nextPayload.location,
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
      location: payload.location || skill.location,
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
      <dl className="detail-list">
        <div>
          <dt>Type</dt>
          <dd>{skill.type}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd className="mono">{payload?.location || skill.location}</dd>
        </div>
      </dl>
      <div className="schema-block">
        <div className="schema-title">References</div>
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
                  <small>{loadingReference ? "loading..." : reference.description}</small>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="muted reference-empty">No references.</p>
        )}
      </div>
      <div className="schema-block skill-content-block">
        <div className="schema-title skill-content-title">
          <div>
            <span>{contentView?.title || "SKILL.md"}</span>
            {contentView?.location ? <small className="mono">{contentView.location}</small> : null}
          </div>
          <button
            className="skill-copy-button"
            disabled={copyDisabled}
            onClick={copyCurrentContent}
            type="button"
          >
            {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
            <span>{copied ? "已复制" : "复制原文"}</span>
          </button>
        </div>
        {error ? <div className="skill-content-status error">{error}</div> : null}
        {loading ? <div className="skill-content-status">Loading skill content...</div> : null}
        {!loading && contentView ? (
          <>
            <div className="skill-content-mode-row" role="group" aria-label="Skill content display mode">
              <button
                className={contentMode === "preview" ? "skill-mode-button active" : "skill-mode-button"}
                onClick={() => setContentMode("preview")}
                type="button"
              >
                预览
              </button>
              <button
                className={contentMode === "source" ? "skill-mode-button active" : "skill-mode-button"}
                onClick={() => setContentMode("source")}
                type="button"
              >
                原文
              </button>
            </div>
            {contentMode === "preview" ? (
              <div className="skill-markdown">
                <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                  {contentView.content}
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
  if (!target) {
    return null;
  }
  const modalType = target.type === "tool" ? "Tool" : target.type === "skill" ? "Skill" : "Background Task";
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={target.title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-kicker">{modalType}</div>
            <h2>{target.title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {target.type === "tool" ? (
          <div className="modal-content">
            <p>{target.item.description}</p>
            <div className="schema-block">
              <div className="schema-title">Input schema</div>
              <pre>{JSON.stringify(target.item.parameters, null, 2)}</pre>
            </div>
          </div>
        ) : target.type === "skill" ? (
          <SkillDetailContent skill={target.item} />
        ) : (
          <div className="modal-content">
            <dl className="detail-list">
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={statusPillClass(target.item.status)}>{target.item.status || "unknown"}</span>
                </dd>
              </div>
              <div>
                <dt>Session title</dt>
                <dd>{target.item.session_title || "未命名会话"}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd className="mono">{target.item.session_id || "-"}</dd>
              </div>
              <div>
                <dt>Turn</dt>
                <dd className="mono">{target.item.origin_turn_id || "-"}</dd>
              </div>
              <div>
                <dt>Card</dt>
                <dd className="mono">{target.item.card_id || "-"}</dd>
              </div>
              <div>
                <dt>PID</dt>
                <dd>{target.item.pid ?? "-"}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{formatDate(target.item.started_at)}</dd>
              </div>
              <div>
                <dt>Ended</dt>
                <dd>{target.item.ended_at ? formatDate(target.item.ended_at) : "-"}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(target.item.duration_sec)}</dd>
              </div>
              <div>
                <dt>Exit code</dt>
                <dd>{target.item.exit_code ?? "-"}</dd>
              </div>
              <div>
                <dt>CWD</dt>
                <dd className="mono">{target.item.cwd || "-"}</dd>
              </div>
            </dl>
            <div className="schema-block">
              <div className="schema-title">Command</div>
              <pre>{target.item.command || "-"}</pre>
            </div>
            <div className="schema-block">
              <div className="schema-title">Output tail</div>
              <pre>{target.item.output_tail || "(no output)"}</pre>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState("sessions");
  const [data, setData] = useState<DashboardData | null>(null);
  const [sessionsData, setSessionsData] = useState<SessionListPayload>(EMPTY_SESSION_LIST);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState("");
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sessionPage, setSessionPage] = useState(1);
  const [selectedSession, setSelectedSession] = useState<SessionPayload | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [sessionDetailPageLoading, setSessionDetailPageLoading] = useState(false);
  const [sessionDetailError, setSessionDetailError] = useState("");
  const [sessionDetailPageError, setSessionDetailPageError] = useState("");
  const [thinkingSaving, setThinkingSaving] = useState(false);

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
    let cancelled = false;

    async function loadSessions() {
      const safePage = Math.max(1, sessionPage);
      const params = new URLSearchParams({
        limit: String(SESSION_LIST_PAGE_SIZE),
        offset: String((safePage - 1) * SESSION_LIST_PAGE_SIZE)
      });
      if (debouncedQuery) {
        params.set("q", debouncedQuery);
      }

      setSessionsLoading(true);
      setSessionsError("");
      try {
        const payload = normalizeSessionList(
          await fetchJson<SessionListPayload>(`/api/sessions?${params.toString()}`)
        );
        if (cancelled) {
          return;
        }
        const totalPages = Math.max(1, Math.ceil(payload.total / Math.max(1, payload.limit || SESSION_LIST_PAGE_SIZE)));
        if (safePage > totalPages) {
          setSessionPage(totalPages);
          return;
        }
        setSessionsData(payload);
      } catch (err) {
        if (!cancelled) {
          setSessionsError(err instanceof Error ? err.message : String(err));
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
  }, [sessionPage, debouncedQuery]);

  function handleSessionQueryChange(value: string) {
    setQuery(value);
    setSessionPage(1);
  }

  async function openSession(session: SessionPayload) {
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

  function closeSessionDetail() {
    setSelectedSession(null);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailPageError("");
    setSessionDetailLoading(false);
    setSessionDetailPageLoading(false);
  }

  async function setCurrentThinkingLevel(level: "off" | "low") {
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

  const sessionSummary = sessionsData.summary || EMPTY_SESSION_SUMMARY;
  const totalTokens = sessionSummary.token_count;
  const totalTools = sessionSummary.tool_call_count;

  const tabs = [
    { id: "sessions", label: "Sessions", icon: <MessageSquareText size={16} /> },
    { id: "models", label: "Models", icon: <Brain size={16} /> },
    { id: "tools", label: "Tools", icon: <Wrench size={16} /> },
    { id: "skills", label: "Skills", icon: <Sparkles size={16} /> },
    { id: "background-tasks", label: "Tasks", icon: <Layers3 size={16} /> }
  ];

  return (
    <main className="app-shell">
      <section className="top-panel">
        <div className="agent-title">
          <div className="agent-avatar">
            <Bot size={26} />
          </div>
          <div>
            <div className="eyebrow">Local Harness Agent</div>
            <h1>Agent Dashboard</h1>
            <p>Sessions, models, tools and skills from the running gateway.</p>
          </div>
        </div>
        <div className="top-actions">
          <div className="health-pill">
            <CheckCircle2 size={16} />
            API {error ? "offline" : "online"}
          </div>
        </div>
      </section>

      <section className="stats-row">
        <StatTile icon={<Database size={18} />} label="Sessions" value={formatNumber(sessionSummary.total_sessions)} tone="blue" />
        <StatTile icon={<Activity size={18} />} label="Tool Calls" value={formatNumber(totalTools)} tone="green" />
        <StatTile icon={<Box size={18} />} label="Tokens" value={formatNumber(totalTokens)} tone="amber" />
        <StatTile icon={<Server size={18} />} label="Current Model" value={data?.currentModel?.model || "-"} />
      </section>

      <section className="workspace">
        <aside className="sidebar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => handleSessionQueryChange(event.target.value)}
              placeholder="Search sessions"
              aria-label="Search sessions"
            />
          </div>
          <nav className="tab-list" aria-label="Dashboard sections">
            {tabs.map((tab) => (
              <button
                className={activeTab === tab.id ? "tab active" : "tab"}
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.id !== "sessions") {
                    closeSessionDetail();
                  }
                }}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <div className="current-model-card">
            <div className="current-model-summary">
              <Clock3 size={16} />
              <div className="current-model-copy">
                <strong>{data?.currentModel?.label || "Model"}</strong>
                <span>{data?.currentModel?.provider || "-"}</span>
              </div>
            </div>
            {data?.currentModel?.thinking_state?.editable ? (
              <div className="thinking-toggle-row">
                <span className="thinking-label">Thinking</span>
                <button
                  aria-label="Toggle Kimi Coding thinking"
                  aria-pressed={data.currentModel.thinking_state.enabled}
                  className={data.currentModel.thinking_state.enabled ? "thinking-switch active" : "thinking-switch"}
                  disabled={thinkingSaving}
                  onClick={() => setCurrentThinkingLevel(data.currentModel?.thinking_state.enabled ? "off" : "low")}
                  type="button"
                >
                  <span className="thinking-switch-knob" />
                </button>
                <span className="thinking-status">
                  {data.currentModel.thinking_state.enabled ? "On" : "Off"}
                </span>
              </div>
            ) : null}
          </div>
        </aside>

        <section className="content-panel">
          {loading ? <EmptyState label="Loading dashboard data..." /> : null}
          {error ? <EmptyState label={`API error: ${error}`} /> : null}
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
                  onBack={closeSessionDetail}
                />
              ) : null}
              {activeTab === "sessions" && !selectedSession ? (
                <SessionsView
                  sessions={sessionsData.items}
                  total={sessionsData.total}
                  limit={sessionsData.limit || SESSION_LIST_PAGE_SIZE}
                  offset={sessionsData.offset || 0}
                  query={debouncedQuery}
                  loading={sessionsLoading}
                  error={sessionsError}
                  onPageChange={setSessionPage}
                  onOpen={openSession}
                />
              ) : null}
              {activeTab === "models" ? <ModelsView models={data.models.items} current={data.currentModel} /> : null}
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock3,
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
  max_output_tokens: number;
  supports_vision: boolean;
  supports_thinking: boolean;
  supports_temperature: boolean;
};

type ModelPayload = {
  provider: string;
  label: string;
  api_style: string;
  model: string;
  configured: boolean;
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
  has_older: boolean;
};

type SessionDetailPayload = {
  session: SessionPayload;
  messages: SessionMessage[];
  messages_page: MessagesPagePayload;
};

type ConversationRenderItem =
  | { type: "message"; message: SessionMessage; index: number }
  | { type: "tool_group"; messages: SessionMessage[]; startIndex: number; key: string };

type SkillPayload = {
  name: string;
  type: string;
  description: string;
  enabled: boolean;
  location: string;
  references: Array<{ path: string; description: string }>;
};

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

const SESSION_MESSAGE_PAGE_LIMIT = 50;

type DashboardData = {
  sessions: ApiList<SessionPayload>;
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

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortText(value: unknown, limit = 2200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
}

function sanitizeForDisplay(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 600 ? `${value.slice(0, 600)}... [${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDisplay(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "data" || key === "base64") && typeof item === "string" && item.length > 120) {
      cleaned[key] = `[omitted ${item.length} chars]`;
    } else {
      cleaned[key] = sanitizeForDisplay(item);
    }
  }
  return cleaned;
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
    return (
      <div className={block.is_error ? "message-block result-block error" : "message-block result-block"}>
        <div className="block-title">
          <PackageCheck size={14} />
          <span>{block.is_error ? "tool result error" : "tool result"}</span>
          {block.tool_call_id ? <code>{String(block.tool_call_id)}</code> : null}
        </div>
        <pre className="message-json">{shortText(sanitizeForDisplay(block.content ?? ""))}</pre>
      </div>
    );
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
  olderLoading,
  olderError,
  onLoadOlder,
  onBack
}: {
  fallbackSession: SessionPayload;
  detail: SessionDetailPayload | null;
  loading: boolean;
  error: string;
  olderLoading: boolean;
  olderError: string;
  onLoadOlder: () => void;
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
            <div className="message-page-toolbar">
              <div>
                <div className="message-page-count">
                  已显示 {formatNumber(visibleItemCount)} / {formatNumber(page?.total || renderItems.length)} conversation items
                  {page ? <span> · {formatNumber(page.raw_message_total)} raw messages</span> : null}
                </div>
                {olderError ? <div className="message-page-error">{olderError}</div> : null}
              </div>
              {page?.has_older ? (
                <button className="load-older-button" type="button" disabled={olderLoading} onClick={onLoadOlder}>
                  {olderLoading ? "Loading..." : "加载更早消息"}
                </button>
              ) : null}
            </div>
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
  onOpen
}: {
  sessions: SessionPayload[];
  onOpen: (session: SessionPayload) => void;
}) {
  if (!sessions.length) {
    return <EmptyState label="暂无 session 记录。" />;
  }
  return (
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
                <dd>{formatNumber(model.capabilities.max_output_tokens)}</dd>
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
    return <EmptyState label="暂无 skill。" />;
  }
  const groups = groupSkillsByType(skills);
  return (
    <div className="toolset-stack">
      {groups.map((group) => {
        const enabledCount = group.skills.filter((skill) => skill.enabled).length;
        return (
          <section className="toolset-section" key={group.type}>
            <div className="section-title-row">
              <div>
                <h2>{group.label}</h2>
                <p>
                  {group.skills.length} skills · {enabledCount} enabled
                </p>
              </div>
              <span className={enabledCount ? "status-dot on" : "status-dot"} />
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
                    <span className={skill.enabled ? "pill ok" : "pill warn"}>{skill.enabled ? "enabled" : "filtered"}</span>
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
          <div className="modal-content">
            <p>{target.item.description}</p>
            <dl className="detail-list">
              <div>
                <dt>Type</dt>
                <dd>{target.item.type}</dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd className="mono">{target.item.location}</dd>
              </div>
            </dl>
            <div className="schema-block">
              <div className="schema-title">References</div>
              {target.item.references.length ? (
                <ul className="reference-list">
                  {target.item.references.map((reference) => (
                    <li key={reference.path}>
                      <span className="mono">{reference.path}</span>
                      <small>{reference.description}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No references.</p>
              )}
            </div>
          </div>
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [query, setQuery] = useState("");
  const [selectedSession, setSelectedSession] = useState<SessionPayload | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [sessionDetailOlderLoading, setSessionDetailOlderLoading] = useState(false);
  const [sessionDetailError, setSessionDetailError] = useState("");
  const [sessionDetailOlderError, setSessionDetailOlderError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sessions, skills, toolsets, backgroundTasks, models, currentModel] = await Promise.all([
          fetchJson<ApiList<SessionPayload>>("/api/sessions?limit=100&offset=0"),
          fetchJson<ApiList<SkillPayload>>("/api/skills"),
          fetchJson<ApiList<ToolsetPayload>>("/api/tools/toolsets"),
          fetchJson<ApiList<BackgroundTaskPayload>>("/api/background-tasks"),
          fetchJson<ApiList<ModelPayload>>("/api/models"),
          fetchJson<ModelPayload>("/api/models/current")
        ]);
        if (!cancelled) {
          setData({ sessions, skills, toolsets, backgroundTasks, models, currentModel });
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

  const filteredSessions = useMemo(() => {
    const sessions = data?.sessions.items || [];
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return sessions;
    }
    return sessions.filter((session) => {
      return [session.session_id, session.title, session.model, sourceLabel(session.source_summary || session.source)]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [data, query]);

  async function openSession(session: SessionPayload) {
    setSelectedSession(session);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailOlderError("");
    setSessionDetailLoading(true);
    setSessionDetailOlderLoading(false);
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

  async function loadOlderSessionMessages() {
    if (!selectedSession || !sessionDetail || !sessionDetail.messages_page.has_older || sessionDetailOlderLoading) {
      return;
    }
    setSessionDetailOlderLoading(true);
    setSessionDetailOlderError("");
    try {
      const older = await fetchJson<SessionDetailPayload>(
        `/api/sessions/${encodeURIComponent(selectedSession.session_id)}?message_limit=${SESSION_MESSAGE_PAGE_LIMIT}&message_before=${sessionDetail.messages_page.start}`
      );
      setSessionDetail((current) => {
        if (!current || current.session.session_id !== selectedSession.session_id) {
          return older;
        }
        return {
          session: current.session,
          messages: [...older.messages, ...current.messages],
          messages_page: {
            ...older.messages_page,
            end: current.messages_page.end,
            has_older: older.messages_page.has_older,
          },
        };
      });
    } catch (err) {
      setSessionDetailOlderError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionDetailOlderLoading(false);
    }
  }

  function closeSessionDetail() {
    setSelectedSession(null);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailOlderError("");
    setSessionDetailLoading(false);
    setSessionDetailOlderLoading(false);
  }

  const totalTokens = (data?.sessions.items || []).reduce(
    (sum, session) => sum + session.input_tokens + session.output_tokens,
    0
  );
  const totalTools = (data?.sessions.items || []).reduce((sum, session) => sum + session.tool_call_count, 0);

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
        <StatTile icon={<Database size={18} />} label="Sessions" value={formatNumber(data?.sessions.total || 0)} tone="blue" />
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
              onChange={(event) => setQuery(event.target.value)}
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
            <Clock3 size={16} />
            <div>
              <strong>{data?.currentModel?.label || "Model"}</strong>
              <span>{data?.currentModel?.provider || "-"}</span>
            </div>
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
                  olderLoading={sessionDetailOlderLoading}
                  olderError={sessionDetailOlderError}
                  onLoadOlder={loadOlderSessionMessages}
                  onBack={closeSessionDetail}
                />
              ) : null}
              {activeTab === "sessions" && !selectedSession ? (
                <SessionsView sessions={filteredSessions} onOpen={openSession} />
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

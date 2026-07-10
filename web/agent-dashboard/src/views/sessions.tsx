import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  Info,
  PackageCheck,
  Search,
  Settings2,
  UserRound,
  Wrench
} from "lucide-react";

import { EmptyState } from "../components";
import { copyTextToClipboard, displayText, isRecord, sanitizeForDisplay, shortText } from "../lib/content";
import { formatDate, formatNumber } from "../format";
import { useUiText } from "../i18n";
import type { UiText } from "../i18n";
import type {
  ConversationRenderItem,
  ConversationToolGroup,
  SessionDetailPayload,
  SessionMessage,
  SessionPayload,
  SourceSummary
} from "../payloads";
import { markdownComponents } from "../ui/markdown";

function sourceLabel(source: SourceSummary | Record<string, unknown>): string {
  const platform = String(source.platform || "unknown");
  const chatType = String(source.chat_type || "");
  return [platform, chatType].filter(Boolean).join(" / ");
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

export function SessionDetailView({
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

export function SessionsIndex({
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

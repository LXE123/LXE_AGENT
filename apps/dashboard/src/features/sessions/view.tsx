import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileText,
  Info,
  LoaderCircle,
  PackageCheck,
  Plus,
  Search,
  SendHorizontal,
  Settings2,
  Square,
  UserRound,
  Wrench
} from "lucide-react";

import { EmptyState } from "../../shared/components";
import { copyTextToClipboard, displayText, isRecord, sanitizeForDisplay, shortText } from "../../shared/content";
import {
  buildConversationItems,
  hasReaderFacingText,
  hasToolError,
  roleLabel,
  toolCallBlocks,
  toolGroupArtifacts,
  toolOperations,
  toolResultBlocks,
} from "./conversation";
import type { ToolOperation } from "./conversation";
import { formatDate, formatDurationMs, formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { UiText } from "../../shared/i18n";
import type {
  ConversationToolGroup,
  DesktopConversationActivityPayload,
  DesktopConversationStreamPayload,
  DesktopConversationTurnPayload,
  SessionArtifactPayload,
  SessionDetailPayload,
  SessionMessage,
  SessionPayload,
  SourceSummary
} from "../../api/payloads";
import { markdownComponents } from "../../shared/ui/markdown";

/** How close to the bottom still counts as "following the reply". */
const BOTTOM_PIN_THRESHOLD_PX = 80;

function sourceLabel(source: SourceSummary | Record<string, unknown>): string {
  const platform = String(source.platform || "unknown");
  const chatType = String(source.chat_type || "");
  return [platform, chatType].filter(Boolean).join(" / ");
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
  const truncation = isRecord(block.dashboard_truncation) ? block.dashboard_truncation : null;
  const originalBytes = Math.max(0, Number(truncation?.original_bytes) || 0);
  const previewBytes = Math.max(0, Number(truncation?.preview_bytes) || 0);

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
      {truncation?.truncated === true ? (
        <div className="tool-result-truncation">
          {t.message.toolResultTruncated(formatNumber(previewBytes), formatNumber(originalBytes))}
        </div>
      ) : null}
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

const TOOL_NAMES_SHOWN = 3;

function toolGroupStats(messages: SessionMessage[], t: UiText) {
  const operations = toolOperations(messages);
  const errorCount = operations.filter((operation) => operation.status === "error").length;
  const callCount = operations.length;

  // A lone call describes itself: showing what it ran beats a step count that
  // always reads "1 步", and usually removes any reason to expand the row.
  const single = callCount === 1 ? operations[0] : undefined;
  if (single) {
    return {
      callCount,
      errorCount,
      hasError: errorCount > 0,
      title: single.name,
      detail: single.argument,
      detailIsArgument: true,
    };
  }

  // Which tools ran is the part worth reading, so it leads; the counts are
  // context for it rather than the other way round.
  const uniqueNames = Array.from(new Set(operations.map((operation) => operation.name)));
  const shown = uniqueNames.slice(0, TOOL_NAMES_SHOWN);
  const overflow = uniqueNames.length - shown.length;
  const title = shown.length
    ? [shown.join(" · "), overflow > 0 ? t.message.toolNamesOverflow(formatNumber(overflow)) : ""]
      .filter(Boolean).join(" ")
    : t.message.toolActivity;
  return {
    callCount,
    errorCount,
    hasError: errorCount > 0,
    title,
    detailIsArgument: false,
    detail: [
      t.message.toolSteps(formatNumber(Math.max(callCount, 1))),
      errorCount > 0 ? t.message.toolErrors(formatNumber(errorCount)) : "",
    ].filter(Boolean).join(" · "),
  };
}

function ToolTurnGroup({
  group,
  expanded,
  embedded = false,
  onOpenFile,
  onToggle,
}: {
  group: ConversationToolGroup;
  expanded: boolean;
  embedded?: boolean;
  onOpenFile: (artifactId: string) => Promise<void>;
  onToggle: () => void;
}) {
  const t = useUiText();
  const stats = toolGroupStats(group.messages, t);
  const artifacts = toolGroupArtifacts(group.messages);
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
          <div className="tool-turn-title">{stats.title}</div>
          {stats.detail ? (
            <div className={stats.detailIsArgument ? "tool-turn-subtitle argument" : "tool-turn-subtitle"}>
              {stats.detail}
            </div>
          ) : null}
        </div>
        {stats.hasError ? <CircleAlert aria-hidden="true" className="tool-turn-mark" size={13} /> : null}
        <ChevronRight size={14} className={expanded ? "tool-turn-chevron expanded" : "tool-turn-chevron"} />
      </button>
      {expanded ? <ToolOperationList group={group} /> : null}
      {artifacts.length ? <TurnFileList files={artifacts} onOpenFile={onOpenFile} /> : null}
    </section>
  );
}

function ToolOperationList({ group }: { group: ConversationToolGroup }) {
  const operations = useMemo(() => toolOperations(group.messages), [group.messages]);
  // A failed line opens itself: the reason it failed is the whole point of
  // having drilled in this far.
  const [openOperations, setOpenOperations] = useState<Map<string, boolean>>(() => new Map());
  const isOpen = (operation: ToolOperation): boolean =>
    openOperations.get(operation.key) ?? operation.status === "error";
  const toggle = (operation: ToolOperation): void => {
    const next = !isOpen(operation);
    setOpenOperations((current) => new Map(current).set(operation.key, next));
  };
  return (
    <ul className="tool-op-list">
      {operations.map((operation) => (
        <li className={`tool-op state-${operation.status}`} key={`${group.key}-${operation.key}`}>
          <button
            aria-expanded={isOpen(operation)}
            className="tool-op-summary"
            onClick={() => toggle(operation)}
            type="button"
          >
            <Wrench aria-hidden="true" size={13} />
            <span className="tool-op-name">{operation.name}</span>
            {operation.argument ? <span className="tool-op-argument">{operation.argument}</span> : null}
            {operation.status === "error"
              ? <CircleAlert aria-hidden="true" className="tool-op-mark error" size={13} />
              : <CheckCircle2 aria-hidden="true" className="tool-op-mark" size={13} />}
          </button>
          {isOpen(operation) ? (
            <div className="tool-op-body">
              {operation.call === undefined ? null : <MessageBlock block={operation.call} />}
              {operation.result === undefined ? null : <MessageBlock block={operation.result} />}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * An optimistic card is redundant once the transcript on screen was fetched at
 * or after the runtime persisted that part of the turn. Comparing watermarks
 * rather than message text keeps this working when the runtime rewrites the
 * stored text (system-event prefixes, sanitisation); a `0` watermark means the
 * transcript never received it, so the card must stay.
 */
function transcriptCaughtUp(watermark: number, transcriptFetchedAt: number): boolean {
  return watermark > 0 && transcriptFetchedAt >= watermark;
}

function LiveAssistantCard({ stream }: { stream: DesktopConversationStreamPayload }) {
  const t = useUiText();
  const hasBody = Boolean(
    stream.content || stream.thinking || stream.tool_pending || stream.tool_steps.length || stream.state !== "delta",
  );
  if (!hasBody) return null;
  const metrics = stream.display_metrics;
  const statusLabel = metrics.status === "completed"
    ? t.conversation.completed
    : metrics.status === "cancelled"
      ? t.conversation.cancelled
      : metrics.status === "error" ? t.conversation.error : t.conversation.running;
  const totalTokens = metrics.input_tokens + metrics.output_tokens;
  return (
    <article
      className={`message-card role-assistant live-assistant state-${metrics.status}`}
      aria-live="polite"
      role={metrics.status === "error" ? "alert" : undefined}
    >
      <div className="message-header">
        <RoleBadge role="assistant" />
        {stream.state === "delta" ? <LoaderCircle className="conversation-spinner" size={13} /> : null}
      </div>
      {stream.thinking ? <ThinkingBlock block={{ thinking: stream.thinking }} /> : null}
      {stream.tool_pending ? <div className="live-tool-pending"><LoaderCircle size={14} />{t.conversation.toolPending}</div> : null}
      {stream.tool_steps.length ? (
        <div className="live-tool-list">
          {stream.tool_steps.map((step) => (
            <div className={`live-tool-step state-${step.status}`} key={step.id || `${step.name}-${step.title}`}>
              <Wrench size={14} />
              <span>{step.title}</span>
              {step.detail ? <small>{step.detail}</small> : null}
            </div>
          ))}
        </div>
      ) : null}
      {stream.content ? <MessageMarkdown text={stream.content} /> : null}
      <div className="live-response-meta">
        <span>{statusLabel}</span>
        <span>{formatDurationMs(metrics.elapsed_ms)}</span>
        {metrics.model ? <span>{metrics.model}</span> : null}
        {totalTokens ? <span>{formatNumber(totalTokens)} {t.stats.tokens}</span> : null}
      </div>
    </article>
  );
}

function TurnFileList({
  files,
  onOpenFile,
}: {
  files: SessionArtifactPayload[];
  onOpenFile: (artifactId: string) => Promise<void>;
}) {
  const t = useUiText();
  const [error, setError] = useState("");
  const open = async (artifactId: string) => {
    setError("");
    try {
      await onOpenFile(artifactId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="turn-file-list">
      <span className="turn-file-label">{t.conversation.files}</span>
      {files.map((file) => (
        <button
          className="turn-file-chip"
          key={file.artifact_id}
          onClick={() => void open(file.artifact_id)}
          title={t.conversation.openFile(file.name)}
          type="button"
        >
          <FileText size={14} />
          <span>{file.name}</span>
        </button>
      ))}
      {error ? <div className="turn-file-error" role="alert">{t.conversation.openFileFailed(error)}</div> : null}
    </div>
  );
}

function LocalTurnCards({
  turn,
  transcriptFetchedAt,
}: {
  turn: DesktopConversationTurnPayload;
  transcriptFetchedAt: number;
}) {
  const t = useUiText();
  const userPersisted = transcriptCaughtUp(turn.user_persisted_at, transcriptFetchedAt);
  const assistantPersisted = transcriptCaughtUp(turn.settled_at, transcriptFetchedAt);
  const statusLabel = turn.state === "queued"
    ? t.conversation.queued
    : turn.state === "completed"
      ? t.conversation.completed
      : turn.state === "cancelled"
        ? t.conversation.cancelled
        : turn.state === "error"
          ? t.conversation.error
          : turn.state === "stopping" ? t.conversation.stopping : t.conversation.running;
  const stateBadge = <span className={`conversation-turn-state state-${turn.state}`}>{statusLabel}</span>;
  // The badge outlives the optimistic card so a cancelled or failed turn keeps
  // saying so after the transcript catches up and the card is dropped.
  const showStandaloneBadge = userPersisted && turn.state !== "completed" && turn.state !== "running";
  return (
    <div className="local-turn" data-turn-id={turn.turn_id}>
      {!userPersisted ? (
        <article className="message-card role-user optimistic-message">
          <div className="message-header">
            <RoleBadge role="user" />
            {stateBadge}
          </div>
          <MessageMarkdown text={turn.text} />
        </article>
      ) : null}
      {turn.stream && !assistantPersisted ? <LiveAssistantCard stream={turn.stream} /> : null}
      {showStandaloneBadge ? <div className="conversation-turn-state-row">{stateBadge}</div> : null}
    </div>
  );
}

function ConversationComposer({
  activity,
  runtimeReady,
  onSend,
  onStop,
}: {
  activity: DesktopConversationActivityPayload | null;
  runtimeReady: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const t = useUiText();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasWork = Boolean(activity?.active || activity?.queued.length);
  const submit = async () => {
    const message = text.trim();
    if (!runtimeReady || sending || !message) return;
    setSending(true);
    setError("");
    try {
      await onSend(message);
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };
  const stop = async () => {
    if (!hasWork || stopping) return;
    setStopping(true);
    setError("");
    try {
      await onStop();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className="conversation-composer">
      <div className="conversation-compose-box">
        <textarea
          aria-label={t.conversation.placeholder}
          disabled={!runtimeReady}
          maxLength={8192}
          onChange={(event) => {
            setText(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
          placeholder={runtimeReady ? t.conversation.placeholder : t.conversation.unavailable}
          ref={textareaRef}
          rows={1}
          value={text}
        />
        <div className="conversation-compose-actions">
          {hasWork ? (
            <button className="conversation-stop-button" disabled={stopping} onClick={() => void stop()} type="button">
              {stopping ? <LoaderCircle className="conversation-spinner" size={15} /> : <Square size={14} />}
              <span>{stopping ? t.conversation.stopping : t.conversation.stop}</span>
            </button>
          ) : null}
          <button
            aria-label={sending ? t.conversation.sending : t.conversation.send}
            className="conversation-send-button"
            disabled={!runtimeReady || sending || !text.trim()}
            onClick={() => void submit()}
            title={sending ? t.conversation.sending : t.conversation.send}
            type="button"
          >
            {sending ? <LoaderCircle className="conversation-spinner" size={17} /> : <SendHorizontal size={17} />}
          </button>
        </div>
      </div>
      <div className="conversation-compose-meta">
        <span>{runtimeReady ? t.conversation.inputHint : t.conversation.unavailable}</span>
        <span>{t.conversation.characterCount(formatNumber(text.length), formatNumber(8192))}</span>
      </div>
      {activity?.queued.length ? (
        <div className="conversation-queue-status" role="status">
          {t.conversation.queuedCount(formatNumber(activity.queued.length))}
        </div>
      ) : null}
      {error ? <div className="conversation-compose-error" role="alert">{error}</div> : null}
    </div>
  );
}

export function SessionDetailView({
  fallbackSession,
  detail,
  activity,
  newConversation,
  runtimeReady,
  transcriptFetchedAt,
  loading,
  error,
  hasOlder,
  loadingOlder,
  loadOlderError,
  onLoadOlder,
  onSend,
  onStop,
  onOpenFile,
}: {
  fallbackSession: SessionPayload | null;
  detail: SessionDetailPayload | null;
  activity: DesktopConversationActivityPayload | null;
  newConversation: boolean;
  runtimeReady: boolean;
  transcriptFetchedAt: number;
  loading: boolean;
  error: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlderError: string;
  onLoadOlder: () => Promise<unknown>;
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  onOpenFile: (artifactId: string) => Promise<void>;
}) {
  const t = useUiText();
  const session = detail?.session || fallbackSession;
  const messages = detail?.messages || [];
  const renderItems = useMemo(() => buildConversationItems(messages), [messages]);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  // Only the groups the reader has explicitly toggled; everything else follows
  // the default, which opens a group that contains an error.
  const [toolGroupOverrides, setToolGroupOverrides] = useState<Map<string, boolean>>(() => new Map());
  const transcriptRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const liveTurns = [activity?.latest, activity?.active, ...(activity?.queued ?? [])]
    .filter((turn): turn is DesktopConversationTurnPayload => Boolean(turn));
  const scrollToLatest = () => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    // Moving this container's own scrollTop, rather than scrollIntoView, keeps
    // the surrounding page where the user left it.
    transcript.scrollTop = transcript.scrollHeight;
    setPinnedToBottom(true);
  };
  useEffect(() => {
    setSessionInfoOpen(false);
    setPinnedToBottom(true);
  }, [session?.session_id]);
  useEffect(() => {
    // Following every delta would fight anyone reading back through the turn,
    // so only stay glued to the bottom when that is already where they are.
    if (!loadingOlderRef.current && pinnedToBottom) scrollToLatest();
  }, [activity?.active?.stream?.seq, activity?.queued.length, detail?.messages.length, pinnedToBottom]);
  const detailItems = session ? [
    { label: t.sessionDetail.sessionId, value: session.session_id, mono: true },
    { label: t.sessionDetail.source, value: sourceLabel(session.source_summary || session.source) },
    { label: t.sessionDetail.directory, value: session.workspace.directory, mono: true },
    { label: t.sessionDetail.worktree, value: session.workspace.worktree, mono: true },
    { label: t.sessionDetail.model, value: session.model || "-" },
    { label: t.sessionDetail.lastActive, value: formatDate(session.last_active_at) },
    { label: t.stats.messages, value: formatNumber(session.message_count) },
    { label: t.stats.toolCalls, value: formatNumber(session.tool_call_count) },
    { label: t.stats.tokens, value: formatNumber(session.input_tokens + session.output_tokens) },
    { label: t.stats.apiCalls, value: formatNumber(session.api_call_count) },
  ] : [];
  const toolGroupExpanded = (group: ConversationToolGroup): boolean =>
    toolGroupOverrides.get(group.key) ?? hasToolError(group.messages);
  const toggleToolGroup = (group: ConversationToolGroup) => {
    const next = !toolGroupExpanded(group);
    setToolGroupOverrides((current) => new Map(current).set(group.key, next));
  };
  const loadOlder = async () => {
    const transcript = transcriptRef.current;
    const previousHeight = transcript?.scrollHeight ?? 0;
    const previousTop = transcript?.scrollTop ?? 0;
    loadingOlderRef.current = true;
    try {
      await onLoadOlder();
      window.requestAnimationFrame(() => {
        if (transcript) transcript.scrollTop = previousTop + transcript.scrollHeight - previousHeight;
        loadingOlderRef.current = false;
      });
    } catch {
      loadingOlderRef.current = false;
    }
  };
  const handleTranscriptScroll = () => {
    const transcript = transcriptRef.current;
    if (!transcript || loadingOlderRef.current) return;
    const distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    setPinnedToBottom(distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX);
  };
  const showEmpty = !loading && !error && !messages.length && !liveTurns.length;
  const showJumpToLatest = !pinnedToBottom && (Boolean(messages.length) || Boolean(liveTurns.length));
  return (
    <div className="session-detail conversation-view">
      {session ? (
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
      ) : null}
      {sessionInfoOpen && session ? (
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
        <div className="conversation-scroll-area">
          <div className="conversation-transcript" onScroll={handleTranscriptScroll} ref={transcriptRef}>
            {hasOlder ? (
              <button className="conversation-load-earlier" disabled={loadingOlder} onClick={() => void loadOlder()} type="button">
                {loadingOlder ? <LoaderCircle className="conversation-spinner" size={14} /> : null}
                {loadingOlder ? t.sessionDetail.loadingEarlier : t.sessionDetail.loadEarlier}
              </button>
            ) : null}
            {loadOlderError ? <div className="message-page-error">{loadOlderError}</div> : null}
            {messages.length ? (
              <div className="message-list">
                {renderItems.map((item, itemIndex) => {
                  if (item.type === "tool_group") {
                    return <ToolTurnGroup expanded={toolGroupExpanded(item.group)} group={item.group}
                      key={item.group.key} onOpenFile={onOpenFile}
                      onToggle={() => toggleToolGroup(item.group)} />;
                  }
                  const { message, index, toolGroups } = item;
                  const role = roleLabel(message.role);
                  // A step that only thought and called a tool gets no card,
                  // no role badge: it reads as one line of process, and the
                  // thinking stays where it happened instead of being swept
                  // into the tool group beside it.
                  if (role === "assistant" && !hasReaderFacingText(message)) {
                    return (
                      <div className="process-step" key={`process-${index}`}>
                        <MessageContent content={message.content} message={message} />
                        {toolGroups.map((group) => <ToolTurnGroup embedded expanded={toolGroupExpanded(group)}
                          group={group} key={group.key} onOpenFile={onOpenFile}
                          onToggle={() => toggleToolGroup(group)} />)}
                      </div>
                    );
                  }
                  const previousItem = renderItems[itemIndex - 1];
                  const nextItem = renderItems[itemIndex + 1];
                  const isAssistantReply = (candidate: typeof previousItem): boolean =>
                    candidate?.type === "message"
                    && roleLabel(candidate.message.role) === "assistant"
                    && hasReaderFacingText(candidate.message);
                  const previousIsAssistant = isAssistantReply(previousItem);
                  const nextIsAssistant = isAssistantReply(nextItem);
                  const showRoleBadge = !(role === "assistant" && previousIsAssistant);
                  const hasMessageHeader = showRoleBadge || Boolean(message.tool_name || message.tool_call_id);
                  const chainClass = role === "assistant"
                    ? [previousIsAssistant ? "assistant-chain-from-previous" : "", nextIsAssistant ? "assistant-chain-to-next" : ""]
                      .filter(Boolean).join(" ")
                    : "";
                  // Tool activity sits beside the reply, never inside it, so a
                  // group is always read at the same level wherever it occurs.
                  return (
                    <React.Fragment key={`${role}-${index}`}>
                      <article className={`message-card role-${role} ${chainClass}`}>
                        {hasMessageHeader ? (
                          <div className="message-header">
                            {showRoleBadge ? <RoleBadge role={role} /> : null}
                            {message.tool_name ? <span className="muted">{message.tool_name}</span> : null}
                            {message.tool_call_id ? <code>{message.tool_call_id}</code> : null}
                          </div>
                        ) : null}
                        <MessageContent content={message.content} message={message} />
                      </article>
                      {toolGroups.length ? (
                        <div className="process-step">
                          {toolGroups.map((group) => <ToolTurnGroup embedded expanded={toolGroupExpanded(group)}
                            group={group} key={group.key} onOpenFile={onOpenFile}
                            onToggle={() => toggleToolGroup(group)} />)}
                        </div>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </div>
            ) : null}
            {liveTurns.map((turn) => (
              <LocalTurnCards
                key={turn.turn_id}
                transcriptFetchedAt={transcriptFetchedAt}
                turn={turn}
              />
            ))}
            {showEmpty ? (
              <EmptyState label={newConversation ? t.conversation.newHint : t.sessionDetail.empty} />
            ) : null}
          </div>
          {showJumpToLatest ? (
            <button className="conversation-jump-latest" onClick={scrollToLatest} type="button">
              <ChevronDown size={14} />
              <span>{t.conversation.jumpToLatest}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="conversation-live-status" aria-live="polite">
        {activity?.active?.state === "stopping"
          ? t.conversation.stopping
          : activity?.active ? t.conversation.running : activity?.queued.length ? t.conversation.queued : ""}
      </div>
      <ConversationComposer activity={activity} runtimeReady={runtimeReady} onSend={onSend} onStop={onStop} />
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
  onNew,
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
  onNew: () => void;
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
      <button className="session-new-button" type="button" onClick={onNew} aria-label={t.sessions.newConversationAria}>
        <Plus size={15} />
        <span>{t.sessions.newConversation}</span>
      </button>
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

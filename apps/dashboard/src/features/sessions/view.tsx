import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUpRight,
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
  Paperclip,
  Plus,
  Search,
  SendHorizontal,
  Settings2,
  Square,
  UserRound,
  Wrench,
  X
} from "lucide-react";

import { EmptyState } from "../../shared/components";
import { copyTextToClipboard, displayText, isRecord, sanitizeForDisplay, shortText } from "../../shared/content";
import {
  buildConversationItems,
  hasReaderFacingText,
  hasToolError,
  roleLabel,
  toolCallBlocks,
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
  DesktopInputAttachmentPayload,
  SessionArtifactPayload,
  SessionDetailPayload,
  SessionMessage,
  SessionPayload,
  SourceSummary
} from "../../api/payloads";
import { markdownComponents } from "../../shared/ui/markdown";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";

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
  onToggle,
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

function liveProgressLabel(
  stream: DesktopConversationStreamPayload | undefined,
  turnState: DesktopConversationTurnPayload["state"],
  t: UiText,
): string {
  if (turnState === "stopping") return t.conversation.stopping;
  if (turnState === "cancelled" || stream?.display_metrics.status === "cancelled") return t.conversation.cancelled;
  if (turnState === "error" || stream?.display_metrics.status === "error") return t.conversation.error;
  if (turnState === "completed" || stream?.display_metrics.status === "completed") return t.conversation.completed;
  if (!stream) return t.conversation.preparingContext;
  switch (stream.display_metrics.phase) {
    case "preparing_context": return t.conversation.preparingContext;
    case "waiting_model": return t.conversation.waitingModel;
    case "thinking": return t.conversation.thinking;
    case "running_tool": return t.conversation.runningTool;
    case "generating_answer": return t.conversation.generatingAnswer;
  }
}

function LiveProgressStatus({
  elapsedMs,
  label,
  state,
}: {
  elapsedMs: number;
  label: string;
  state: DesktopConversationTurnPayload["state"];
}) {
  const active = state === "running" || state === "stopping";
  const failed = state === "error";
  return (
    <div
      aria-live={failed ? "assertive" : "polite"}
      className={`live-progress-status state-${state}`}
      role={failed ? "alert" : "status"}
    >
      {active ? <LoaderCircle aria-hidden="true" className="conversation-spinner" size={13} /> : null}
      <span className="live-progress-label">{label}</span>
      {elapsedMs >= 1_000 ? (
        <>
          <span aria-hidden="true" className="live-progress-separator">·</span>
          <span aria-hidden="true" className="live-progress-elapsed">{formatDurationMs(elapsedMs)}</span>
        </>
      ) : null}
    </div>
  );
}

function LiveAssistantCard({
  elapsedMs,
  stream,
  turnState,
}: {
  elapsedMs: number;
  stream: DesktopConversationStreamPayload;
  turnState: DesktopConversationTurnPayload["state"];
}) {
  const t = useUiText();
  const metrics = stream.display_metrics;
  const displayState = metrics.status === "running" ? turnState : metrics.status;
  return (
    <article
      className={`message-card role-assistant live-assistant state-${metrics.status}`}
    >
      {stream.thinking ? <ThinkingBlock block={{ thinking: stream.thinking }} /> : null}
      {stream.tool_steps.length ? (
        <div className="live-tool-list">
          {stream.tool_steps.map((step) => (
            // The raw tool name, matching how the same call reads once it is
            // history: a curated title cannot be searched for or matched
            // against a log, and the detail beside it already says what it did.
            <div
              className={`live-tool-step state-${step.status}${step.detail ? " has-detail" : ""}`}
              key={step.id || `${step.name}-${step.title}`}
            >
              <Wrench size={14} />
              <span className="live-tool-name">{step.name}</span>
              {step.detail ? <small className="live-tool-detail">{step.detail}</small> : null}
            </div>
          ))}
        </div>
      ) : null}
      {stream.content ? <MessageMarkdown text={stream.content} /> : null}
      <LiveProgressStatus
        elapsedMs={elapsedMs}
        label={liveProgressLabel(stream, turnState, t)}
        state={displayState}
      />
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
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [opening, setOpening] = useState<Set<string>>(() => new Set());
  const open = async (artifactId: string) => {
    setErrors((current) => {
      const next = new Map(current);
      next.delete(artifactId);
      return next;
    });
    setOpening((current) => new Set(current).add(artifactId));
    try {
      await onOpenFile(artifactId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setErrors((current) => new Map(current).set(artifactId, message));
    } finally {
      setOpening((current) => {
        const next = new Set(current);
        next.delete(artifactId);
        return next;
      });
    }
  };
  return (
    <section className="turn-file-section" aria-label={t.conversation.files(formatNumber(files.length))}>
      <div className="turn-file-heading">{t.conversation.files(formatNumber(files.length))}</div>
      <div className="turn-file-grid">
        {files.map((file) => {
          const extension = fileExtensionLabel(file.name);
          const isOpening = opening.has(file.artifact_id);
          const error = errors.get(file.artifact_id) ?? "";
          return (
            <div className={error ? "turn-file-item has-error" : "turn-file-item"} key={file.artifact_id}>
              <button
                aria-busy={isOpening}
                aria-label={t.conversation.openFile(file.name)}
                className="turn-file-card"
                disabled={isOpening}
                onClick={() => void open(file.artifact_id)}
                title={t.conversation.openFile(file.name)}
                type="button"
              >
                <span aria-hidden="true" className="turn-file-extension">{extension}</span>
                <span className="turn-file-name" title={file.name}>{file.name}</span>
                {isOpening
                  ? <LoaderCircle aria-hidden="true" className="conversation-spinner turn-file-action" size={14} />
                  : <ArrowUpRight aria-hidden="true" className="turn-file-action" size={14} />}
              </button>
              {error ? (
                <div className="turn-file-card-error" role="alert">{t.conversation.openFileFailed(error)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function fileExtensionLabel(name: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return match?.[1] ? match[1].slice(0, 5).toUpperCase() : "FILE";
}

function InputAttachmentList({
  attachments,
  onOpen,
  onRemove,
}: {
  attachments: DesktopInputAttachmentPayload[];
  onOpen?: (attachmentId: string) => Promise<void>;
  onRemove?: (attachmentId: string) => void;
}) {
  const t = useUiText();
  const [error, setError] = useState("");
  const open = async (attachmentId: string) => {
    if (!onOpen) return;
    setError("");
    try {
      await onOpen(attachmentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="turn-file-list input-attachment-list">
      <span className="turn-file-label">{t.conversation.attachments}</span>
      {attachments.map((attachment) => (
        <span className="input-attachment-chip" key={attachment.attachment_id}>
          <button
            className="turn-file-chip"
            disabled={!onOpen}
            onClick={() => void open(attachment.attachment_id)}
            title={onOpen ? t.conversation.openFile(attachment.name) : attachment.name}
            type="button"
          >
            <Paperclip size={14} />
            <span>{attachment.name}</span>
          </button>
          {onRemove ? (
            <button
              aria-label={t.conversation.removeAttachment(attachment.name)}
              className="input-attachment-remove"
              onClick={() => onRemove(attachment.attachment_id)}
              type="button"
            >
              <X size={12} />
            </button>
          ) : null}
        </span>
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
  const ticking = turn.started_at > 0 && (turn.state === "running" || turn.state === "stopping");
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    setClock(Date.now());
    if (!ticking) return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [ticking, turn.started_at]);
  const elapsedEnd = ticking ? clock : turn.settled_at || clock;
  const elapsedMs = turn.started_at > 0 ? Math.max(0, elapsedEnd - turn.started_at) : 0;
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
  const showStandaloneBadge = userPersisted
    && (turn.state === "queued" || turn.state === "cancelled" || turn.state === "error");
  return (
    <div className="local-turn" data-turn-id={turn.turn_id}>
      {!userPersisted ? (
        <article className={turn.attachments?.length
          ? "message-card role-user optimistic-message has-attachments"
          : "message-card role-user optimistic-message"}>
          {turn.text ? <MessageMarkdown text={turn.text} /> : null}
          {turn.attachments?.length ? (
            <InputAttachmentList attachments={turn.attachments} />
          ) : null}
          {!turn.stream ? <div className="optimistic-message-state">{stateBadge}</div> : null}
        </article>
      ) : null}
      {turn.stream && !assistantPersisted ? (
        <LiveAssistantCard elapsedMs={elapsedMs} stream={turn.stream} turnState={turn.state} />
      ) : null}
      {userPersisted && !assistantPersisted && !turn.stream && (turn.state === "running" || turn.state === "stopping") ? (
        <LiveProgressStatus elapsedMs={elapsedMs} label={liveProgressLabel(undefined, turn.state, t)} state={turn.state} />
      ) : null}
      {showStandaloneBadge && (!turn.stream || assistantPersisted) ? (
        <div className="conversation-turn-state-row">{stateBadge}</div>
      ) : null}
    </div>
  );
}

function ConversationComposer({
  activity,
  conversationKey,
  runtimeReady,
  onSend,
  onStop,
}: {
  activity: DesktopConversationActivityPayload | null;
  conversationKey: string;
  runtimeReady: boolean;
  onSend: (text: string, attachments: DesktopInputAttachmentPayload[]) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const t = useUiText();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<DesktopInputAttachmentPayload[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousConversationKey = useRef(conversationKey);
  const hasWork = Boolean(activity?.active || activity?.queued.length);
  const showCharacterCount = text.length >= Math.floor(8192 * 0.75);
  const addAttachments = useCallback((selected: DesktopInputAttachmentPayload[]) => {
    setAttachments((current) => {
      const known = new Set(current.map((item) => item.attachment_id));
      const additions = selected.filter((item) => !known.has(item.attachment_id));
      if (current.length + additions.length > 5) {
        const rejected = additions.map((item) => item.attachment_id);
        if (rejected.length) void window.lxe?.desktop.discardConversationFiles(rejected);
        setError(t.conversation.tooManyAttachments);
        return current;
      }
      return [...current, ...additions];
    });
  }, [t]);
  const selectFiles = async () => {
    setError("");
    try {
      if (!window.lxe) throw new Error(t.conversation.unavailable);
      addAttachments(await window.lxe.desktop.selectConversationFiles());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const stageDroppedFiles = useCallback(async (files: File[]) => {
    setError("");
    try {
      if (!window.lxe) throw new Error(t.conversation.unavailable);
      addAttachments(await window.lxe.desktop.stageDroppedConversationFiles(files));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [addAttachments, t]);
  const removeAttachment = (attachmentId: string) => {
    setAttachments((current) => current.filter((item) => item.attachment_id !== attachmentId));
    void window.lxe?.desktop.discardConversationFiles([attachmentId]);
  };
  useEffect(() => {
    if (previousConversationKey.current === conversationKey) return;
    previousConversationKey.current = conversationKey;
    const attachmentIds = attachments.map((item) => item.attachment_id);
    if (attachmentIds.length) void window.lxe?.desktop.discardConversationFiles(attachmentIds);
    setAttachments([]);
    setText("");
    setError("");
  }, [attachments, conversationKey]);
  useEffect(() => {
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    };
    const dragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      setDragActive(false);
      void stageDroppedFiles(Array.from(event.dataTransfer.files));
    };
    window.addEventListener("dragover", dragOver);
    window.addEventListener("dragleave", dragLeave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("dragleave", dragLeave);
      window.removeEventListener("drop", drop);
    };
  }, [stageDroppedFiles]);
  const submit = async () => {
    const message = text.trim();
    if (!runtimeReady || sending || (!message && attachments.length === 0)) return;
    setSending(true);
    setError("");
    try {
      await onSend(message, attachments);
      setText("");
      setAttachments([]);
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
    <div className={`conversation-composer ${dragActive ? "drag-active" : ""}`}>
      {dragActive ? <div className="conversation-drop-hint">{t.conversation.dropFiles}</div> : null}
      <div className="conversation-compose-box">
        {attachments.length ? (
          <InputAttachmentList attachments={attachments} onRemove={removeAttachment} />
        ) : null}
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
          <div className="conversation-compose-leading">
            <button
              aria-label={t.conversation.addFiles}
              className="conversation-attach-button"
              disabled={!runtimeReady || sending || attachments.length >= 5}
              onClick={() => void selectFiles()}
              title={t.conversation.addFiles}
              type="button"
            >
              <Paperclip size={17} />
            </button>
            <span className="conversation-input-hint">
              {runtimeReady ? t.conversation.inputHint : t.conversation.unavailable}
            </span>
          </div>
          <div className="conversation-compose-trailing">
            {showCharacterCount ? (
              <span className="conversation-character-count">
                {t.conversation.characterCount(formatNumber(text.length), formatNumber(8192))}
              </span>
            ) : null}
            {hasWork ? (
              <button className="conversation-stop-button" disabled={stopping} onClick={() => void stop()} type="button">
                {stopping ? <LoaderCircle className="conversation-spinner" size={15} /> : <Square size={14} />}
                <span>{stopping ? t.conversation.stopping : t.conversation.stop}</span>
              </button>
            ) : null}
            <button
              aria-label={sending ? t.conversation.sending : t.conversation.send}
              className="conversation-send-button"
              disabled={!runtimeReady || sending || (!text.trim() && attachments.length === 0)}
              onClick={() => void submit()}
              title={sending ? t.conversation.sending : t.conversation.send}
              type="button"
            >
              {sending ? <LoaderCircle className="conversation-spinner" size={17} /> : <SendHorizontal size={17} />}
            </button>
          </div>
        </div>
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
  onOpenAttachment,
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
  onLoadOlder: () => Promise<SessionDetailPayload | undefined>;
  onSend: (text: string, attachments: DesktopInputAttachmentPayload[]) => Promise<void>;
  onStop: () => Promise<void>;
  onOpenFile: (artifactId: string) => Promise<void>;
  onOpenAttachment: (attachmentId: string) => Promise<void>;
}) {
  const t = useUiText();
  const session = detail?.session || fallbackSession;
  const messages = detail?.messages || [];
  const renderItems = useMemo(() => buildConversationItems(messages), [messages]);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const closeSessionInfo = () => setSessionInfoOpen(false);
  const sessionInfoRef = useDialogFocus<HTMLElement>(sessionInfoOpen, closeSessionInfo);
  // Only the groups the reader has explicitly toggled; everything else follows
  // the default, which opens a group that contains an error.
  const [toolGroupOverrides, setToolGroupOverrides] = useState<Map<string, boolean>>(() => new Map());
  const transcriptRef = useRef<HTMLDivElement>(null);
  const olderSentinelRef = useRef<HTMLDivElement>(null);
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
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const transcript = transcriptRef.current;
    const previousHeight = transcript?.scrollHeight ?? 0;
    const previousTop = transcript?.scrollTop ?? 0;
    loadingOlderRef.current = true;
    try {
      const earlier = await onLoadOlder();
      window.requestAnimationFrame(() => {
        if (transcript) transcript.scrollTop = previousTop + transcript.scrollHeight - previousHeight;
        loadingOlderRef.current = false;
        if (transcript && earlier?.messages_page.has_previous && transcript.scrollTop <= 120) void loadOlder();
      });
    } catch {
      loadingOlderRef.current = false;
    }
  }, [onLoadOlder]);
  useEffect(() => {
    const root = transcriptRef.current;
    const target = olderSentinelRef.current;
    if (!root || !target || !hasOlder || loadingOlder || loadOlderError) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
    }, { root, rootMargin: "120px 0px 0px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasOlder, loadOlder, loadOlderError, loadingOlder]);
  const handleTranscriptScroll = () => {
    const transcript = transcriptRef.current;
    if (!transcript || loadingOlderRef.current) return;
    const distanceFromBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    setPinnedToBottom(distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX);
  };
  const showEmpty = !loading && !error && !messages.length && !liveTurns.length;
  const showJumpToLatest = !pinnedToBottom && (Boolean(messages.length) || Boolean(liveTurns.length));
  const title = newConversation ? t.conversation.newTitle : session?.title || t.sessions.title;
  return (
    <div className="session-detail conversation-view">
      <header className="conversation-header">
        <div className="conversation-header-copy">
          <h2>{title}</h2>
          {session ? <span>{sourceLabel(session.source_summary || session.source)}</span> : null}
        </div>
        {session ? (
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
        ) : null}
      </header>
      {sessionInfoOpen && session ? (
        <>
          <button
            aria-label={t.sessionDetail.hideDetails}
            className="session-detail-scrim"
            onClick={closeSessionInfo}
            type="button"
          />
          <section
            aria-label={t.sessionDetail.details}
            aria-modal="true"
            className="session-detail-panel"
            ref={sessionInfoRef}
            role="dialog"
            tabIndex={-1}
          >
            <header className="session-detail-panel-header">
              <div>
                <span>{t.sessionDetail.eyebrow}</span>
                <h3>{title}</h3>
              </div>
              <button aria-label={t.sessionDetail.hideDetails} onClick={closeSessionInfo} type="button">
                <X size={17} />
              </button>
            </header>
            <dl className="session-detail-grid">
              {detailItems.map((item) => (
                <div className="session-detail-field" key={item.label}>
                  <dt>{item.label}</dt>
                  <dd className={item.mono ? "mono" : ""}>{item.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      ) : null}
      {loading ? <EmptyState label={t.sessionDetail.loading} /> : null}
      {error ? <EmptyState label={t.common.errorPrefix(t.sessionDetail.errorLabel, error)} /> : null}
      {!loading && !error ? (
        <div className="conversation-scroll-area">
          <div className="conversation-transcript" onScroll={handleTranscriptScroll} ref={transcriptRef}>
            <div className={showEmpty ? "conversation-feed is-empty" : "conversation-feed"}>
              <div className="conversation-history-sentinel" ref={olderSentinelRef}>
                {loadingOlder ? (
                  <span aria-live="polite" className="conversation-history-loading">
                    <LoaderCircle className="conversation-spinner" size={14} />
                    {t.sessionDetail.loadingEarlier}
                  </span>
                ) : null}
                {loadOlderError ? (
                  <div className="message-page-error" role="alert">
                    <span>{loadOlderError}</span>
                    <button className="conversation-load-earlier" onClick={() => void loadOlder()} type="button">
                      {t.sessionDetail.retryEarlier}
                    </button>
                  </div>
                ) : null}
              </div>
              {messages.length ? (
                <div className="message-list">
                  {renderItems.map((item, itemIndex) => {
                    if (item.type === "artifact_group") {
                      return <TurnFileList files={item.group.files} key={item.group.key} onOpenFile={onOpenFile} />;
                    }
                    if (item.type === "tool_group") {
                      return <ToolTurnGroup expanded={toolGroupExpanded(item.group)} group={item.group}
                        key={item.group.key}
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
                            group={group} key={group.key}
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
                    const showRoleBadge = role !== "assistant" && role !== "user";
                    const hasMessageHeader = showRoleBadge || Boolean(message.tool_name || message.tool_call_id);
                    const chainClass = role === "assistant"
                      ? [previousIsAssistant ? "assistant-chain-from-previous" : "", nextIsAssistant ? "assistant-chain-to-next" : ""]
                        .filter(Boolean).join(" ")
                      : "";
                    const attachmentClass = message.attachments?.length ? "has-attachments" : "";
                    // Tool activity sits beside the reply, never inside it, so a
                    // group is always read at the same level wherever it occurs.
                    return (
                      <React.Fragment key={`${role}-${index}`}>
                        <article className={`message-card role-${role} ${chainClass} ${attachmentClass}`}>
                          {hasMessageHeader ? (
                            <div className="message-header">
                              {showRoleBadge ? <RoleBadge role={role} /> : null}
                              {message.tool_name ? <span className="muted">{message.tool_name}</span> : null}
                              {message.tool_call_id ? <code>{message.tool_call_id}</code> : null}
                            </div>
                          ) : null}
                          <MessageContent content={message.content} message={message} />
                          {message.attachments?.length ? (
                            <InputAttachmentList attachments={message.attachments} onOpen={onOpenAttachment} />
                          ) : null}
                        </article>
                        {toolGroups.length ? (
                          <div className="process-step">
                            {toolGroups.map((group) => <ToolTurnGroup embedded expanded={toolGroupExpanded(group)}
                              group={group} key={group.key}
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
          </div>
          {showJumpToLatest ? (
            <button className="conversation-jump-latest" onClick={scrollToLatest} type="button">
              <ChevronDown size={14} />
              <span>{t.conversation.jumpToLatest}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="conversation-composer-dock">
        <ConversationComposer
          activity={activity}
          conversationKey={session?.session_id ?? (newConversation ? "new" : "")}
          runtimeReady={runtimeReady}
          onSend={onSend}
          onStop={onStop}
        />
      </div>
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
  onSearchClose,
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
  onSearchClose: () => void;
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
          <button
            aria-label={t.sessions.closeSearch}
            className="session-search-close"
            onClick={onSearchClose}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      <div className="session-index-heading">
        <span>{trimmedQuery ? t.sessions.searchResults(formatNumber(sessions.length)) : t.sessions.recent}</span>
      </div>
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
                  <span>{sourceLabel(session.source_summary || session.source)}</span>
                  <span aria-hidden="true" className="session-meta-separator">
                    ·
                  </span>
                  <span>{formatDate(session.last_active_at)}</span>
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

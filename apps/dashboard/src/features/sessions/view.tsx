import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  MoreVertical,
  PackageCheck,
  Paperclip,
  Plus,
  Search,
  SendHorizontal,
  Settings2,
  Square,
  Pin,
  PinOff,
  Trash2,
  UserRound,
  Wrench,
  X
} from "lucide-react";

import { EmptyState } from "../../shared/components";
import { copyTextToClipboard, displayText, isRecord, sanitizeForDisplay, shortText, splitContentBlocks } from "../../shared/content";
import {
  buildConversationItems,
  hasLiveToolOperationDetails,
  hasReaderFacingText,
  liveFinalText,
  roleLabel,
  splitCallArguments,
  summarizeToolOperations,
  toolOperationPresentation,
  toolOperations,
} from "./conversation";
import type { ToolOperation } from "./conversation";
import { formatDate, formatDurationMs, formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { UiText } from "../../shared/i18n";
import type {
  ConversationProcessItem,
  ConversationResponseGroup,
  ConversationToolGroup,
  DesktopConversationActivityPayload,
  DesktopConversationStreamPayload,
  DesktopConversationTurnPayload,
  DesktopInputAttachmentPayload,
  SessionArtifactPayload,
  SessionDetailPayload,
  SessionMessage,
  SessionPayload,
  SourceSummary,
  TurnProcessPart
} from "../../api/payloads";
import { CodeBlock, languageForPath } from "../../shared/ui/code-block";
import { markdownComponents } from "../../shared/ui/markdown";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";
import { groupSidebarSessions } from "./model";

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

const TEXT_RENDER_PACE_MS = 24;
const TEXT_RENDER_IMMEDIATE = 512;
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/;

function pacedTextEnd(text: string, start: number): number {
  const remaining = text.length - start;
  const step = remaining <= 12 ? 2 : remaining <= 48 ? 4 : remaining <= 96 ? 8 : Math.min(256, Math.ceil(remaining / 4));
  const end = Math.min(text.length, start + step);
  const limit = Math.min(text.length, end + 8);
  for (let index = end; index < limit; index += 1) {
    if (TEXT_RENDER_SNAP.test(text[index] ?? "")) return index + 1;
  }
  return end;
}

function usePacedText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => streaming && text.length > TEXT_RENDER_IMMEDIATE ? "" : text);
  useEffect(() => {
    if (!streaming || !text.startsWith(shown) || text.length <= shown.length) {
      if (shown !== text) setShown(text);
      return;
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      setShown(text);
      return;
    }
    const timer = window.setTimeout(() => {
      setShown(text.slice(0, pacedTextEnd(text, shown.length)));
    }, TEXT_RENDER_PACE_MS);
    return () => window.clearTimeout(timer);
  }, [shown, streaming, text]);
  return streaming ? shown : text;
}

const MessageMarkdown = React.memo(function MessageMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const visibleText = usePacedText(text, streaming);
  return (
    <div className="message-markdown">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {visibleText}
      </ReactMarkdown>
    </div>
  );
});

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

function ToolResultBlock({ block, language = "" }: { block: Record<string, unknown>; language?: string }) {
  const t = useUiText();
  const [copied, setCopied] = useState(false);
  // Pull the text out of the content blocks first. Stringifying the array turns
  // every real newline in the output into a literal \n and the result arrives
  // as one unreadable wall.
  const { text, residual } = splitContentBlocks(block.content ?? "");
  const resultText = text || (residual.length ? "" : displayText(block.content ?? ""));
  const residualText = residual.length
    ? displayText(sanitizeForDisplay(residual, { truncateStrings: false }))
    : "";
  const copyLabel = copied ? t.common.copied : t.message.copyResult;
  const truncation = isRecord(block.dashboard_truncation) ? block.dashboard_truncation : null;
  const originalBytes = Math.max(0, Number(truncation?.original_bytes) || 0);
  const previewBytes = Math.max(0, Number(truncation?.preview_bytes) || 0);

  const handleCopy = async () => {
    try {
      await copyTextToClipboard([resultText, residualText].filter(Boolean).join("\n"));
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
        </div>
        <div className="tool-result-actions">
          {/* Correlating an id with the logs is a debugging need, not the
              headline the reader came for. */}
          {block.tool_call_id ? (
            <code className="tool-call-id" title={`${t.message.toolCallIdLabel}: ${String(block.tool_call_id)}`}>
              {String(block.tool_call_id)}
            </code>
          ) : null}
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
      {resultText ? <CodeBlock className="tool-result-full" code={resultText} language={language} /> : null}
      {residualText ? <pre className="message-json tool-result-residual">{residualText}</pre> : null}
    </div>
  );
}

/**
 * `timeout: 120` deserves a chip, not three lines of JSON. Anything with
 * structure inside it still gets the JSON block, so nothing is flattened away.
 */
function ToolCallRest({ rest }: { rest: Record<string, unknown> }) {
  const t = useUiText();
  const entries = Object.entries(rest);
  const scalars = entries.filter(([, value]) =>
    value === null || ["string", "number", "boolean"].includes(typeof value));
  const structured = Object.fromEntries(entries.filter(([key]) =>
    !scalars.some(([scalarKey]) => scalarKey === key)));
  const hasStructured = Object.keys(structured).length > 0;
  return (
    <div className="tool-call-rest">
      {scalars.length ? (
        <div className="tool-call-chips">
          {scalars.map(([key, value]) => (
            <span className="tool-call-chip" key={key}>
              <span className="tool-call-chip-key">{key}</span>
              <span className="tool-call-chip-value">{String(value)}</span>
            </span>
          ))}
        </div>
      ) : null}
      {hasStructured ? (
        <>
          <span className="tool-call-rest-label">{t.message.toolOtherArguments}</span>
          <pre className="message-json">{shortText(sanitizeForDisplay(structured))}</pre>
        </>
      ) : null}
    </div>
  );
}

/**
 * The call side of one operation: the value that describes it rendered as what
 * it is — a shell command as shell, a path as a path — with the remaining
 * arguments kept below rather than dropped.
 */
function ToolCallArguments({ operation }: { operation: ToolOperation }) {
  const t = useUiText();
  const { primary, rest } = splitCallArguments(operation.call);
  const restKeys = Object.keys(rest);
  if (!primary && !restKeys.length) return null;
  const primaryLanguage = operation.action === "run"
    ? "bash"
    : languageForPath(primary);
  const isPath = ["read", "edit", "write", "list", "send"].includes(operation.action);
  return (
    <div className="tool-call-args">
      {primary
        ? (isPath
          ? <div className="tool-call-path" title={primary}>{primary}</div>
          : <CodeBlock code={primary} language={primaryLanguage} />)
        : null}
      {restKeys.length ? <ToolCallRest rest={rest} /> : null}
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

function ProcessMessageContent({ message }: { message: SessionMessage }) {
  const t = useUiText();
  const content = message.content;
  if (typeof content === "string") return <MessageMarkdown text={content} />;
  if (!Array.isArray(content)) {
    return content === undefined
      ? null
      : <pre className="message-json">{shortText(sanitizeForDisplay(content))}</pre>;
  }
  return (
    <div className="process-message-content">
      {content.map((block, index) => {
        const type = isRecord(block) ? String(block.type || "") : "";
        if (type === "thinking") {
          const thinking = String((block as Record<string, unknown>).thinking || "").trim();
          return thinking ? <div className="process-thinking-text" key={index}>{thinking}</div> : null;
        }
        if (type === "redacted_thinking") {
          return <div className="process-thinking-text redacted" key={index}>{t.message.redactedThinking}</div>;
        }
        if (type === "text" && isRecord(block)) {
          return <MessageMarkdown key={index} text={String(block.text || "")} />;
        }
        return <MessageBlock block={block} key={index} />;
      })}
    </div>
  );
}

const toolBatchLabels = (t: UiText) => ({
  actions: t.message.toolActions,
  more: t.message.toolBatchMore,
  failures: t.message.toolBatchFailures,
});

type ToolOperationBody = (operation: ToolOperation) => React.ReactNode;

/**
 * A read hands back file contents, so its result is highlighted as that file's
 * language. Everything else returns prose or a report and stays plain — guessing
 * a grammar for it would only mis-colour it.
 */
function resultLanguage(operation: ToolOperation): string {
  return operation.action === "read" ? languageForPath(operation.target) : "";
}

function defaultToolOperationBody(operation: ToolOperation): React.ReactNode {
  const result = operation.result;
  return (
    <>
      <ToolCallArguments operation={operation} />
      {result === undefined
        ? null
        : isRecord(result) && (result.type === "tool_result" || result.content !== undefined)
          ? <ToolResultBlock block={result} language={resultLanguage(operation)} />
          : <MessageBlock block={result} />}
    </>
  );
}

function ToolTurnGroup({
  group,
  expanded,
  embedded = false,
  onToggle,
  operations: suppliedOperations,
  renderOperationBody = defaultToolOperationBody,
}: {
  group?: ConversationToolGroup;
  expanded: boolean;
  embedded?: boolean;
  onToggle: () => void;
  operations?: ToolOperation[];
  renderOperationBody?: ToolOperationBody;
}) {
  const t = useUiText();
  const historicalOperations = useMemo(
    () => group ? toolOperations(group.messages) : [],
    [group],
  );
  const operations = suppliedOperations ?? historicalOperations;
  const summary = summarizeToolOperations(operations, toolBatchLabels(t));
  const hasError = summary.errorCount > 0;
  const hasRunning = operations.some((operation) => operation.status === "running");
  const className = [
    "tool-turn-group",
    embedded ? "embedded" : "standalone",
    hasError ? "has-error" : ""
  ]
    .filter(Boolean)
    .join(" ");
  // A one-operation batch summarises to exactly the operation's own row, so the
  // group header would print the same command a second time. The operation row
  // already carries its own chevron, spinner and error mark.
  if (operations.length === 1) {
    return (
      <section className={`${className} single`}>
        <ToolOperationList operations={operations} renderOperationBody={renderOperationBody} />
      </section>
    );
  }
  return (
    <section className={className}>
      <button
        className="tool-turn-summary"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        title={summary.text}
      >
        <span className="tool-turn-title">{summary.text || t.message.toolActivity}</span>
        {hasRunning ? <LoaderCircle aria-hidden="true" className="conversation-spinner tool-turn-mark" size={13} /> : null}
        {hasError ? <CircleAlert aria-hidden="true" className="tool-turn-mark" size={13} /> : null}
        <ChevronRight size={14} className={expanded ? "tool-turn-chevron expanded" : "tool-turn-chevron"} />
      </button>
      {expanded ? (
        <ToolOperationList operations={operations} renderOperationBody={renderOperationBody} />
      ) : null}
    </section>
  );
}

function ToolOperationList({
  operations,
  renderOperationBody,
}: {
  operations: ToolOperation[];
  renderOperationBody: ToolOperationBody;
}) {
  const t = useUiText();
  const [openOperations, setOpenOperations] = useState<Map<string, boolean>>(() => new Map());
  const isOpen = (operation: ToolOperation): boolean => openOperations.get(operation.key) ?? false;
  const toggle = (operation: ToolOperation): void => {
    const next = !isOpen(operation);
    setOpenOperations((current) => new Map(current).set(operation.key, next));
  };
  return (
    <ul className="tool-op-list">
      {operations.map((operation) => {
        const expandable = operation.expandable !== false;
        const expanded = expandable && isOpen(operation);
        return (
          <li className={`tool-op state-${operation.status}`} key={operation.key}>
            <button
              aria-expanded={expandable ? expanded : undefined}
              className="tool-op-summary"
              disabled={!expandable}
              onClick={() => toggle(operation)}
              title={[t.message.toolActions[operation.action], operation.target].filter(Boolean).join(" ")}
              type="button"
            >
              <span className="tool-op-name">{t.message.toolActions[operation.action]}</span>
              {operation.target ? <span className="tool-op-argument">{operation.target}</span> : null}
              {operation.status === "running"
                ? <LoaderCircle aria-hidden="true" className="conversation-spinner tool-op-mark" size={13} />
                : null}
              {operation.status === "error"
                ? <CircleAlert aria-hidden="true" className="tool-op-mark error" size={13} />
                : null}
              {operation.status === "success" && !expandable
                ? <span className="tool-op-status">{t.conversation.completed}</span>
                : null}
              {expandable ? (
                <ChevronRight
                  aria-hidden="true"
                  className={expanded ? "tool-op-chevron expanded" : "tool-op-chevron"}
                  size={14}
                />
              ) : null}
            </button>
            {expanded ? (
              <div className="tool-op-body">{renderOperationBody(operation)}</div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ProcessToolGroup({ group }: { group: ConversationToolGroup }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ToolTurnGroup
      embedded
      expanded={expanded}
      group={group}
      onToggle={() => setExpanded((current) => !current)}
    />
  );
}

function ProcessBody({ items }: { items: ConversationProcessItem[] }) {
  return (
    <div className="response-process-body">
      {items.map((item) => item.type === "tool_group"
        ? <ProcessToolGroup group={item.group} key={item.group.key} />
        : <ProcessMessageContent key={item.key} message={item.message} />)}
    </div>
  );
}

function responseProcessLabel(group: ConversationResponseGroup, t: UiText): string {
  const duration = group.turn?.elapsed_ms === null || group.turn?.elapsed_ms === undefined
    ? ""
    : t.conversation.elapsedDuration(group.turn.elapsed_ms);
  switch (group.turn?.status) {
    case "completed": return duration ? t.conversation.workedFor(duration) : t.conversation.process;
    case "cancelled": return t.conversation.processCancelled(duration);
    case "error": return t.conversation.processFailed(duration);
    default: return t.conversation.process;
  }
}

function PersistedResponseGroup({ group }: { group: ConversationResponseGroup }) {
  const t = useUiText();
  const [expanded, setExpanded] = useState(false);
  const failed = group.turn?.status === "error";
  const hasProcess = group.process.length > 0;
  return (
    <div className={`response-group${failed ? " has-error" : ""}`} data-turn-id={group.turn?.turn_id}>
      {hasProcess || group.turn ? (
        <section className="response-process">
          <button
            aria-expanded={expanded}
            className="response-process-summary"
            disabled={!hasProcess}
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {failed ? <CircleAlert aria-hidden="true" size={14} /> : null}
            <span>{responseProcessLabel(group, t)}</span>
            {hasProcess
              ? <ChevronRight aria-hidden="true" className={expanded ? "expanded" : ""} size={14} />
              : null}
          </button>
          {expanded ? <ProcessBody items={group.process} /> : null}
        </section>
      ) : null}
      {group.finalMessage ? (
        <article className="message-card role-assistant response-final-answer">
          <MessageContent content={group.finalMessage.content} message={group.finalMessage} />
        </article>
      ) : null}
    </div>
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
  expanded,
  label,
  onToggle,
  state,
}: {
  elapsedMs: number;
  expanded: boolean;
  label: string;
  onToggle: () => void;
  state: DesktopConversationTurnPayload["state"];
}) {
  const active = state === "running" || state === "stopping";
  const failed = state === "error";
  return (
    <button
      aria-live={failed ? "assertive" : "polite"}
      aria-expanded={expanded}
      className={`live-progress-status state-${state}`}
      onClick={onToggle}
      type="button"
    >
      {active ? <LoaderCircle aria-hidden="true" className="conversation-spinner" size={13} /> : null}
      <span className="live-progress-label">{label}</span>
      {active && elapsedMs >= 1_000 ? (
        <>
          <span aria-hidden="true" className="live-progress-separator">·</span>
          <span aria-hidden="true" className="live-progress-elapsed">{formatDurationMs(elapsedMs)}</span>
        </>
      ) : null}
      <ChevronRight aria-hidden="true" className={expanded ? "expanded" : ""} size={14} />
    </button>
  );
}

type LiveToolStep = DesktopConversationStreamPayload["tool_steps"][number];

function liveToolOperations(steps: LiveToolStep[]): ToolOperation[] {
  return steps.map((step, index) => {
    const name = String(step.name || "tool");
    const argument = String(step.detail || "");
    return {
      key: `live-${step.id || `${name}-${index}`}`,
      name,
      argument,
      ...toolOperationPresentation(name, argument),
      status: step.status,
      expandable: hasLiveToolOperationDetails(step),
      call: undefined,
      result: step,
    };
  });
}

function LiveToolOperationBody({ operation }: { operation: ToolOperation }) {
  const step = operation.result as LiveToolStep;
  const language = resultLanguage(operation);
  return (
    <>
      <ToolCallArguments operation={operation} />
      {step.result_block ? (
        <ToolResultBlock block={{ type: "tool_result", content: step.result_block.content }} language={language} />
      ) : null}
      {step.error_block ? (
        <ToolResultBlock block={{ type: "tool_result", content: step.error_block.content, is_error: true }} />
      ) : null}
    </>
  );
}

function LiveToolBatch({ steps }: { steps: LiveToolStep[] }) {
  const operations = useMemo(() => liveToolOperations(steps), [steps]);
  const [expanded, setExpanded] = useState(false);
  const appeared = useRef(false);
  const manuallyToggled = useRef(false);
  useEffect(() => {
    if (!appeared.current && operations.length > 0) {
      appeared.current = true;
      if (!manuallyToggled.current) setExpanded(true);
    }
  }, [operations.length]);
  return (
    <ToolTurnGroup
      embedded
      expanded={expanded}
      operations={operations}
      onToggle={() => {
        manuallyToggled.current = true;
        setExpanded((current) => !current);
      }}
      renderOperationBody={(operation) => <LiveToolOperationBody operation={operation} />}
    />
  );
}

type LiveTimelineItem =
  | { type: "part"; partId: string }
  | { type: "tool_group"; key: string; partIds: string[] };

function liveTimeline(parts: TurnProcessPart[]): LiveTimelineItem[] {
  const items: LiveTimelineItem[] = [];
  for (const part of [...parts].sort((left, right) => left.sequence - right.sequence)) {
    if (part.type === "text" && part.presentation === "final") continue;
    if (part.type === "tool") {
      const previous = items.at(-1);
      if (previous?.type === "tool_group") previous.partIds.push(part.part_id);
      else items.push({ type: "tool_group", key: `live-tools-${part.part_id}`, partIds: [part.part_id] });
    } else {
      items.push({ type: "part", partId: part.part_id });
    }
  }
  return items;
}

const LiveThinkingPart = React.memo(function LiveThinkingPart({
  part,
}: {
  part: Extract<TurnProcessPart, { type: "thinking" }>;
}) {
  const t = useUiText();
  const text = usePacedText(part.text, part.status === "streaming");
  return (
    <div className="process-message-content">
      {text ? <div className="process-thinking-text">{text}</div> : null}
      {Array.from({ length: part.redacted_count }, (_, index) => (
        <div className="process-thinking-text redacted" key={index}>{t.message.redactedThinking}</div>
      ))}
    </div>
  );
});

const LiveTextPart = React.memo(function LiveTextPart({
  part,
}: {
  part: Exclude<TurnProcessPart, { type: "tool" }>;
}) {
  return part.type === "thinking"
    ? <LiveThinkingPart part={part} />
    : <MessageMarkdown streaming={part.status === "streaming"} text={part.text} />;
});

function LiveProcessBody({ parts }: { parts: TurnProcessPart[] }) {
  const timeline = useRef<{ key: string; items: LiveTimelineItem[] } | undefined>(undefined);
  const structureKey = parts
    .map((part) => `${part.sequence}:${part.part_id}:${part.type}:${part.type === "text" ? part.presentation : ""}`)
    .join("|");
  if (timeline.current?.key !== structureKey) {
    timeline.current = { key: structureKey, items: liveTimeline(parts) };
  }
  const partById = new Map(parts.map((part) => [part.part_id, part]));
  return (
    <div className="response-process-body">
      {timeline.current.items.map((item) => {
        if (item.type === "tool_group") {
          const steps = item.partIds.flatMap((partId) => {
            const part = partById.get(partId);
            return part?.type === "tool" ? [part.tool_step] : [];
          });
          return <LiveToolBatch key={item.key} steps={steps} />;
        }
        const part = partById.get(item.partId);
        return part && part.type !== "tool"
          ? <LiveTextPart key={part.part_id} part={part} />
          : null;
      })}
    </div>
  );
}

function LiveResponseGroup({
  elapsedMs,
  hasElapsed,
  stream,
  turnState,
}: {
  elapsedMs: number;
  hasElapsed: boolean;
  stream?: DesktopConversationStreamPayload;
  turnState: DesktopConversationTurnPayload["state"];
}) {
  const t = useUiText();
  const active = turnState === "running" || turnState === "stopping";
  const [expanded, setExpanded] = useState(active);
  const wasActive = useRef(active);
  useEffect(() => {
    if (!wasActive.current && active) setExpanded(true);
    if (wasActive.current && !active) setExpanded(false);
    wasActive.current = active;
  }, [active]);
  const streamStatus = stream?.display_metrics.status;
  const displayState = streamStatus && streamStatus !== "running" ? streamStatus : turnState;
  const duration = hasElapsed ? t.conversation.elapsedDuration(elapsedMs) : "";
  const label = displayState === "completed"
    ? (duration ? t.conversation.workedFor(duration) : t.conversation.process)
    : displayState === "cancelled"
      ? t.conversation.processCancelled(duration)
      : displayState === "error"
        ? t.conversation.processFailed(duration)
        : liveProgressLabel(stream, turnState, t);
  const processParts = stream?.process_parts ?? [];
  const finalContent = useMemo(
    () => liveFinalText(stream?.process_parts ?? []),
    [stream?.process_parts],
  );
  return (
    <div className={`response-group live-response-group state-${displayState}`}>
      <section className="response-process">
        <LiveProgressStatus
          elapsedMs={elapsedMs}
          expanded={expanded}
          label={label}
          onToggle={() => setExpanded((current) => !current)}
          state={displayState}
        />
        {expanded && processParts.length ? <LiveProcessBody parts={processParts} /> : null}
      </section>
      {finalContent ? (
        <article className="message-card role-assistant response-final-answer">
          <MessageMarkdown text={finalContent} />
        </article>
      ) : null}
    </div>
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
  persistedResponse,
  turn,
  transcriptFetchedAt,
}: {
  persistedResponse: boolean;
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
  const assistantPersisted = persistedResponse && transcriptCaughtUp(turn.settled_at, transcriptFetchedAt);
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
    && !persistedResponse
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
      {!assistantPersisted && (turn.stream || (userPersisted && (turn.state === "running" || turn.state === "stopping"))) ? (
        <LiveResponseGroup
          elapsedMs={elapsedMs}
          hasElapsed={turn.started_at > 0}
          stream={turn.stream}
          turnState={turn.state}
        />
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
  const allRenderItems = useMemo(() => buildConversationItems(messages), [messages]);
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
  const liveTurns = [...new Map(
    [activity?.latest, activity?.active, ...(activity?.queued ?? [])]
      .filter((turn): turn is DesktopConversationTurnPayload => Boolean(turn))
      .map((turn) => [turn.turn_id, turn]),
  ).values()];
  const persistedResponseTurnIds = new Set(allRenderItems
    .filter((item): item is Extract<(typeof allRenderItems)[number], { type: "response_group" }> =>
      item.type === "response_group" && Boolean(item.group.turn?.turn_id))
    .map((item) => item.group.turn!.turn_id));
  const liveOwnedTurnIds = new Set(liveTurns
    .filter((turn) => (turn.stream || turn.state === "running" || turn.state === "stopping")
      && !transcriptCaughtUp(turn.settled_at, transcriptFetchedAt))
    .map((turn) => turn.turn_id));
  const liveArtifactGroups = new Map(allRenderItems
    .filter((item): item is Extract<(typeof allRenderItems)[number], { type: "artifact_group" }> =>
      item.type === "artifact_group" && liveOwnedTurnIds.has(item.group.turnId))
    .map((item) => [item.group.turnId, item.group]));
  const renderItems = allRenderItems.filter((item) => {
    if (item.type === "response_group" && item.group.turn?.turn_id) {
      return !liveOwnedTurnIds.has(item.group.turn.turn_id);
    }
    if (item.type === "artifact_group") return !liveOwnedTurnIds.has(item.group.turnId);
    return true;
  });
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
    if (loadingOlderRef.current || !pinnedToBottom) return;
    const frame = window.requestAnimationFrame(scrollToLatest);
    return () => window.cancelAnimationFrame(frame);
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
    toolGroupOverrides.get(group.key) ?? false;
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
                    if (item.type === "response_group") {
                      return <PersistedResponseGroup group={item.group} key={item.group.key} />;
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
                <React.Fragment key={turn.turn_id}>
                  <LocalTurnCards
                    persistedResponse={persistedResponseTurnIds.has(turn.turn_id)}
                    transcriptFetchedAt={transcriptFetchedAt}
                    turn={turn}
                  />
                  {liveArtifactGroups.get(turn.turn_id) ? (
                    <TurnFileList
                      files={liveArtifactGroups.get(turn.turn_id)!.files}
                      onOpenFile={onOpenFile}
                    />
                  ) : null}
                </React.Fragment>
              ))}
              {showEmpty && !newConversation ? (
                <EmptyState label={t.sessionDetail.empty} />
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

function SessionActionsMenu({
  anchor,
  deletingBlocked,
  error,
  pending,
  session,
  onClose,
  onDelete,
  onPin,
}: {
  anchor: HTMLElement;
  deletingBlocked: boolean;
  error: string;
  pending: boolean;
  session: SessionPayload;
  onClose: (restoreFocus?: boolean) => void;
  onDelete: () => void;
  onPin: () => void;
}) {
  const t = useUiText();
  const menuRef = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  const width = 190;
  const estimatedHeight = error ? 142 : 104;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
  const top = rect.bottom + 5 + estimatedHeight <= window.innerHeight
    ? rect.bottom + 5
    : Math.max(8, rect.top - estimatedHeight - 5);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    });
    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target) && !anchor.contains(target)) {
        onClose(false);
      }
    };
    document.addEventListener("pointerdown", pointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", pointerDown);
    };
  }, [anchor, onClose]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return createPortal(
    <div
      aria-label={t.sessions.actionsFor(session.title || t.common.unnamedSession)}
      className="session-actions-menu"
      onKeyDown={handleKeyDown}
      ref={menuRef}
      role="menu"
      style={{ left, top, width }}
    >
      <button disabled={pending} onClick={onPin} role="menuitem" type="button">
        {session.pinned_at > 0 ? <PinOff size={15} /> : <Pin size={15} />}
        <span>{session.pinned_at > 0 ? t.sessions.unpin : t.sessions.pin}</span>
      </button>
      <button
        className="danger"
        disabled={pending || deletingBlocked}
        onClick={onDelete}
        role="menuitem"
        title={deletingBlocked ? t.sessions.deleteRunning : undefined}
        type="button"
      >
        <Trash2 size={15} />
        <span>{t.sessions.delete}</span>
      </button>
      {deletingBlocked ? <p className="session-actions-hint">{t.sessions.deleteRunning}</p> : null}
      {error ? <p className="session-actions-error" role="alert">{error}</p> : null}
    </div>,
    document.body,
  );
}

function SessionDeleteDialog({
  error,
  pending,
  session,
  onCancel,
  onConfirm,
}: {
  error: string;
  pending: boolean;
  session: SessionPayload;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useUiText();
  const dialogRef = useDialogFocus<HTMLElement>(true, onCancel);
  const title = session.title || t.common.unnamedSession;
  return createPortal(
    <div className="session-delete-backdrop">
      <section
        aria-labelledby="session-delete-title"
        aria-modal="true"
        className="session-delete-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 id="session-delete-title">{t.sessions.deleteTitle}</h2>
        <p>{t.sessions.deletePrompt(title)}</p>
        <p className="session-delete-note">{t.sessions.deleteNote}</p>
        {error ? <p className="session-delete-error" role="alert">{error}</p> : null}
        <footer>
          <button disabled={pending} onClick={onCancel} type="button">{t.sessions.cancelDelete}</button>
          <button className="danger" disabled={pending} onClick={onConfirm} type="button">
            {pending ? <LoaderCircle className="conversation-spinner" size={14} /> : null}
            <span>{pending ? t.sessions.deleting : t.sessions.deleteConfirm}</span>
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function SessionsIndex({
  sessions,
  query,
  searchOpen,
  searchFocusKey = 0,
  initialLoading,
  loadingMore,
  error,
  hasMore,
  loadMoreError,
  selectedSessionId,
  onQueryChange,
  onSearchClose,
  onLoadMore,
  onNew,
  onOpen,
  onPin,
  onDelete,
  onTransientInteractionChange,
  visible = true,
  deleteBlockedSessionIds = [],
}: {
  sessions: SessionPayload[];
  query: string;
  searchOpen: boolean;
  searchFocusKey?: number;
  initialLoading: boolean;
  loadingMore: boolean;
  error: string;
  hasMore: boolean;
  loadMoreError: string;
  selectedSessionId: string;
  onQueryChange: (value: string) => void;
  onSearchClose: () => void;
  onLoadMore: () => void;
  onNew: () => void;
  onOpen: (session: SessionPayload) => void;
  onPin: (session: SessionPayload, pinned: boolean) => Promise<void>;
  onDelete: (session: SessionPayload) => Promise<void>;
  onTransientInteractionChange?: (active: boolean) => void;
  visible?: boolean;
  deleteBlockedSessionIds?: readonly string[];
}) {
  const t = useUiText();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const trimmedQuery = query.trim();
  const emptyLabel = trimmedQuery ? t.sessions.emptySearch : t.sessions.empty;
  const showTable = sessions.length > 0;
  const [menu, setMenu] = useState<{ anchor: HTMLElement; session: SessionPayload } | null>(null);
  const [confirmation, setConfirmation] = useState<SessionPayload | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const blockedIds = useMemo(() => new Set(deleteBlockedSessionIds), [deleteBlockedSessionIds]);
  const { pinned: pinnedSessions, recent: recentSessions } = groupSidebarSessions(sessions, Boolean(trimmedQuery));
  const transientInteractionActive = Boolean(menu);

  useEffect(() => {
    onTransientInteractionChange?.(transientInteractionActive);
    return () => {
      if (transientInteractionActive) onTransientInteractionChange?.(false);
    };
  }, [onTransientInteractionChange, transientInteractionActive]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen, searchFocusKey]);

  function maybeLoadMore() {
    const list = sessionListRef.current;
    if (!list || initialLoading || loadingMore || !hasMore || loadMoreError) {
      return;
    }
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceToBottom <= 80) {
      onLoadMore();
    }
  }

  useEffect(() => {
    maybeLoadMore();
  }, [sessions.length, initialLoading, loadingMore, hasMore, loadMoreError]);

  const closeMenu = useCallback((restoreFocus = true) => {
    setMenu((current) => {
      if (restoreFocus) current?.anchor.focus();
      return null;
    });
    setActionError("");
  }, []);

  useEffect(() => {
    if (visible) return;
    closeMenu(false);
  }, [closeMenu, visible]);

  async function pinSelected() {
    if (!menu || actionPending) return;
    setActionPending(true);
    setActionError("");
    try {
      await onPin(menu.session, menu.session.pinned_at <= 0);
      closeMenu();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }

  async function deleteConfirmed() {
    if (!confirmation || actionPending) return;
    setActionPending(true);
    setActionError("");
    try {
      await onDelete(confirmation);
      setConfirmation(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionPending(false);
    }
  }

  const renderSession = (session: SessionPayload) => {
    const selected = selectedSessionId === session.session_id;
    const sessionTitle = session.title || t.common.unnamedSession;
    const menuOpen = menu?.session.session_id === session.session_id;
    return (
      <div className={`${selected ? "session-index-item active" : "session-index-item"}${menuOpen ? " menu-open" : ""}`} key={session.session_id}>
        <button
          aria-current={selected ? "page" : undefined}
          aria-label={sessionTitle}
          className="session-index-open"
          title={sessionTitle}
          type="button"
          onClick={() => onOpen(session)}
        >
          <span aria-hidden="true" className="session-index-icon" />
          <span className="primary-cell">{sessionTitle}</span>
        </button>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={t.sessions.actionsFor(sessionTitle)}
          className="session-index-actions"
          onClick={(event) => {
            event.stopPropagation();
            setActionError("");
            setMenu(menuOpen ? null : { anchor: event.currentTarget, session });
          }}
          title={t.sessions.actionsFor(sessionTitle)}
          type="button"
        >
          <MoreVertical size={15} />
        </button>
      </div>
    );
  };

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
      {error ? <EmptyState label={t.common.errorPrefix(t.sessions.errorLabel, error)} /> : null}
      {!showTable && initialLoading && !error ? <EmptyState label={t.sessions.loading} /> : null}
      {!showTable && !initialLoading && !error ? <EmptyState label={emptyLabel} /> : null}
      {showTable ? (
        <div
          className="session-index-list"
          onScroll={() => {
            closeMenu(false);
            maybeLoadMore();
          }}
          ref={sessionListRef}
        >
          {trimmedQuery ? <div className="session-index-heading">{t.sessions.searchResults(formatNumber(sessions.length))}</div> : null}
          {pinnedSessions.length > 0 ? (
            <div className="session-index-heading">{t.sessions.pinned}</div>
          ) : null}
          {pinnedSessions.map(renderSession)}
          {!trimmedQuery && recentSessions.length > 0 ? (
            <div className="session-index-heading">{t.sessions.recent}</div>
          ) : null}
          {recentSessions.map(renderSession)}
          {loadingMore ? (
            <span aria-label={t.common.loading} className="sessions-load-more-indicator" role="status">
              <LoaderCircle aria-hidden="true" className="conversation-spinner" size={14} />
            </span>
          ) : null}
          {loadMoreError ? (
            <div className="session-load-more-error">{t.common.errorPrefix(t.sessions.errorLabel, loadMoreError)}</div>
          ) : null}
        </div>
      ) : null}
      {menu ? (
        <SessionActionsMenu
          anchor={menu.anchor}
          deletingBlocked={blockedIds.has(menu.session.session_id)}
          error={actionError}
          pending={actionPending}
          session={menu.session}
          onClose={closeMenu}
          onDelete={() => {
            if (blockedIds.has(menu.session.session_id)) return;
            setConfirmation(menu.session);
            closeMenu(false);
          }}
          onPin={() => void pinSelected()}
        />
      ) : null}
      {confirmation ? (
        <SessionDeleteDialog
          error={actionError}
          pending={actionPending}
          session={confirmation}
          onCancel={() => {
            if (actionPending) return;
            setConfirmation(null);
            setActionError("");
          }}
          onConfirm={() => void deleteConfirmed()}
        />
      ) : null}
    </div>
  );
}

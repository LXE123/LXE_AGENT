import type {
  SessionDetailPayload,
  SessionListPayload,
  SessionMessage,
  SessionSummaryPayload,
} from "../../api/payloads";

export const EMPTY_SESSION_SUMMARY: SessionSummaryPayload = {
  total_sessions: 0,
  tool_call_count: 0,
  token_count: 0
};

export function normalizeSessionList(payload: SessionListPayload, pageSize: number): SessionListPayload {
  const summary = payload.summary || EMPTY_SESSION_SUMMARY;
  return {
    ...payload,
    items: Array.isArray(payload.items) ? payload.items : [],
    total: Math.max(0, Number(payload.total) || 0),
    limit: Math.max(1, Number(payload.limit) || pageSize),
    offset: Math.max(0, Number(payload.offset) || 0),
    summary: {
      total_sessions: Math.max(0, Number(summary.total_sessions) || 0),
      tool_call_count: Math.max(0, Number(summary.tool_call_count) || 0),
      token_count: Math.max(0, Number(summary.token_count) || 0)
    }
  };
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

type ConversationDisplayGroup = {
  id: string;
  messages: SessionMessage[];
};

const conversationDisplayGroups = (messages: SessionMessage[]): ConversationDisplayGroup[] => {
  const groups: ConversationDisplayGroup[] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (previous?.id === message.display_group_id) previous.messages.push(message);
    else groups.push({ id: message.display_group_id, messages: [message] });
  }
  return groups;
};

const flattenConversationGroups = (groups: ConversationDisplayGroup[]): SessionMessage[] =>
  groups.flatMap((group) => group.messages);

/** Refreshes the mutable transcript tail while preserving a contiguous loaded prefix. */
export function mergeLatestConversationWindow(
  current: SessionDetailPayload | undefined,
  latest: SessionDetailPayload,
): SessionDetailPayload {
  if (!current || current.session.session_id !== latest.session.session_id) return latest;
  const currentGroups = conversationDisplayGroups(current.messages);
  const latestGroups = conversationDisplayGroups(latest.messages);
  if (!latestGroups.length) return latest.messages_page.total === 0 ? latest : current;
  const currentIndexes = new Map(currentGroups.map((group, index) => [group.id, index]));
  const firstOverlap = latestGroups.findIndex((group) => currentIndexes.has(group.id));
  if (firstOverlap < 0) return latest;
  const currentCut = currentIndexes.get(latestGroups[firstOverlap]!.id)!;
  return {
    ...latest,
    messages: flattenConversationGroups([
      ...currentGroups.slice(0, currentCut),
      ...latestGroups.slice(firstOverlap),
    ]),
    messages_page: {
      ...latest.messages_page,
      oldest_cursor: current.messages_page.oldest_cursor,
      previous_cursor: current.messages_page.previous_cursor,
      has_previous: current.messages_page.has_previous,
    },
  };
}

/** Prepends a cursor page without disturbing the latest transcript watermark. */
export function prependConversationWindow(
  current: SessionDetailPayload,
  earlier: SessionDetailPayload,
): SessionDetailPayload {
  if (current.session.session_id !== earlier.session.session_id) return current;
  const currentGroups = conversationDisplayGroups(current.messages);
  const currentIds = new Set(currentGroups.map((group) => group.id));
  const earlierGroups = conversationDisplayGroups(earlier.messages)
    .filter((group) => !currentIds.has(group.id));
  return {
    ...current,
    messages: flattenConversationGroups([...earlierGroups, ...currentGroups]),
    messages_page: {
      ...current.messages_page,
      oldest_cursor: earlier.messages_page.oldest_cursor ?? current.messages_page.oldest_cursor,
      previous_cursor: earlier.messages_page.previous_cursor,
      has_previous: earlier.messages_page.has_previous,
    },
  };
}

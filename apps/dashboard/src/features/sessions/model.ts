import type { SessionListPayload, SessionSummaryPayload } from "../../api/payloads";

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

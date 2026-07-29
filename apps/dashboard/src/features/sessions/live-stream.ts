import type {
  DesktopConversationActivityPayload,
  DesktopConversationStreamBatch,
  DesktopConversationStreamPayload,
  DesktopConversationTurnPayload,
  TurnProcessPart,
} from "../../api/payloads";

export type StreamBatchApplyResult =
  | { status: "applied"; activity: DesktopConversationActivityPayload }
  | { status: "ignored"; activity: DesktopConversationActivityPayload }
  | { status: "gap"; activity: DesktopConversationActivityPayload };

const cloneToolStep = (step: Extract<TurnProcessPart, { type: "tool" }>["tool_step"]) => ({
  ...step,
  ...(step.result_block ? { result_block: { ...step.result_block } } : {}),
  ...(step.error_block ? { error_block: { ...step.error_block } } : {}),
});

const clonePart = (part: TurnProcessPart): TurnProcessPart => part.type === "tool"
  ? { ...part, tool_step: cloneToolStep(part.tool_step) }
  : { ...part };

function applyToTurn(
  turn: DesktopConversationTurnPayload,
  batch: DesktopConversationStreamBatch,
): { status: StreamBatchApplyResult["status"]; turn: DesktopConversationTurnPayload } {
  if (turn.turn_id !== batch.turn_id) return { status: "ignored", turn };
  const currentSeq = turn.stream?.seq ?? 0;
  if (batch.seq <= currentSeq) return { status: "ignored", turn };
  if (batch.seq !== currentSeq + 1) return { status: "gap", turn };

  const parts = turn.stream?.process_parts.slice() ?? [];
  const indexes = new Map(parts.map((part, index) => [part.part_id, index]));
  let state = turn.stream?.state ?? "delta";
  let metrics = turn.stream?.display_metrics;
  for (const mutation of batch.mutations) {
    if (mutation.kind === "part_delta") {
      const index = indexes.get(mutation.part_id);
      const current = index === undefined ? undefined : parts[index];
      if (index === undefined || !current || (current.type !== "thinking" && current.type !== "text")) {
        return { status: "gap", turn };
      }
      parts[index] = { ...current, text: current.text + mutation.delta };
      continue;
    }
    if (mutation.kind === "stream_updated") {
      state = mutation.state;
      metrics = { ...mutation.display_metrics };
      continue;
    }
    const incoming = clonePart(mutation.part);
    const index = indexes.get(incoming.part_id);
    if (index === undefined) {
      const last = parts.at(-1);
      if (last && incoming.sequence <= last.sequence) return { status: "gap", turn };
      indexes.set(incoming.part_id, parts.length);
      parts.push(incoming);
      continue;
    }
    const current = parts[index];
    if (!current || current.type !== incoming.type || current.sequence !== incoming.sequence) {
      return { status: "gap", turn };
    }
    parts[index] = incoming;
  }
  if (!metrics) return { status: "gap", turn };
  const tools = parts
    .filter((part): part is Extract<TurnProcessPart, { type: "tool" }> => part.type === "tool")
    .map((part) => cloneToolStep(part.tool_step));
  const stream: DesktopConversationStreamPayload = {
    seq: batch.seq,
    state,
    content: parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
    thinking: parts.filter((part) => part.type === "thinking").map((part) => part.text).join(""),
    redacted_thinking_count: parts
      .filter((part): part is Extract<TurnProcessPart, { type: "thinking" }> => part.type === "thinking")
      .reduce((total, part) => total + part.redacted_count, 0),
    thinking_elapsed_ms: turn.stream?.thinking_elapsed_ms ?? 0,
    tool_pending: false,
    tool_elapsed_ms: tools.reduce((total, step) => total + step.duration_ms, 0),
    tool_steps: tools,
    process_parts: parts,
    display_metrics: metrics,
  };
  return { status: "applied", turn: { ...turn, stream } };
}

export function applyDesktopStreamBatch(
  activity: DesktopConversationActivityPayload,
  batch: DesktopConversationStreamBatch,
): StreamBatchApplyResult {
  if (activity.session_id !== batch.session_id) return { status: "ignored", activity };
  const candidates = [activity.active, activity.latest, ...activity.queued].filter(
    (turn): turn is DesktopConversationTurnPayload => Boolean(turn && turn.turn_id === batch.turn_id),
  );
  if (!candidates.length) return { status: "gap", activity };
  const result = applyToTurn(candidates[0]!, batch);
  if (result.status !== "applied") return { status: result.status, activity };
  const replace = (turn: DesktopConversationTurnPayload | null) =>
    turn?.turn_id === batch.turn_id ? result.turn : turn;
  return {
    status: "applied",
    activity: {
      ...activity,
      active: replace(activity.active),
      latest: replace(activity.latest),
      queued: activity.queued.map((turn) => replace(turn)!),
    },
  };
}

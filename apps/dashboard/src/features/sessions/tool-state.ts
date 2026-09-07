import type { DesktopConversationTurnPayload } from "@lxe/desktop-protocol";

type Stream = NonNullable<DesktopConversationTurnPayload["stream"]>;
type Step = Stream["tool_steps"][number];
export const isToolTerminal = (status: string | undefined): boolean => status === "success" || status === "error";

/** Background completion can update tools without advancing the model's batch seq. */
export function mergeToolStream(previous: Stream | undefined, incoming: Stream | undefined): Stream | undefined {
  if (!previous) return incoming;
  if (!incoming || incoming.seq < previous.seq) return previous;
  const sameSequence = incoming.seq === previous.seq;
  const oldSteps = new Map(previous.process_parts.filter(part => part.type === "tool").map(part => [part.tool_step.id, part.tool_step]));
  const newSteps = new Map(incoming.process_parts.filter(part => part.type === "tool").map(part => [part.tool_step.id, part.tool_step]));
  const base = sameSequence ? previous : incoming;
  let changed = false;
  const merge = (step: Step): Step => {
    const old = oldSteps.get(step.id);
    const next = newSteps.get(step.id);
    let merged = step;
    if (sameSequence) {
      if (old?.status === "running" && next && isToolTerminal(next.status)) merged = next;
    } else if (old && isToolTerminal(old.status) && next?.status !== old.status) {
      merged = old;
    }
    if (merged !== step) changed = true;
    return merged;
  };
  const process_parts = base.process_parts.map(part => {
    if (part.type !== "tool") return part;
    const step = merge(part.tool_step);
    return step === part.tool_step ? part : { ...part, tool_step: step };
  });
  const tool_steps = (base.tool_steps ?? []).map(merge);
  return changed ? { ...base, process_parts, tool_steps } : base;
}

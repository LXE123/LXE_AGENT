import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import type { JsonObject } from "@lxe/protocol";

export type TerminalStatus = "completed" | "cancelled" | "error";
export type TurnEnd = { turn_id: string; id: string; status: TerminalStatus };
export const isTerminalStatus = (value: unknown): value is TerminalStatus =>
  value === "completed" || value === "cancelled" || value === "error";

/** Late artifact and title writes cannot move the conversation back to an older turn. */
export function currentTurnId(event: JsonObject, previous: string): string {
  if (typeof event.turn_id !== "string" || !event.turn_id) return previous;
  const userInput = event.kind === "message" && ["turn_input", "user_input", "inbound"].includes(String(event.reason));
  if (!previous || event.kind === "turn_context" || event.kind === "turn_end" || userInput) return event.turn_id;
  return previous;
}

export function legacyTurnEnds(events: JsonObject[], statusOf: (id: string) => unknown): TurnEnd[] {
  const ends = new Map<string, string>();
  let current = "";
  for (const event of events) {
    current = currentTurnId(event, current);
    if (current && (event.turn_id === current || event.kind === "context_patch" && event.patch_kind === "compaction")) {
      ends.set(current, String(event.id));
    }
  }
  return Array.from(ends).flatMap(([turn_id, id]) => {
    const status = statusOf(turn_id);
    return isTerminalStatus(status) ? [{ turn_id, id, status }] : [];
  });
}

export function headerTurnEnds(header: JsonObject): TurnEnd[] {
  if (!Array.isArray(header.legacy_turn_ends)) return [];
  return header.legacy_turn_ends.map(value => {
    const end = value as Partial<TurnEnd> | null;
    if (!end || typeof end.id !== "string" || typeof end.turn_id !== "string" || !isTerminalStatus(end.status)) {
      throw new Error("Invalid legacy transcript turn boundary");
    }
    return end as TurnEnd;
  });
}

export async function publishTranscript(path: string, events: readonly JsonObject[]): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      let buffer = "";
      for (const event of events) {
        buffer += JSON.stringify(event) + "\n";
        if (buffer.length >= 1024 * 1024) {
          await file.writeFile(buffer);
          buffer = "";
        }
      }
      if (buffer) await file.writeFile(buffer);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

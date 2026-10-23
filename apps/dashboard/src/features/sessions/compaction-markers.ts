import type { ConversationRow } from "./presentation";

export interface CompactionBoundary {
  row: ConversationRow;
  previousId?: string;
  nextId?: string;
}

/** Capture transcript order before turn grouping or live replacement moves rows. */
export function compactionBoundaries(rows: readonly ConversationRow[]): CompactionBoundary[] {
  const boundaries: CompactionBoundary[] = [];
  let previousId: string | undefined;
  let pending: CompactionBoundary[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind === "compaction") {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const boundary = { row, previousId };
      boundaries.push(boundary); pending.push(boundary);
    } else {
      for (const boundary of pending) boundary.nextId = row.id;
      pending = [];
      previousId = row.id;
    }
  }
  return boundaries;
}

/** Restore markers after normal ordering, including live-only content after a checkpoint. */
export function restoreCompactionRows(rows: ConversationRow[], boundaries: readonly CompactionBoundary[]): ConversationRow[] {
  if (!boundaries.length) return rows;
  const positions = new Map(rows.map((row, index) => [row.id, index]));
  const insertions = new Map<number, ConversationRow[]>();
  for (const { row, previousId, nextId } of boundaries) {
    const previous = previousId === undefined ? undefined : positions.get(previousId);
    const next = nextId === undefined ? undefined : positions.get(nextId);
    // A window containing only markers precedes newly arriving live content.
    const position = previous !== undefined ? previous + 1 : next ?? (previousId === undefined ? 0 : rows.length);
    const bucket = insertions.get(position) ?? [];
    bucket.push(row); insertions.set(position, bucket);
  }
  return rows.flatMap((row, index) => [...(insertions.get(index) ?? []), row]).concat(insertions.get(rows.length) ?? []);
}

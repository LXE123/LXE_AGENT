import { describe, expect, test } from "bun:test";
import { parseTranscriptText } from "../packages/agent/runtime/src/state/transcript";
import { migrateTranscriptText, replayTranscript } from "./migrate-transcripts-v2";

describe("transcript v1 to v2 migration", () => {
  test("migrates full replacements into minimal, replay-equivalent patches", () => {
    const repeated = "old answer ".repeat(500);
    const raw = [
      JSON.stringify({ kind: "message", message: { role: "user", content: "question" }, ts: 1 }),
      JSON.stringify({ kind: "message", message: { role: "assistant", content: repeated }, ts: 2 }),
      JSON.stringify({
        kind: "replacement",
        replacement_kind: "compaction",
        replacement_history: [
          { role: "user", content: "summary" },
          { role: "assistant", content: repeated },
        ],
        compacted_count: 2,
        ts: 3,
      }),
      JSON.stringify({ kind: "message", message: { role: "user", content: "next" }, ts: 4 }),
      "",
    ].join("\n");

    const migrated = migrateTranscriptText(raw, "session-1", "2026-07-15T00:00:00.000Z");
    const sourceEvents = parseTranscriptText(raw);
    const targetEvents = parseTranscriptText(migrated.text);
    expect(targetEvents[0]).toEqual(expect.objectContaining({ kind: "transcript_header", version: 2 }));
    expect(targetEvents.find((event) => event.kind === "context_patch")).toEqual(expect.objectContaining({
      start: 0,
      delete_count: 1,
      insert_messages: [{ role: "user", content: "summary" }],
      patch_kind: "compaction",
    }));
    expect(migrated.text).not.toContain("replacement_history");
    expect(replayTranscript(targetEvents)).toEqual(replayTranscript(sourceEvents));
    expect(migrated.targetBytes).toBeLessThan(migrated.sourceBytes);
    expect(migrateTranscriptText(migrated.text, "session-1")).toEqual(expect.objectContaining({ changed: false }));
  });
});

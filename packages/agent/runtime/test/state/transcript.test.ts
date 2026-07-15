import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTranscriptMigration } from "../../../../../scripts/migrate-transcripts-v2";
import { SqliteRuntimeStore } from "../../src/state/storage";
import {
  applyTranscriptEvent,
  createContextPatchEvent,
  migrateTranscriptText,
  parseTranscriptText,
  replayTranscript,
} from "../../src/state/transcript";
import type { RuntimeMessage } from "../../src/engine/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Transcript v2", () => {
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

  test("retains common context around a patch and rejects invalid ranges", () => {
    const previous: RuntimeMessage[] = [
      { role: "system", content: "stable prefix" },
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "stable suffix" },
    ];
    const next: RuntimeMessage[] = [
      previous[0]!,
      { role: "user", content: "summary" },
      previous[3]!,
    ];
    const patch = createContextPatchEvent(previous, next, "compaction", {}, 1);
    expect(patch).toEqual(expect.objectContaining({ start: 1, delete_count: 2, insert_messages: [next[1]] }));
    expect(applyTranscriptEvent(previous, patch)).toEqual(next);
    expect(() => applyTranscriptEvent([], {
      kind: "context_patch", start: 1, delete_count: 0, insert_messages: [], patch_kind: "repair",
    })).toThrow("outside the current model view");
  });

  test("projects turn context, incrementally catches up, and writes only v2 events", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-transcript-v2-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "s1", source: { platform: "feishu" } });
    await store.appendTurnContext("s1", {
      turn_id: "turn-1",
      job_kind: "turn",
      provider: "kimi_coding",
      model: "kimi-for-coding",
      effort: "high",
      thinking_enabled: true,
      provider_generation: 3,
      context_window_tokens: 256_000,
      ts: 1,
    });
    await store.appendMessage("s1", { role: "user", content: "question" }, "turn_input");
    await store.appendMessage("s1", { role: "assistant", content: "answer" }, "assistant_response");
    await store.replaceMessages("s1", [{ role: "user", content: "summary" }], "compaction", {
      compacted_count: 2,
    });

    const path = join(root, "session_transcripts", "s1.jsonl");
    const events = parseTranscriptText(readFileSync(path, "utf8"));
    expect(events.map((event) => event.kind)).toEqual([
      "transcript_header", "turn_context", "message", "message", "context_patch",
    ]);
    expect(readFileSync(path, "utf8")).not.toContain("replacement_history");
    expect(await store.loadMessages("s1")).toEqual([{ role: "user", content: "summary" }]);
    expect((await store.sessionDetail("s1", { limit: 10 }))?.session).toEqual(expect.objectContaining({
      model: "kimi-for-coding",
      reasoning_effort: "high",
      model_config: {
        provider: "kimi_coding",
        thinking_enabled: true,
        provider_generation: 3,
        context_window_tokens: 256_000,
      },
    }));

    appendFileSync(path, `${JSON.stringify({
      kind: "turn_context",
      turn_id: "turn-2",
      job_kind: "turn",
      provider: "deepseek",
      model: "deepseek-v4",
      effort: "low",
      thinking_enabled: false,
      provider_generation: 4,
      context_window_tokens: 128_000,
      ts: 2,
    })}\n`, "utf8");
    expect((await store.sessionDetail("s1", { limit: 10 }))?.session).toEqual(expect.objectContaining({
      model: "deepseek-v4",
      reasoning_effort: "low",
    }));
    await store.stop();
  });

  test("bounds the replay cache by LRU entry and byte limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-transcript-cache-bounds-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"), {
      replayCacheMaxEntries: 2,
      replayCacheMaxBytes: 10_000,
    });
    await store.start();
    for (const sessionId of ["s1", "s2", "s3"]) {
      await store.ensureSession({ session_id: sessionId, source: {} });
      await store.appendMessage(sessionId, { role: "user", content: sessionId });
      if (sessionId !== "s3") await store.loadMessages(sessionId);
    }
    await store.loadMessages("s1"); // Touch s1 so s2 becomes least recently used.
    await store.loadMessages("s3");
    expect(store.replayCacheStats().entries).toBe(2);
    const before = store.replayCacheStats();
    await store.loadMessages("s1");
    await store.loadMessages("s2");
    const after = store.replayCacheStats();
    expect(after.hits).toBe(before.hits + 1);
    expect(after.misses).toBe(before.misses + 1);
    await store.stop();

    const small = new SqliteRuntimeStore(join(root, "small.sqlite3"), {
      replayCacheMaxEntries: 32,
      replayCacheMaxBytes: 100,
    });
    await small.start();
    await small.ensureSession({ session_id: "large", source: {} });
    await small.appendMessage("large", { role: "user", content: "x".repeat(500) });
    await small.loadMessages("large");
    expect(small.replayCacheStats()).toEqual(expect.objectContaining({ entries: 0, bytes: 0 }));
    await small.stop();
  });

  test("backs up and atomically migrates a stopped temporary repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-transcript-migration-"));
    roots.push(root);
    const databasePath = join(root, "var", "db", "local_agent.sqlite3");
    const store = new SqliteRuntimeStore(databasePath);
    await store.start();
    await store.ensureSession({ session_id: "legacy", source: {} });
    await store.stop();
    const transcriptDirectory = join(root, "var", "db", "session_transcripts");
    mkdirSync(transcriptDirectory, { recursive: true });
    writeFileSync(join(transcriptDirectory, "legacy.jsonl"), [
      JSON.stringify({ kind: "message", message: { role: "user", content: "old" } }),
      JSON.stringify({
        kind: "replacement",
        replacement_kind: "compaction",
        replacement_history: [{ role: "user", content: "summary" }],
        compacted_count: 1,
      }),
      "",
    ].join("\n"), "utf8");

    const migrated = await runTranscriptMigration({ projectRoot: root, migrate: true });
    expect(migrated).toEqual(expect.objectContaining({ changed_files: 1, files: 1 }));
    expect(existsSync(join(root, "var", "backups", "pre-transcript-v2-20260715", "SHA256SUMS.txt"))).toBe(true);
    expect(parseTranscriptText(readFileSync(join(transcriptDirectory, "legacy.jsonl"), "utf8"))[0])
      .toEqual(expect.objectContaining({ kind: "transcript_header", version: 2 }));
    expect(await runTranscriptMigration({ projectRoot: root, migrate: true }))
      .toEqual(expect.objectContaining({ changed_files: 0, files: 1 }));
  });

  test("refuses a write migration while Gateway is running", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-transcript-running-gateway-"));
    roots.push(root);
    const statusDirectory = join(root, "var", "tmp", "gateway");
    mkdirSync(statusDirectory, { recursive: true });
    writeFileSync(join(statusDirectory, "gateway-status.json"), JSON.stringify({ pid: process.pid }), "utf8");
    await expect(runTranscriptMigration({ projectRoot: root, migrate: true }))
      .rejects.toThrow("Gateway is running");
    expect(existsSync(join(root, "var", "backups"))).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTranscriptMigration } from "../../../../../scripts/migrate-transcripts-v2";
import { SqliteRuntimeStore } from "../../src/state/storage";
import {
  applyTranscriptEvent,
  createContextPatchEvent,
  normalizeTranscriptMessage,
  parseTranscriptText,
  scanTranscriptBuffer,
} from "../../src/state/transcript";
import type { RuntimeMessage } from "../../src/engine/types";
import { testWorkspace } from "../workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Transcript v2", () => {
  test("rejects legacy v1 events and tool blocks with a migration hint", () => {
    expect(() => applyTranscriptEvent([], {
      kind: "replacement",
      replacement_kind: "compaction",
      replacement_history: [],
    })).toThrow("scripts/migrate-transcripts-v2.ts");
    expect(() => applyTranscriptEvent([], {
      kind: "compaction",
      replacement_history: [],
    })).toThrow("scripts/migrate-transcripts-v2.ts");
    expect(() => normalizeTranscriptMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "old-1", name: "exec", input: {} }],
    })).toThrow("scripts/migrate-transcripts-v2.ts");
    expect(() => normalizeTranscriptMessage({
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "old-1", content: "done" }],
    })).toThrow("scripts/migrate-transcripts-v2.ts");
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

  test("tolerates a torn unterminated tail but stays strict on terminated lines", () => {
    const encoder = new TextEncoder();
    const complete = `${JSON.stringify({ kind: "message", message: { role: "user", content: "hello" } })}\n`;
    const torn = '{"kind":"message","message":{"role":"assistant","con';

    const scanned = scanTranscriptBuffer(encoder.encode(`${complete}${torn}`), 0, true);
    expect(scanned.lines.map(({ event }) => event.kind)).toEqual(["message"]);
    expect(scanned.completeBytes).toBe(Buffer.byteLength(complete));

    const sealed = `${JSON.stringify({ kind: "message", message: { role: "user", content: "tail" } })}`;
    const withValidTail = scanTranscriptBuffer(encoder.encode(`${complete}${sealed}`), 0, true);
    expect(withValidTail.lines).toHaveLength(2);
    expect(withValidTail.completeBytes).toBe(Buffer.byteLength(`${complete}${sealed}`));

    expect(() => scanTranscriptBuffer(encoder.encode(`${torn}\n${complete}`), 0, true))
      .toThrow("invalid transcript JSON at line 1");
  });

  test("recovers a session whose transcript ends in a torn append", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-transcript-torn-tail-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "torn", source: {} });

    mkdirSync(join(root, "session_transcripts"), { recursive: true });
    const path = join(root, "session_transcripts", "torn.jsonl");
    writeFileSync(path, [
      JSON.stringify({ kind: "transcript_header", version: 2, session_id: "torn", created_at: "x" }),
      JSON.stringify({ kind: "message", message: { role: "user", content: "hello" }, reason: "turn_input", ts: 1 }),
      '{"kind":"message","message":{"role":"assistant","con',
    ].join("\n"), "utf8");

    // Replay drops the torn tail instead of failing the session.
    expect(await store.loadMessages("torn")).toEqual([{ role: "user", content: "hello" }]);

    // The next append truncates the torn tail instead of fusing with it.
    await store.appendMessage("torn", { role: "user", content: "next" }, "turn_input");
    expect(await store.loadMessages("torn")).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "next" },
    ]);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const page = await store.loadTranscriptDisplayPage("torn", { limit: 10 });
    expect(page.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "next" },
    ]);
    await store.stop();
  });

  test("seals a parseable unterminated tail without dropping it", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-transcript-sealed-tail-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "sealed", source: {} });

    mkdirSync(join(root, "session_transcripts"), { recursive: true });
    const path = join(root, "session_transcripts", "sealed.jsonl");
    writeFileSync(path, [
      JSON.stringify({ kind: "transcript_header", version: 2, session_id: "sealed", created_at: "x" }),
      JSON.stringify({ kind: "message", message: { role: "user", content: "hello" }, reason: "turn_input", ts: 1 }),
      JSON.stringify({ kind: "message", message: { role: "assistant", content: "answer" }, reason: "runtime", ts: 2 }),
    ].join("\n"), "utf8");

    expect(await store.loadMessages("sealed")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "answer" },
    ]);
    await store.appendMessage("sealed", { role: "user", content: "next" }, "turn_input");
    expect(await store.loadMessages("sealed")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ]);
    await store.stop();
  });

  test("projects turn context, incrementally catches up, and writes only v2 events", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-transcript-v2-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
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
      await store.ensureSession({ workspace: testWorkspace, session_id: sessionId, source: {} });
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
    await small.ensureSession({ workspace: testWorkspace, session_id: "large", source: {} });
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
    await store.ensureSession({ workspace: testWorkspace, session_id: "legacy", source: {} });
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

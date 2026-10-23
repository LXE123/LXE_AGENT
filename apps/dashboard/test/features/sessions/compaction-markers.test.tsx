import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compactionBoundaries, restoreCompactionRows } from "../../../src/features/sessions/compaction-markers";
import { composeConversationRows, conversationRows, projectConversationHistory, type ConversationRow } from "../../../src/features/sessions/presentation";
import { ConversationDisplayController } from "../../../src/features/sessions/display-controller";
import { processHeaders, visibleProcessRows } from "../../../src/features/sessions/process";
import { UnifiedConversationRow } from "../../../src/features/sessions/view";
import type { SessionDetailPayload, SessionMessage } from "../../../src/api/payloads";
import { compactionHistory, compactionLive, compactionMessage, contentMessage } from "./compaction-fixture-data";

const ids = (rows: readonly ConversationRow[]) => rows.filter(row => !["status", "answer_meta", "artifacts"].includes(row.kind)).map(row => row.id);
const page = (messages: SessionMessage[], session = "s") => ({ session: { session_id: session }, messages, messages_page: {
  group_cursors: messages.map(m => m.display_group_id), oldest_cursor: messages[0]?.display_group_id ?? null,
  newest_cursor: messages.at(-1)?.display_group_id ?? null, total: messages.length, limit: 10, has_previous: false, has_next: false,
} }) as SessionDetailPayload;

test("A → compaction → B keeps its boundary during streaming and history handoff", () => {
  const history = compactionHistory(), projection = projectConversationHistory(history);
  const marker = projection.byId.get("compaction:compact");
  for (let seq = 1; seq < 5; seq++) {
    const rows = composeConversationRows(projection, [compactionLive(seq)], [], true);
    expect(ids(rows)).toEqual(["user:user", "a:0", "compaction:compact", "b:0"]);
    expect(rows.find(row => row.kind === "compaction")).toBe(marker);
  }
  const persisted = [...history, contentMessage("b", "内容 B", 3)];
  expect(ids(conversationRows(persisted, [compactionLive(5)], []))).toEqual(ids(conversationRows(persisted, [], [])));
  expect(ids(conversationRows(persisted, [], []))).toEqual(["user:user", "a:0", "compaction:compact", "b:0"]);
});

test("before, during and after a turn, consecutive events and identical timestamps retain transcript order", () => {
  const messages = [compactionMessage("before"), contentMessage("user", "start"), contentMessage("a", "A"),
    compactionMessage("one"), compactionMessage("two"), contentMessage("b", "B"), compactionMessage("after")]
    .map(message => ({ ...message, created_at: 1, ...(message.turn ? { turn: { ...message.turn, status: "completed" } } : {}) }));
  const rows = conversationRows(messages, [], []);
  expect(ids(rows)).toEqual(["compaction:before", "user:user", "a:0", "compaction:one", "compaction:two", "b:0", "compaction:after"]);
  expect(rows.filter(row => row.kind !== "compaction")).toEqual(conversationRows(messages.filter(message => !message.context_marker), [], []));
  const folded = visibleProcessRows(rows, processHeaders(rows), new Map());
  expect(folded.filter(row => row.kind === "compaction").map(row => row.id)).toEqual(["compaction:before", "compaction:one", "compaction:two", "compaction:after"]);
});

test("multiple checkpoints keep their event order while the same turn streams", () => {
  const history = [...compactionHistory(), compactionMessage("second"), contentMessage("b", "B", 3), compactionMessage("third")];
  const live = compactionLive();
  live.stream!.process_parts.push({ type: "text", part_id: "c:0", sequence: 3, text: "C", presentation: "final", status: "running" });
  const expected = ["user:user", "a:0", "compaction:compact", "compaction:second", "b:0", "compaction:third", "c:0"];
  expect(ids(conversationRows(history, [live], []))).toEqual(expected);
  expect(ids(conversationRows([...history, contentMessage("c", "C", 4)], [], []))).toEqual(expected);
});

test("missing anchors fall back to the next content or the original window edge; duplicates are removed", () => {
  const raw = projectConversationHistory([...compactionHistory(), contentMessage("b", "B")]).rows;
  const boundaries = compactionBoundaries(raw);
  const a = raw.find(row => row.id === "a:0")!, b = raw.find(row => row.id === "b:0")!, marker = boundaries[0]!.row;
  expect(ids(restoreCompactionRows([b], boundaries))).toEqual([marker.id, "b:0"]);
  expect(ids(restoreCompactionRows([a], boundaries))).toEqual(["a:0", marker.id]);
  expect(ids(restoreCompactionRows([b], [{ row: marker, previousId: "outside-left", nextId: "outside-right" }]))).toEqual(["b:0", marker.id]);
  expect(ids(restoreCompactionRows([b], compactionBoundaries([marker])))).toEqual([marker.id, "b:0"]);
  expect(ids(restoreCompactionRows([a, b], compactionBoundaries([a, marker, marker, b])))).toEqual(["a:0", marker.id, "b:0"]);
});

test("paging and switching sessions do not duplicate or leak markers", () => {
  const c = new ConversationDisplayController(); c.select("s");
  c.receiveHistory(page([compactionMessage(), contentMessage("b", "B", 3)]), "latest");
  expect(ids(c.getSnapshot().rows)).toEqual(["compaction:compact", "b:0"]);
  c.setFollowing(false);
  c.receiveHistory(page(compactionHistory()), "older");
  expect(ids(c.getSnapshot().rows)).toEqual(["user:user", "a:0", "compaction:compact", "b:0"]);
  c.receiveHistory(page([compactionMessage(), contentMessage("b", "B", 3)]), "newer");
  expect(c.getSnapshot().rows.filter(row => row.kind === "compaction")).toHaveLength(1);
  c.select("other"); c.receiveHistory(page([contentMessage("other", "Other session")], "other"), "latest");
  expect(c.getSnapshot().rows.some(row => row.kind === "compaction")).toBe(false);
  c.select("s"); c.receiveHistory(page([...compactionHistory(), contentMessage("b", "B", 3)]), "latest");
  c.receiveActivity({ session_id: "s", active: compactionLive(), latest: null, queued: [] });
  expect(ids(c.getSnapshot().rows)).toEqual(["user:user", "a:0", "compaction:compact", "b:0"]);
});

test("tool lifecycle updates preserve the marker next to its stable tool row", () => {
  const history = [contentMessage("user", "start"), { ...contentMessage("call", ""), content: [{ type: "tool_call", id: "read", name: "read", arguments: { path: "file" } }] }, compactionMessage()];
  const projection = projectConversationHistory(history);
  for (const status of ["running", "success"] as const) {
    const turn = compactionLive();
    turn.stream!.process_parts = [{ type: "tool", part_id: "read", sequence: 1, tool_step: { id: "read", name: "read", status } }, turn.stream!.process_parts[1]!] as typeof turn.stream.process_parts;
    expect(ids(composeConversationRows(projection, [turn], []))).toEqual(["user:user", "tool:turn:read", "compaction:compact", "b:0"]);
  }
});

test("ordinary prompt text is not a marker; success markers render a single noninteractive line", () => {
  expect(conversationRows([contentMessage("user", "[上下文已压缩：255 条消息 → 摘要]")], [], [])[0]?.kind).toBe("message");
  for (const count of [255, undefined, -1, NaN, 1.5]) {
    const row = conversationRows([{ ...compactionMessage(), context_marker: { kind: "compaction", compacted_count: count } }], [], [])[0]!;
    const html = renderToStaticMarkup(<UnifiedConversationRow row={row} expanded={false} onToggle={() => {}} onOpenFile={async () => {}} onRevealFile={async () => {}} onOpenAttachment={async () => {}} />);
    expect(html).toContain(count === 255 ? "已压缩上下文 · 255 条消息" : "已压缩上下文</span>");
    expect(html).not.toMatch(/<button|<details|system|上下文已压缩/);
  }
});

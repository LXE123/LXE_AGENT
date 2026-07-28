import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceDir = path.resolve(import.meta.dirname, "../../src");
const view = readFileSync(path.join(sourceDir, "features/sessions/view.tsx"), "utf8");
const main = readFileSync(path.join(sourceDir, "main.tsx"), "utf8");
const queries = readFileSync(path.join(sourceDir, "api/queries.ts"), "utf8");

test("sessions view exposes text conversation controls and IME-safe keyboard behavior", () => {
  assert.match(view, /maxLength=\{8192\}/);
  assert.match(view, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.nativeEvent\.isComposing/);
  assert.match(view, /aria-live="polite"/);
  assert.match(view, /conversation-stop-button/);
  assert.match(view, /conversation-load-earlier/);
  assert.match(view, /session-new-button/);
});

test("optimistic cards retire on transcript watermarks, never on message text", () => {
  assert.match(view, /transcriptCaughtUp\(turn\.user_persisted_at, transcriptFetchedAt\)/);
  assert.match(view, /transcriptCaughtUp\(turn\.settled_at, transcriptFetchedAt\)/);
  // The runtime prefixes system events onto the stored user message, so any
  // text comparison against the transcript silently stops matching.
  assert.doesNotMatch(view, /transcriptContains/);
  assert.match(main, /transcriptFetchedAt=\{sessionDetail\?\.messages_page\.fetched_at/);
});

test("dashboard sends through Main, restores activity, and uses latest-first history paging", () => {
  assert.match(main, /operation: "sessions\.send"/);
  assert.match(main, /operation: "sessions\.stop"/);
  assert.match(main, /onConversationEvent/);
  assert.match(main, /useConversationActivityQuery/);
  assert.match(queries, /operation: "sessions\.activity"/);
  assert.match(queries, /getPreviousPageParam/);
  assert.doesNotMatch(main, /response_route_id/);
});

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

test("the transcript stays scrollable back through history", () => {
  const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
  // End-alignment pushes overflow past the top edge, where scrollable overflow
  // never reaches, which made older messages unreachable. An auto margin pins a
  // short transcript to the bottom without that defect.
  assert.doesNotMatch(styles, /\.conversation-transcript \{[^}]*align-content: end/);
  assert.match(styles, /\.conversation-transcript > :first-child \{\s*margin-top: auto;/);
  // Following every stream delta would drag the reader back down mid-scroll.
  assert.match(view, /if \(!loadingOlderRef\.current && pinnedToBottom\) scrollToLatest\(\)/);
  assert.match(view, /conversation-jump-latest/);
});

test("the conversation takes its height from the panel, not a guess at the chrome", () => {
  const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
  // Guessing the surrounding chrome left the columns ending at different
  // heights and pushed the composer under the fixed runtime-status trigger.
  assert.doesNotMatch(styles, /\.conversation-view \{[^}]*height: calc\(100vh/);
  assert.doesNotMatch(styles, /\.sessions-split-index \{[^}]*max-height: calc\(100vh/);
  assert.match(styles, /\.sessions-split \{[^}]*align-items: stretch/s);
  assert.match(main, /"content-panel content-panel-fill"/);
});

test("tool files reach the conversation and open through Main", () => {
  assert.match(view, /turn-file-chip/);
  assert.match(view, /turn\.files\.length/);
  assert.match(main, /operation: "sessions\.file\.open"/);
  // The OS failure text is what surfaces, not a stand-in message.
  assert.match(main, /if \(!result\.opened\) throw new Error\(result\.error\)/);
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

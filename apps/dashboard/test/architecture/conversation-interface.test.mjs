import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceDir = path.resolve(import.meta.dirname, "../../src");
const view = readFileSync(path.join(sourceDir, "features/sessions/view.tsx"), "utf8");
const main = readFileSync(path.join(sourceDir, "main.tsx"), "utf8");
const queries = readFileSync(path.join(sourceDir, "api/queries.ts"), "utf8");
const conversation = readFileSync(path.join(sourceDir, "features/sessions/conversation.ts"), "utf8");

test("sessions view exposes text conversation controls and IME-safe keyboard behavior", () => {
  assert.match(view, /maxLength=\{8192\}/);
  assert.match(view, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.nativeEvent\.isComposing/);
  assert.match(view, /aria-live="polite"/);
  assert.match(view, /conversation-stop-button/);
  assert.match(view, /conversation-load-earlier/);
  assert.match(view, /session-new-button/);
  assert.match(view, /selectConversationFiles/);
  assert.match(view, /stageDroppedConversationFiles/);
  assert.match(main, /attachment_ids: attachments\.map/);
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
  assert.doesNotMatch(styles, /\.conversation-transcript \{[^}]*align-content: end/);
  assert.doesNotMatch(styles, /\.conversation-transcript > :first-child \{\s*margin-top: auto;/);
  assert.match(styles, /\.conversation-transcript \{[^}]*scrollbar-gutter:\s*stable[^}]*scrollbar-color:\s*rgba\(122, 112, 101, 0\.22\) transparent[^}]*scrollbar-width:\s*thin/s);
  assert.match(styles, /\.conversation-transcript::-webkit-scrollbar-track,[\s\S]*?background:\s*transparent/s);
  assert.match(styles, /\.conversation-transcript::-webkit-scrollbar-thumb \{[^}]*border:\s*3px solid transparent[^}]*border-radius:\s*999px/s);
  assert.match(view, /new IntersectionObserver/);
  assert.match(view, /rootMargin: "120px 0px 0px 0px"/);
  assert.match(view, /previousHeight[\s\S]*?transcript\.scrollHeight - previousHeight/);
  // Following every stream delta would drag the reader back down mid-scroll.
  assert.match(view, /if \(!loadingOlderRef\.current && pinnedToBottom\) scrollToLatest\(\)/);
  assert.match(view, /conversation-jump-latest/);
});

test("the focused conversation takes the full panel without a second session column", () => {
  const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
  // The old nested session panel competed with both the transcript and the
  // composer for width and height. The application sidebar owns that list now.
  assert.doesNotMatch(styles, /\.conversation-view \{[^}]*height: calc\(100vh/);
  assert.doesNotMatch(styles, /\.sessions-split/);
  assert.doesNotMatch(main, /sessions-split/);
  assert.match(styles, /\.sessions-conversation-shell \{[^}]*height:\s*100%[^}]*min-height:\s*0/s);
  assert.match(main, /"content-panel content-panel-fill"/);
  assert.doesNotMatch(view, /conversation-header-sidebar-toggle/);
  assert.match(styles, /\.conversation-header \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s);
});

test("conversation messages and composer share the same focused reading axis", () => {
  const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
  assert.match(styles, /\.conversation-feed \{[^}]*width:\s*min\(820px,/s);
  assert.match(styles, /\.conversation-composer \{[^}]*width:\s*min\(820px,/s);
  assert.match(styles, /\.conversation-feed \.message-card\.role-assistant,[\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.conversation-feed \.message-card\.role-user \{[^}]*max-width:\s*min\(620px, 78%\)[^}]*border:\s*1px solid var\(--border\)[^}]*background:\s*var\(--surface-subtle\)/s);
  assert.match(styles, /\.conversation-feed \.message-card\.role-user \.message-markdown > :last-child \{[^}]*margin-bottom:\s*0/s);
  assert.match(view, /const showCharacterCount = text\.length >= Math\.floor\(8192 \* 0\.75\)/);
  assert.match(view, /showRoleBadge = role !== "assistant" && role !== "user"/);
});

test("live turns expose one truthful phase and locally ticking elapsed time", () => {
  const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
  assert.match(view, /case "preparing_context": return t\.conversation\.preparingContext/);
  assert.match(view, /case "waiting_model": return t\.conversation\.waitingModel/);
  assert.match(view, /case "thinking": return t\.conversation\.thinking/);
  assert.match(view, /case "running_tool": return t\.conversation\.runningTool/);
  assert.match(view, /case "generating_answer": return t\.conversation\.generatingAnswer/);
  assert.match(view, /if \(!stream\) return t\.conversation\.preparingContext/);
  assert.match(view, /turn\.started_at > 0/);
  assert.match(view, /window\.setInterval\(\(\) => setClock\(Date\.now\(\)\), 250\)/);
  assert.match(view, /elapsedMs >= 1_000/);
  assert.match(styles, /\.live-progress-status \{[^}]*width:\s*min\(100%, var\(--assistant-content-width\)\)/s);
  assert.doesNotMatch(view, /conversation-live-status|live-response-status|live-response-meta|toolPending/);
  assert.doesNotMatch(styles, /\.conversation-live-status|\.live-response-status|\.live-response-meta/);
});

test("details and runtime status overlay the conversation without moving the reading axis", () => {
  const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
  assert.match(view, /useDialogFocus<HTMLElement>\(sessionInfoOpen, closeSessionInfo\)/);
  assert.match(view, /className="session-detail-panel"[\s\S]*?role="dialog"/);
  assert.match(styles, /\.session-detail-panel \{[^}]*position:\s*absolute[^}]*width:\s*min\(380px,/s);
  assert.match(main, /runtime-status-host sessions-focus/);
  assert.match(styles, /@media \(max-width:\s*1060px\)[\s\S]*?\.sessions-focus \.runtime-status-floating \{[^}]*bottom:\s*114px/s);
});

test("tool files reach the conversation and open through Main", () => {
  assert.match(view, /turn-file-card/);
  assert.match(view, /item\.type === "artifact_group"/);
  assert.match(conversation, /function appendArtifactGroups/);
  assert.match(conversation, /artifact\.turn_id/);
  assert.doesNotMatch(view, /toolGroupArtifacts\(group\.messages\)/);
  assert.match(view, /file\.artifact_id/);
  assert.match(main, /operation: "sessions\.file\.open"/);
  assert.match(main, /artifact_id: artifactId/);
  assert.doesNotMatch(main, /sessions\.file\.open"[\s\S]{0,160}path/);
  // The OS failure text is what surfaces, not a stand-in message.
  assert.match(main, /if \(!result\.opened\) throw new Error\(result\.error\)/);
});

test("input attachments expose opaque chips and open through Main", () => {
  assert.match(view, /InputAttachmentList/);
  assert.match(view, /message\.attachments/);
  assert.match(main, /operation: "sessions\.attachment\.open"/);
  assert.match(main, /attachment_id: attachmentId/);
  assert.doesNotMatch(main, /sessions\.attachment\.open"[\s\S]{0,160}path/);
});

test("dashboard sends through Main, restores activity, and merges cursor history", () => {
  assert.match(main, /operation: "sessions\.send"/);
  assert.match(main, /operation: "sessions\.stop"/);
  assert.match(main, /onConversationEvent/);
  assert.match(main, /useConversationActivityQuery/);
  assert.match(queries, /operation: "sessions\.activity"/);
  assert.match(queries, /message_before: before/);
  assert.match(queries, /mergeLatestConversationWindow/);
  assert.match(queries, /prependConversationWindow/);
  assert.doesNotMatch(main, /response_route_id/);
});

test("thinking, tool activity and replies each read at one level", () => {
  // The group header leads with which tools ran; a lone call shows what it ran
  // rather than a step count that always reads the same.
  assert.match(view, /<div className="tool-turn-title">\{stats\.title\}<\/div>/);
  assert.match(view, /stats\.detailIsArgument \? "tool-turn-subtitle argument" : "tool-turn-subtitle"/);
  assert.match(view, /const single = callCount === 1 \? operations\[0\] : undefined/);
  // A group that failed opens itself; everything else stays collapsed until
  // the reader asks for it.
  assert.match(view, /toolGroupOverrides\.get\(group\.key\) \?\? hasToolError\(group\.messages\)/);
  // Thinking keeps its own bare row and tool groups sit beside a reply rather
  // than inside it, so neither ever appears at two different nesting levels.
  assert.match(view, /role === "assistant" && !hasReaderFacingText\(message\)/);
  assert.match(view, /className="process-step"/);
  assert.doesNotMatch(view, /assistant-tool-stack/);
  assert.match(conversation, /function splitAssistantThinking/);
  // Expanded, the group is one line per operation, not a dump of each message.
  assert.match(view, /className="tool-op-list"/);
  assert.match(view, /className="tool-op-argument"/);
});

test("a tool reads the same live as it does in history", () => {
  const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
  // Live steps carry a curated title as well as the name the model called; a
  // tool that changes label when it scrolls into history reads as two tools.
  assert.match(view, /<span className="live-tool-name">\{step\.name\}<\/span>/);
  assert.doesNotMatch(view, /<span>\{step\.title\}<\/span>/);
  // One unbroken command must shrink inside its row instead of turning the
  // transcript itself into a horizontal scroller.
  assert.match(view, /<small className="live-tool-detail">\{step\.detail\}<\/small>/);
  assert.match(styles, /\.conversation-transcript \{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.live-tool-detail \{[^}]*flex:\s*1 1 0[^}]*color:/s);
  assert.match(styles, /\.live-tool-name,\n\.live-tool-detail \{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  // Beside a growing textarea the composer buttons must not be squeezed until
  // their label breaks one character per line.
  assert.match(styles, /\.conversation-send-button,\n\.conversation-stop-button,\n\.conversation-attach-button \{[^}]*flex: 0 0 auto/);
  assert.match(styles, /\.conversation-send-button,\n\.conversation-stop-button,\n\.conversation-attach-button \{[^}]*white-space: nowrap/);
});

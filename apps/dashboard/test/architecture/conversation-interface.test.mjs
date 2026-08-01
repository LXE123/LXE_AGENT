import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceDir = path.resolve(import.meta.dirname, "../../src");
const view = readFileSync(path.join(sourceDir, "features/sessions/view.tsx"), "utf8");
const main = readFileSync(path.join(sourceDir, "main.tsx"), "utf8");
const queries = readFileSync(path.join(sourceDir, "api/queries.ts"), "utf8");
const conversation = readFileSync(path.join(sourceDir, "features/sessions/conversation.ts"), "utf8");
const markdown = readFileSync(path.join(sourceDir, "shared/ui/markdown.tsx"), "utf8");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8").replaceAll("\r\n", "\n");

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

test("the composer switches the shared model before the next turn", () => {
  assert.match(view, /function ConversationModelPicker/);
  assert.match(view, /aria-haspopup="menu"/);
  assert.match(view, /role="menuitemradio"/);
  assert.match(view, /event\.key !== "Escape"/);
  assert.match(view, /current\?\.provider !== provider \|\| current\.model !== model/);
  assert.match(view, /!runtimeReady \|\| modelSaving \|\| thinkingSaving \|\| sending/);
  assert.match(main, /activeSection === "sessions" \|\| \(capabilitiesOpen && capabilityView === "models"\)/);
  assert.match(main, /onModelChange=\{setCurrentModel\}/);
  assert.doesNotMatch(view, /t\.models\.moreModels|onOpenModels/);
  assert.match(styles, /\.conversation-model-menu \{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(100% \+ 9px\)/s);
});

test("the composer edits thinking effort using the shared next-turn preference", () => {
  assert.match(view, /function ConversationThinkingPicker/);
  assert.match(view, /current\?\.thinking_state\?\.editable && levels\.length > 1/);
  assert.match(view, /modelThinkingLevelLabel\(current, level\)/);
  assert.match(view, /className="conversation-thinking-levels"/);
  assert.match(view, /onThinkingLevelChange/);
  assert.match(main, /thinkingSaving=\{thinkingMutation\.isPending\}/);
  assert.match(main, /onThinkingLevelChange=\{setCurrentThinkingLevel\}/);
  assert.match(styles, /\.conversation-thinking-menu \{[^}]*bottom:\s*calc\(100% \+ 9px\)/s);
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
  assert.doesNotMatch(styles, /\.conversation-transcript \{[^}]*align-content: end/);
  assert.doesNotMatch(styles, /\.conversation-transcript > :first-child \{\s*margin-top: auto;/);
  assert.match(styles, /\.conversation-transcript \{[^}]*scrollbar-gutter:\s*stable[^}]*scrollbar-color:\s*rgba\(122, 112, 101, 0\.22\) transparent[^}]*scrollbar-width:\s*thin/s);
  assert.doesNotMatch(styles, /\.message-markdown tbody tr:hover/);
  assert.match(styles, /\.conversation-transcript::-webkit-scrollbar-track,[\s\S]*?background:\s*transparent/s);
  assert.match(styles, /\.conversation-transcript::-webkit-scrollbar-thumb \{[^}]*border:\s*3px solid transparent[^}]*border-radius:\s*999px/s);
  assert.match(view, /new IntersectionObserver/);
  assert.match(view, /rootMargin: "120px 0px 0px 0px"/);
  assert.match(view, /previousHeight[\s\S]*?transcript\.scrollHeight - previousHeight/);
  // Following every stream delta would drag the reader back down mid-scroll.
  assert.match(view, /if \(loadingOlderRef\.current \|\| !pinnedToBottom\) return;/);
  assert.match(view, /requestAnimationFrame\(scrollToLatest\)/);
  assert.match(view, /conversation-jump-latest/);
});

test("the focused conversation takes the full panel without a second session column", () => {
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
  // Feed, composer and assistant content all track the one variable, so the
  // axis cannot drift apart the way a hard-coded width per rule allowed.
  assert.match(styles, /\.conversation-feed \{[^}]*width:\s*min\(var\(--assistant-content-width\),/s);
  assert.match(styles, /\.conversation-feed \.message-text,\s*\.conversation-feed \.message-markdown \{[^}]*font-size:\s*0\.875rem;[^}]*font-weight:\s*370;[^}]*line-height:\s*1\.7;/s);
  assert.match(styles, /\.conversation-composer \{[^}]*width:\s*min\(var\(--assistant-content-width\),/s);
  assert.match(styles, /\.conversation-compose-box \{[^}]*border:\s*0\.5px solid var\(--border-strong\);[^}]*box-shadow:\s*var\(--shadow-card\);/s);
  assert.match(styles, /\.conversation-feed \.message-card\.role-assistant \{[^}]*background:\s*transparent/s);
  // The user bubble shares the conversation's neutral muted fill instead of
  // turning into a white card against the light page plane.
  assert.match(styles, /\.conversation-feed \.message-card\.role-user \{[^}]*max-width:\s*min\(620px, 78%\)[^}]*margin:\s*22px 0 1px;[^}]*border:\s*1px solid var\(--border\)[^}]*background:\s*var\(--conversation-muted-fill\)/s);
  assert.match(styles, /\.sessions-focus \.content-panel-fill \{[^}]*background:\s*var\(--bg\)/s);
  assert.match(styles, /\.conversation-feed \.message-card\.role-user \.message-markdown > :last-child \{[^}]*margin-bottom:\s*0/s);
  assert.match(view, /const showCharacterCount = text\.length >= Math\.floor\(8192 \* 0\.75\)/);
  assert.match(view, /showRoleBadge = role !== "assistant" && role !== "user"/);
});

test("conversation markdown tables use separated cells instead of a framed grid", () => {
  assert.match(styles, /\.message-markdown \.markdown-table-scroll \{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.message-markdown table \{[^}]*border-collapse:\s*separate;[^}]*border-spacing:\s*3px;/s);
  // Cells and user bubbles share one deliberately neutral grey so neither can
  // drift cool or warm independently of the other.
  assert.match(styles, /\.message-markdown th,\s*\.message-markdown td \{[^}]*border:\s*0;[^}]*border-radius:\s*6px;[^}]*background:\s*var\(--conversation-muted-fill\);/s);
  assert.doesNotMatch(styles, /\.message-markdown th,\s*\.message-markdown td \{[^}]*background:\s*var\(--surface-subtle\);/s);
  assert.match(styles, /\.message-markdown th \{[^}]*background:\s*var\(--table-header-fill\);/s);
  assert.doesNotMatch(styles, /\.message-markdown (?:th|td|tr:last-child td) \{[^}]*border-bottom:/s);
});

test("conversation quotes and code keep structure without tinted panels", () => {
  assert.match(styles, /\.message-markdown blockquote \{[^}]*border-left:\s*2px solid var\(--accent-muted\);[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.message-markdown pre \{[^}]*border:\s*1px solid var\(--border\);[^}]*background:\s*transparent;/s);
  assert.match(styles, /--inline-code-fill:\s*var\(--table-header-fill\);/);
  assert.match(styles, /\.message-markdown code \{[^}]*background:\s*var\(--inline-code-fill\);[^}]*color:\s*var\(--inline-code-text\);/s);
  assert.match(styles, /\.message-markdown pre code \{[^}]*background:\s*transparent;[^}]*color:\s*inherit;/s);
});

test("conversation fenced code reaches the syntax highlighter", () => {
  assert.match(markdown, /import \{ CodeBlock \} from "\.\/code-block"/);
  assert.match(markdown, /const language = CODE_LANGUAGE_PATTERN\.exec\(className\)\?\.\[1\] \|\| ""/);
  assert.match(markdown, /return <CodeBlock autoDetect=\{!language\} code=\{code\} language=\{language\} \/>/);
  assert.match(styles, /\.hljs-keyword,[^}]*color:\s*var\(--accent-strong\)/s);
  assert.match(styles, /\.hljs-string,[^}]*color:\s*var\(--rate-good\)/s);
});

test("live turns expose one truthful phase and locally ticking elapsed time", () => {
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

test("the file list spends its width on what differs between the files", () => {
  // The extension is stated once per row by the marker, so repeating it in the
  // name only cost the tail - which is the part that differs between files.
  assert.match(view, /className="turn-file-name" title=\{file\.name\}>\{fileDisplayName\(file\.name\)\}/);
  assert.match(view, /function fileDisplayName/);
  // The marker stays on every row: it is the anchor the eye lands on, so it is
  // made quiet rather than removed. A filled accent pill outshouted the name.
  assert.match(view, /<span aria-hidden="true" className="turn-file-extension">\{extension\}<\/span>/);
  assert.doesNotMatch(styles, /\.turn-file-extension \{[^}]*background:/s);
  assert.match(styles, /\.turn-file-extension \{[^}]*color:\s*var\(--muted-light\)/s);
  // Cards are --surface on the --bg plane like the rest of the transcript;
  // --surface-subtle sits too close to the background to read as a card.
  assert.match(styles, /\.turn-file-card \{[^}]*background:\s*var\(--surface\)[^}]*text-align:\s*left/s);
  assert.match(styles, /\.turn-file-card \{[^}]*border:\s*1px solid var\(--border\)/s);
  // Two columns only while both can hold a name; otherwise one full-width row
  // beats two clipped ones.
  assert.match(styles, /\.turn-file-grid \{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(330px, 100%\), 1fr\)\)/s);
  // The arrow is decoration on a card that is entirely clickable, but progress
  // is feedback and has to stay visible.
  assert.match(styles, /\.turn-file-action \{[^}]*opacity:\s*0/s);
  assert.match(styles, /\.turn-file-action\.conversation-spinner \{[^}]*opacity:\s*1/s);
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
  assert.match(main, /onConversationStreamEvent/);
  assert.match(main, /requestAnimationFrame\(flush\)/);
  assert.match(main, /applyDesktopStreamBatch\(activity, batch\)/);
  assert.match(main, /setQueryData\(\s*dashboardQueryKeys\.sessions\.activity\(activity\.session_id\)/s);
  assert.match(main, /useConversationActivityQuery/);
  assert.doesNotMatch(main, /conversationActivities|setConversationActivities/);
  assert.doesNotMatch(main, /if \(section === "sessions"\) \{\s*setSelectedSessionId\(""\)/s);
  assert.match(queries, /operation: "sessions\.activity"/);
  assert.match(queries, /message_before: before/);
  assert.match(queries, /mergeLatestConversationWindow/);
  assert.match(queries, /prependConversationWindow/);
  assert.doesNotMatch(main, /response_route_id/);
});

test("thinking and tools fold into one response process while the final answer stays outside", () => {
  assert.match(view, /<span className="tool-turn-title">\{summary\.text/);
  assert.match(view, /summarizeToolOperations\(operations, toolBatchLabels\(t\)\)/);
  assert.match(conversation, /previous\?\.type === "tool_group"/);
  assert.match(conversation, /type: "response_group"/);
  assert.match(conversation, /finalMessage/);
  assert.match(view, /className="response-process-summary"/);
  assert.match(view, /response-final-answer/);
  assert.match(view, /className="process-thinking-text"/);
  assert.doesNotMatch(view, /stream\.thinking \? <ThinkingBlock/);
  assert.match(view, /liveOwnedTurnIds/);
  assert.match(view, /item\.type === "response_group" && item\.group\.turn\?\.turn_id/);
  assert.doesNotMatch(view, /similarity|startsWith\(stream\.content\)/);
  assert.doesNotMatch(view, /assistant-tool-stack/);
  assert.match(view, /className="tool-op-list"/);
  assert.match(view, /className="tool-op-argument"/);
  assert.match(view, /function ProcessToolGroup[\s\S]*?useState\(false\)/);
  assert.doesNotMatch(view, /openOperations\.get\(operation\.key\) \?\? operation\.status === "error"/);
  assert.match(view, /expandable: hasLiveToolOperationDetails\(step\)/);
  assert.match(view, /<LiveProcessBody parts=\{visibleProcessParts\}/);
  assert.match(view, /function liveTimeline\(parts: TurnProcessPart\[\]\)/);
  assert.match(conversation, /previous\?\.type === "tool_group"/);
  assert.match(conversation, /part\.presentation === "final"/);
  assert.doesNotMatch(view, /stream\?\.tool_steps\.length/);
  assert.match(view, /disabled=\{!expandable\}/);
  assert.doesNotMatch(view, /live-tool-operation-detail/);
});

test("reader messages expose only copy and timestamp metadata", () => {
  assert.match(view, /function MessageMeta/);
  assert.match(view, /className="message-meta-copy"/);
  assert.match(view, /formatMessageTime\(createdAt\)/);
  assert.match(view, /readerFacingMessageText\(group\.finalMessage\)/);
  assert.match(view, /role === "user" \? time : copyButton/);
  assert.match(styles, /\.message-meta-copy\s*\{[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.message-with-meta\.role-user\s*\{[^}]*align-items:\s*flex-end;/s);
  assert.doesNotMatch(view, /message-meta[^\n]*(?:ThumbsUp|ThumbsDown|Maximize)/);
});

test("user message metadata is smaller and revealed on hover", () => {
  assert.match(styles, /\.message-meta\.role-user\s*\{[^}]*min-height:\s*25px;[^}]*gap:\s*6px;[^}]*font-size:\s*0\.6875rem;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
  assert.match(styles, /\.message-with-meta\.role-user:hover \.message-meta,\s*\.message-with-meta\.role-user:focus-within \.message-meta\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s);
  assert.match(styles, /\.message-meta\.role-user \.message-meta-copy\s*\{[^}]*width:\s*25px;[^}]*height:\s*25px;/s);
  assert.match(styles, /@media \(hover:\s*none\)\s*\{\s*\.message-meta\.role-user\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s);
});

test("assistant message metadata is smaller and sits closer to the response", () => {
  assert.match(styles, /\.message-meta\.role-assistant\s*\{[^}]*min-height:\s*25px;[^}]*gap:\s*6px;[^}]*margin-top:\s*2px;[^}]*font-size:\s*0\.6875rem;/s);
  assert.match(styles, /\.message-meta\.role-assistant \.message-meta-copy\s*\{[^}]*width:\s*25px;[^}]*height:\s*25px;/s);
  assert.match(styles, /\.message-meta\.role-assistant \.message-meta-copy svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s);
});

test("the in-flight final answer leaves the process panel before the turn settles", () => {
  assert.match(view, /liveAnswerProjection\(processParts, stream\?\.display_metrics\.phase\)/);
  assert.match(view, /processParts\.filter\(\(part\) => !answerPartIds\.has\(part\.part_id\)\)/);
  assert.match(view, /<LiveProcessBody parts=\{visibleProcessParts\}/);
  assert.match(view, /<MessageMarkdown streaming=\{answer\.streaming\} text=\{answer\.text\}/);
  assert.match(conversation, /phase === "generating_answer"/);
  assert.match(conversation, /part\.sequence > latestToolSequence/);
});

test("a tool reads the same live as it does in history", () => {
  // Both sources use the raw name and the same deterministic presentation;
  // the curated live title cannot make the wording jump at persistence time.
  assert.match(view, /toolOperationPresentation\(name, argument\)/);
  assert.match(view, /const name = String\(step\.name \|\| "tool"\)/);
  assert.doesNotMatch(view, /<span>\{step\.title\}<\/span>/);
  // One unbroken command must shrink inside its row instead of turning the
  // transcript itself into a horizontal scroller.
  assert.match(view, /className="tool-op-argument"/);
  assert.match(styles, /\.conversation-transcript \{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.tool-op-argument \{[^}]*overflow:\s*hidden[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  // Beside a growing textarea the composer buttons must not be squeezed until
  // their label breaks one character per line.
  assert.match(styles, /\.conversation-send-button,\n\.conversation-stop-button,\n\.conversation-attach-button \{[^}]*flex: 0 0 auto/);
  assert.match(styles, /\.conversation-send-button,\n\.conversation-stop-button,\n\.conversation-attach-button \{[^}]*white-space: nowrap/);
});

test("expanded tool details use dividers instead of stacked tinted surfaces", () => {
  assert.match(view, /const longScalars = scalars\.filter/);
  assert.match(view, /className="tool-call-long-value"/);
  assert.match(styles, /\.tool-turn-group\.embedded\.single \{[^}]*border:\s*0/s);
  assert.match(styles, /\.tool-op-body \{[^}]*border-top:\s*1px solid var\(--border\)[^}]*background:\s*transparent/s);
  assert.match(styles, /\.message-block\.tool-block \{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.message-block\.result-block \{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.code-block\.tool-result-full \{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.code-block > code \{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.tool-call-long-value \{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\)/s);
});

test("nothing pads the header away from the transcript", () => {
  // The conversation element also carries .session-detail, a grid container
  // with gap: 12px. Switching display to flex keeps that gap, which put a band
  // between the header and the first message that no rule asked for.
  assert.match(styles, /\.conversation-view \{[^}]*gap:\s*0;/s);
  assert.match(styles, /\.session-detail \{[^}]*gap:\s*12px;/s);
  // min-height above the row's own content is pure padding: a 30px button
  // inside 7px of padding needs 44.
  assert.match(styles, /\.conversation-header \{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.session-detail-toggle \{[^}]*min-height:\s*30px;/s);
});

test("the transcript dissolves under the header instead of being cut by a rule", () => {
  // A border has to be drawn because content is sliced at a hard edge. Fading
  // it removes the thing the border was there to explain, which is why the
  // header carries no rule of its own.
  assert.match(styles, /\.conversation-header \{[^}]*border-bottom:\s*0;/s);
  assert.doesNotMatch(styles, /\.conversation-header \{[^}]*border-bottom:\s*1px/s);
  // Mirrors the composer dock's fade at the other end, and starts from the
  // plane's own colour so the two never drift apart.
  assert.match(
    styles,
    /\.conversation-scroll-area::before \{[^}]*background:\s*linear-gradient\(to bottom, var\(--bg\)/s,
  );
  // Both edges of the scroll container do the cutting, so both need covering.
  // The dock's own gradient sits below the container and never reached the
  // bottom edge that slices the text.
  assert.match(
    styles,
    /\.conversation-scroll-area::after \{[^}]*background:\s*linear-gradient\(to top, var\(--bg\)/s,
  );
  assert.match(styles, /\.conversation-scroll-area::before,\n\.conversation-scroll-area::after \{[^}]*pointer-events:\s*none;/s);
});

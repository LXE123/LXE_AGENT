import { expect, test } from "bun:test";
import { appendComposerDraftPrompt, prepareDraftMove } from "../../../src/features/sessions/composer-draft";
import { composeQuotedMessage, readQuotes, removeQuotes, writeQuotes } from "../../../src/features/sessions/composer-quotes";
import { conversationAttachments, moveConversationAttachments } from "../../../src/features/sessions/attachment-draft";
const callbacks = { changed() {}, error() {}, discard: async () => {}, tooMany: () => "Too many screenshots" };
test("workspace switching merges text and attachments without overwriting or discarding registrations", () => {
  const data = new Map<string, string>(); const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  appendComposerDraftPrompt(storage, "move-a", "source"); appendComposerDraftPrompt(storage, "move-b", "target");
  const from = conversationAttachments("move-a", callbacks), to = conversationAttachments("move-b", callbacks);
  from.items = [{ attachment_id: "a", name: "a", media_type: "text/plain", size_bytes: 1 }];
  to.items = [{ attachment_id: "b", name: "b", media_type: "text/plain", size_bytes: 1 }];
  const move = prepareDraftMove("move-a", "move-b"); moveConversationAttachments("move-a", "move-b"); move();
  expect(to.items.map(item => item.attachment_id)).toEqual(["b", "a"]); expect(from.items).toEqual([]);
  appendComposerDraftPrompt({ getItem: () => null, setItem: (_key, text) => expect(text).toBe("target\n\nsource\n\nmore") }, "move-b", "more");
});
test("oversized or pending draft moves leave both drafts intact", () => {
  const storage = { getItem: () => null, setItem() {} };
  appendComposerDraftPrompt(storage, "large-a", "x".repeat(8190)); appendComposerDraftPrompt(storage, "large-b", "kept");
  expect(() => prepareDraftMove("large-a", "large-b")).toThrow("8192");
  const from = conversationAttachments("pending-a", callbacks); from.pending = 1;
  expect(() => moveConversationAttachments("pending-a", "pending-b")).toThrow("finish loading");
});

test("confirmed quotes move with their draft and only submitted quotes clear on acknowledgement", () => {
  const one = { id: "1", text: "first\nline", comment: "" };
  const two = { id: "2", text: "second", comment: "why?" };
  writeQuotes("quote-target", [one]);
  writeQuotes("quote-source", [two]);
  prepareDraftMove("quote-source", "quote-target")();
  expect(readQuotes("quote-source")).toEqual([]);
  expect(composeQuotedMessage(readQuotes("quote-target"), "draft")).toBe("> first\n> line\n\n> second\n\nwhy?\n\ndraft");
  removeQuotes("quote-target", ["1"]);
  expect(readQuotes("quote-target")).toEqual([two]);
  writeQuotes("quote-source", [{ ...one, text: "x".repeat(8190) }]);
  expect(() => prepareDraftMove("quote-source", "quote-target")).toThrow("8192");
  expect(readQuotes("quote-source")).toHaveLength(1);
  expect(readQuotes("quote-target")).toEqual([two]);
});

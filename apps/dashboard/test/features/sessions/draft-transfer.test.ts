import { expect, test } from "bun:test";
import { appendComposerDraftPrompt, prepareDraftMove } from "../../../src/features/sessions/composer-draft";
import { composeQuotedMessage } from "../../../src/features/sessions/message-quotes";
import { readQuotes, removeQuotes, writeQuotes } from "../../../src/features/sessions/composer-quotes";
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
test("long drafts merge while pending attachments still block moves", () => {
  const storage = { getItem: () => null, setItem() {} };
  appendComposerDraftPrompt(storage, "large-a", "x".repeat(9998)); appendComposerDraftPrompt(storage, "large-b", "kept");
  prepareDraftMove("large-a", "large-b")();
  appendComposerDraftPrompt({ getItem: () => null, setItem: (_, text) => expect(text).toBe("kept\n\n" + "x".repeat(9998) + "\n\nmore") }, "large-b", "more");
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
  expect(composeQuotedMessage(readQuotes("quote-target"), "draft")).toBe("<!-- reply 1 -->\n> second\n\nwhy?\n\n\n<!-- attach -->\n> first\n> line\n\ndraft");
  removeQuotes("quote-target", ["1"]);
  expect(readQuotes("quote-target")).toEqual([two]);
  writeQuotes("quote-source", [{ ...one, text: "x".repeat(9998) }]);
  prepareDraftMove("quote-source", "quote-target")();
  expect(readQuotes("quote-source")).toHaveLength(0);
  expect(readQuotes("quote-target")).toEqual([two, { ...one, text: "x".repeat(9998) }]);
});

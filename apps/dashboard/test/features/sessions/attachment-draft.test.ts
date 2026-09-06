import { describe, expect, test } from "bun:test";
import { ConversationAttachmentDraft } from "../../../src/features/sessions/attachment-draft";
const item = (id: string) => ({ attachment_id: id, name: id, media_type: "image/png", size_bytes: 1 });
function bench() {
  const removed: string[][] = []; const errors: string[] = [];
  const draft = new ConversationAttachmentDraft({ changed() {}, error: (s) => errors.push(s), discard: async (ids) => { removed.push(ids); }, tooMany: () => "five maximum" });
  return { draft, removed, errors };
}
describe("attachment draft", () => {
  test("serializes intake and blocks sending until every intake settles", async () => {
    const { draft } = bench(); let finish!: (value: ReturnType<typeof item>[]) => void;
    const first = draft.stage(() => new Promise((resolve) => { finish = resolve; }));
    const second = draft.stage(async () => [item("second")]);
    expect(draft.pending).toBe(2); await Promise.resolve(); finish([item("first")]);
    await Promise.all([first, second]); expect(draft.items.map((i) => i.name)).toEqual(["first", "second"]); expect(draft.pending).toBe(0);
  });
  test("captures paste contents immediately but discards old results after switching conversation", async () => {
    const { draft, removed } = bench(); let finish!: (value: ReturnType<typeof item>[]) => void;
    const first = draft.stage(() => new Promise((resolve) => { finish = resolve; }));
    const second = draft.stage(async () => [item("second-old")]);
    await Promise.resolve(); draft.reset(); finish([item("old")]); await Promise.all([first, second]);
    expect(removed).toEqual([["old"], ["second-old"]]); expect(draft.items).toEqual([]); expect(draft.pending).toBe(0);
  });
  test("deduplicates paths while releasing only the new registration", async () => {
    const { draft, removed } = bench();
    await draft.stage(async () => [{ ...item("first"), reference_key: "same-path" }]);
    await draft.stage(async () => [{ ...item("second"), reference_key: "same-path" }]);
    expect(draft.items.map((item) => item.attachment_id)).toEqual(["first"]);
    expect(removed).toEqual([["second"]]);
  });
  test("rejects a whole oversized addition while retaining existing IDs", async () => {
    const { draft, removed, errors } = bench();
    await draft.stage(async () => [item("1"), item("2"), item("3"), item("4")]);
    await draft.stage(async () => [item("1"), item("5"), item("6")]);
    expect(removed).toEqual([["5", "6"]]); expect(errors).toEqual(["five maximum"]); expect(draft.items).toHaveLength(4);
    draft.sent(["1"]); draft.remove("2"); expect(removed.at(-1)).toEqual(["2"]);
  });
});

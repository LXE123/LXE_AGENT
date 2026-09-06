import { describe, expect, test } from "bun:test";
import { ConversationAttachmentDraft } from "../../../src/features/sessions/attachment-draft";
const item = (id: string) => ({ attachment_id: id, name: id, media_type: "image/png", size_bytes: 1 });
const screenshot = (id: string) => ({ ...item(id), preview_data_url: "data:image/png;base64,cG5n" });
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
  test("accepts many file references alongside five screenshots, including subsequent additions", async () => {
    const { draft, errors } = bench();
    const files = Array.from({ length: 25 }, (_, index) => item(`file-${index}`));
    await draft.stage(async () => files);
    await draft.stage(async () => Array.from({ length: 5 }, (_, index) => screenshot(`screenshot-${index}`)));
    await draft.stage(async () => [item("another-image-file")]);
    expect(draft.items).toHaveLength(31);
    expect(draft.items.slice(0, 25)).toEqual(files);
    expect(errors).toEqual([]);
  });
  test("rejects a whole addition exceeding the screenshot limit while retaining existing IDs", async () => {
    const { draft, removed, errors } = bench();
    await draft.stage(async () => [screenshot("1"), screenshot("2"), screenshot("3"), screenshot("4")]);
    await draft.stage(async () => [screenshot("1"), screenshot("5"), item("file"), screenshot("6")]);
    expect(removed).toEqual([["5", "file", "6"]]); expect(errors).toEqual(["five maximum"]); expect(draft.items).toHaveLength(4);
    draft.sent(["1"]); draft.remove("2"); expect(removed.at(-1)).toEqual(["2"]);
  });
});

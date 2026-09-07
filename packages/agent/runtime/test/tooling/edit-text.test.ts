import { describe, expect, test } from "bun:test";
import { normalizeEditMatch, prepareTextEdit, summarizeTextEdit, validateEditInput } from "../../src/tooling/coding/edit-text";

const replace = (source: string, oldText: string, newText: string) => prepareTextEdit(source, [{ oldText, newText }]);

describe("edit input", () => {
  test("accepts deletion and preserves literal whitespace in parameters", () => {
    expect(validateEditInput({ path: " a.txt ", edits: [{ oldText: " x ", newText: "" }] }))
      .toEqual({ path: " a.txt ", edits: [{ oldText: " x ", newText: "" }] });
  });
  test.each([
    null, [], "{}", {}, { path: " " }, { path: "a", edits: [] }, { path: 3, edits: [] },
    { path: "a", edits: "[]" }, { path: "a", edits: [{}] },
    { path: "a", edits: [{ oldText: "x" }] },
    { path: "a", edits: [{ oldText: "", newText: "x" }] },
    { path: "a", edits: [{ oldText: 2, newText: "x" }] },
    { path: "a", edits: [{ oldText: "x", newText: null }] },
    { path: "a", edits: [{ oldText: "x", newText: 0 }] },
    { path: "a", edits: [{ oldText: "x", newText: "y", replace_all: true }] },
    { path: "a", edits: [{ oldText: "x", newText: "y" }], extra: true },
  ].map((input) => [input]))("rejects invalid input %#", (input) => {
    expect(() => validateEditInput(input)).toThrow();
  });
  test("explains the new interface for legacy calls", () => {
    expect(() => validateEditInput({ file_path: "a", old_string: "x", new_string: "y" }))
      .toThrow('Use {"path":"src/app.ts","edits":');
  });
});

describe("batch text edits", () => {
  test("handles unordered, adjacent targets on the same line and literal dollar patterns", () => {
    expect(prepareTextEdit("abcdef", [
      { oldText: "de", newText: "$&$1" }, { oldText: "bc", newText: "X" },
    ]).content).toBe("aX$&$1f");
  });
  test("matches against the original, never replacement output", () => {
    expect(prepareTextEdit("first\nsecond\n", [
      { oldText: "first", newText: "second" }, { oldText: "second", newText: "third" },
    ]).content).toBe("second\nthird\n");
    expect(() => prepareTextEdit("first", [
      { oldText: "first", newText: "second" }, { oldText: "second", newText: "third" },
    ])).toThrow("edits[1].oldText not found");
  });
  test.each([["bcd", "de"], ["bcde", "cd"], ["bc", "bc"]])("rejects overlapping targets %s / %s", (a, b) => {
    expect(() => prepareTextEdit("abcdef", [{ oldText: a, newText: "X" }, { oldText: b, newText: "Y" }]))
      .toThrow("edits[0] and edits[1] overlap");
  });
  test("counts overlapping occurrences as ambiguous", () => {
    expect(() => replace("aaa", "aa", "b")).toThrow("not unique");
  });
  test("rejects repeated normalized targets even if exact matching is unique", () => {
    expect(() => replace("'x' and ‘x’", "'x'", "y")).toThrow("not unique after normalization");
  });
  test("rejects empty normalized targets and unchanged batches", () => {
    expect(() => replace("   ", " ", "x")).toThrow("empty after normalization");
    expect(() => replace("hello", "hello", "hello")).toThrow("未产生修改");
  });
  test("supports deletion, including an entire file", () => {
    expect(replace("a\nb\nc\n", "b\n", "").content).toBe("a\nc\n");
    expect(replace("hello", "hello", "").content).toBe("");
  });
  test("preserves exact text and unchanged Unicode without fuzzy matching", () => {
    const result = replace("‘a’  \nkeep—  \n", "‘a’", "‘b’");
    expect(result.content).toBe("‘b’  \nkeep—  \n");
    expect(result.fuzzyEdits).toEqual([]);
  });
  test.each([
    ["Ａ", "A"], ["ﬃ", "ffi"], ["e\u0301", "é"],
    ["‘x’", "'x'"], ["“x”", '"x"'], ["a—b", "a-b"],
    ["a\u00a0b", "a b"], ["a\u2009b", "a b"], ["a\u3000b", "a b"],
    ["a  \nb", "a\nb"],
  ])("normalizes %s to match %s", (source, target) => {
    const result = replace(source, target, "replaced");
    expect(result.content).toBe("replaced");
    expect(result.fuzzyEdits).toEqual([0]);
  });
  test("covers the complete PI quote/dash/space character sets", () => {
    expect(normalizeEditMatch("\u2018\u2019\u201a\u201b")).toBe("''''");
    expect(normalizeEditMatch("\u201c\u201d\u201e\u201f")).toBe('""""');
    expect(normalizeEditMatch("\u2010\u2011\u2012\u2013\u2014\u2015\u2212")).toBe("-------");
    for (const code of [0xa0, ...Array.from({ length: 9 }, (_, i) => 0x2002 + i), 0x202f, 0x205f, 0x3000]) {
      expect(normalizeEditMatch(`a${String.fromCharCode(code)}b`)).toBe("a b");
    }
  });
  test("uses one coordinate space for fuzzy and exact targets after NFKC expansion", () => {
    const result = prepareTextEdit("ﬃ first\nsecond\nkeep ‘quotes’  \n", [
      { oldText: "ffi", newText: "X" }, { oldText: "second", newText: "Y" },
    ]);
    expect(result.content).toBe("X first\nY\nkeep ‘quotes’  \n");
    expect(result.fuzzyEdits).toEqual([0]);
  });
  test("preserves unchanged lines, including final whitespace without a newline", () => {
    expect(replace("before ‘x’  \nchange ‘y’  \nafter ‘z’  \n   ", "'y'", "yes").content)
      .toBe("before ‘x’  \nchange yes\nafter ‘z’  \n   ");
  });
  test("merges multiple fuzzy changes on one line", () => {
    expect(prepareTextEdit("‘a’ and ‘b’  \nkeep  ", [
      { oldText: "'b'", newText: "B" }, { oldText: "'a'", newText: "A" },
    ]).content).toBe("A and B\nkeep  ");
  });
  test("does not normalize an unchanged line joined by removing a newline", () => {
    const result = replace("‘a’\nkeep ‘b’  \n", "'a'\n", "A");
    expect(result.content).toBe("Akeep ‘b’  \n");
    expect(summarizeTextEdit("a", 1, result, 10_000)).toContain("+1 Akeep ‘b’  ");
  });
  test("joins adjacent edited groups without losing replacements", () => {
    expect(prepareTextEdit("a\nb\nc\nd\n", [
      { oldText: "a\n", newText: "A" }, { oldText: "b\n", newText: "B" },
      { oldText: "c\n", newText: "C" },
    ]).content).toBe("ABCd\n");
  });
  test("combines deletion, line joining and multiline insertion across adjacent blocks", () => {
    const letters = ["a", "b", "c", "d"];
    for (let combination = 0; combination < 256; combination++) {
      const replacements = letters.map((letter, i) => {
        const variants = ["", letter.toUpperCase(), `${letter.toUpperCase()}\n`, `${letter.toUpperCase()}\nextra\n`];
        return variants[(combination >> (i * 2)) & 3]!;
      });
      const edits = letters.map((letter, i) => ({ oldText: `${letter}\n`, newText: replacements[i]! })).reverse();
      expect(prepareTextEdit("a\nb\nc\nd\n", edits).content).toBe(replacements.join(""));
    }
  });
  test("detects overlap in normalized coordinates", () => {
    expect(() => prepareTextEdit("ﬃ end", [
      { oldText: "ﬃ", newText: "A" }, { oldText: "ffi", newText: "B" },
    ])).toThrow("edits[0] and edits[1] overlap");
  });
  test("handles a distant edit in a file with many unchanged lines", () => {
    const prefix = "unchanged\n".repeat(150_000);
    const result = replace(`${prefix}target\n`, "target", "updated");
    expect(result.content).toBe(`${prefix}updated\n`);
    expect(result.firstChangedLine).toBe(150_001);
  });
  test.each([
    ["\uFEFFa\r\nb\r\n", "a\nb", "A\nB", "\uFEFFA\r\nB\r\n"],
    ["a\nb\n", "a\r\nb", "A\r\nB", "A\nB\n"],
    ["a\r\nb\nc", "c", "C", "a\r\nb\r\nC"],
    ["a\nb\r\nc", "c", "C", "a\nb\nC"],
    ["a\rb", "b", "B", "a\nB"],
    ["\uFEFFa", "a", "b", "\uFEFFb"],
  ])("preserves BOM and restores newline style %#", (source, oldText, newText, expected) => {
    expect(replace(source, oldText, newText).content).toBe(expected);
  });
});

describe("edit summaries", () => {
  test("shows actual fuzzy line changes, not just the requested substring", () => {
    const result = replace("before\n‘a’ — ‘keep’  \nafter\n", "'a'", "A");
    const summary = summarizeTextEdit("a.txt", 1, result, 10_000);
    expect(summary).toContain("first changed line 2");
    expect(summary).toContain("Normalized matching used");
    expect(summary).toContain("edits[0]");
    expect(summary).toContain("-2 ‘a’ — ‘keep’  ");
    expect(summary).toContain("+2 A - 'keep'");
  });
  test("uses correct new line numbers after insertions and coalesces context", () => {
    const result = prepareTextEdit("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n", [
      { oldText: "b", newText: "B\nBB" }, { oldText: "f", newText: "F" },
    ]);
    const summary = summarizeTextEdit("a", 2, result, 10_000);
    expect(summary).toContain("+2 B\n+3 BB");
    expect(summary).toContain("+7 F");
    expect(summary.match(/@@/g)).toHaveLength(1);
    expect(summary.match(/ 4 d/g)).toHaveLength(1);
    expect(summary).not.toContain(" 10 j");
  });
  test("handles newline-only changes and the missing final newline marker", () => {
    const result = replace("a\r\nb\n", "a", "a");
    expect(result.firstChangedLine).toBe(2);
    expect(summarizeTextEdit("a", 1, result, 10_000)).toContain("Line endings normalized throughout the file to CRLF");
    expect(summarizeTextEdit("a", 1, replace("a", "a", "b"), 10_000)).toContain("No newline at end of file");
  });
  test("bounds output on complete lines without changing the edit", () => {
    const result = replace("start\nold\nend\n", "old", "x".repeat(20_000));
    const summary = summarizeTextEdit("a", 1, result, 10_000);
    expect(summary.length).toBeLessThanOrEqual(10_000);
    expect(summary).toContain("Diff summary truncated; use read");
    expect(summary).not.toContain("+2 x");
    expect(result.content).toHaveLength(20_011);
  });
});

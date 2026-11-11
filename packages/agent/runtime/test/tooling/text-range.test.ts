import { describe, expect, test } from "bun:test";
import { READ_MAX_BYTES, scanNumberedTextChunks, type NumberedTextRangeOptions } from "../../src/tooling/text-range";

const encoder = new TextEncoder();

function scanText(text: string, options: Partial<NumberedTextRangeOptions> = {}, chunkSize = 3) {
  const bytes = encoder.encode(text);
  async function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
  }
  return scanNumberedTextChunks(chunks(), { startLine: 1, plainText: true, ...options });
}

describe("read text pages", () => {
  test("both renderings count lines to EOF when a requested range ends between chunks", async () => {
    const input = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const notice = "\n\n[5 more lines in file. Use offset=6 to continue.]";
    expect(await scanText(input, { startLine: 3, maxLines: 3 })).toBe("line3\nline4\nline5" + notice);
    expect(await scanText(input, { startLine: 3, maxLines: 3, plainText: false }))
      .toBe("     3\tline3\n     4\tline4\n     5\tline5" + notice);
  });

  test("preserves script text, numbers direct reads, and counts Pi's trailing empty line", async () => {
    const input = "\uFEFFfirst\r\n  中文🙂\r\n";
    expect(await scanText(input, {}, 1)).toBe(input);
    expect(await scanText(input, { plainText: false }, 1)).toBe("     1\tfirst\n     2\t  中文🙂");
    expect(await scanText(input, { startLine: 2, maxLines: 1 }, 1))
      .toBe("  中文🙂\r\n\n[1 more lines in file. Use offset=3 to continue.]");
    expect(await scanText(input, { startLine: 3 })).toBe("");
    await expect(scanText(input, { startLine: 4 })).rejects.toThrow("3 lines total");
    expect(await scanText("")).toBe("");
    expect(await scanText("\n\n", { plainText: false })).toBe("     1\t\n     2\t");
    expect(await scanText("abc\r", { plainText: false })).toBe("     1\tabc\r");
  });

  test("limits the raw UTF-8 page to 50 KiB before formatting, without splitting lines", async () => {
    const exact = "🙂".repeat(READ_MAX_BYTES / 4);
    expect(await scanText(exact, {}, 101)).toBe(exact);
    expect(await scanText(exact, { plainText: false }, 101)).toBe("     1\t" + exact);
    expect(await scanText(exact + "\ntail", {}, 101))
      .toBe(exact + "\n\n[Showing lines 1-1 of 2 (50.0KB limit). Use offset=2 to continue.]");
    expect(await scanText(exact + "\ntail", { startLine: 2 }, 101)).toBe("tail");
  });

  test("counts a multi-megabyte line across chunks and returns only its byte-read hint", async () => {
    const input = "ok\n" + "中".repeat(1_048_576) + "\r\nlast";
    expect(await scanText(input, {}, 65_536)).toBe("ok\n\n[Showing lines 1-1 of 3 (50.0KB limit). Use offset=2 to continue.]");
    expect(await scanText(input, { startLine: 2 }, 65_536))
      .toBe("[Line 2 is 3.0MB, exceeds 50.0KB limit. Use exec to read this line in byte ranges.]");
  });

  test("enforces the 2000-line hard cap, even with a larger explicit limit", async () => {
    const page = Array(2000).fill("x").join("\n");
    expect(await scanText(page + "\n")).toBe(page + "\n");
    const expected = page + "\n\n[Showing lines 1-2000 of 2100. Use offset=2001 to continue.]";
    const extra = "\nx".repeat(100);
    expect(await scanText(page + extra)).toBe(expected);
    expect(await scanText(page + extra, { maxLines: 2100 })).toBe(expected);
    expect(await scanText(page + extra, { maxLines: 2000 })).toBe(page + "\n\n[100 more lines in file. Use offset=2001 to continue.]");
  });

  test("can cancel while counting lines beyond the returned range", async () => {
    const controller = new AbortController();
    async function* chunks() {
      yield encoder.encode("one\ntwo\n");
      controller.abort(new DOMException("cancelled", "AbortError"));
      yield encoder.encode("three\n");
    }
    await expect(scanNumberedTextChunks(chunks(), { startLine: 1, maxLines: 1, signal: controller.signal }))
      .rejects.toThrow("cancelled");
  });
});

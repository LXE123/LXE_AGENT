import { describe, expect, test } from "bun:test";
import { scanNumberedTextChunks, type NumberedTextRangeOptions } from "../../src/tooling/text-range";

const encoder = new TextEncoder();

const scanText = (text: string, options: Partial<NumberedTextRangeOptions> = {}, chunkSize = 3) => {
  const bytes = encoder.encode(text);
  const chunks = async function* (): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
  };
  return scanNumberedTextChunks(chunks(), { startLine: 1, maxLines: 2_000, charBudget: 10_000, ...options });
};

describe("bounded text range scanner", () => {
  test("script reads preserve file text across byte boundaries and paginate without line numbers", async () => {
    const input = "\uFEFFfirst\r\n  中文🙂\r\n";
    expect(await scanText(input, { plainText: true }, 1)).toEqual({ body: input, hasMore: false });
    expect(await scanText(input, { plainText: true, startLine: 2, maxLines: 1 }, 1))
      .toEqual({ body: "  中文🙂\r", hasMore: true, nextOffset: 3 });
    expect(await scanText(input, { plainText: true, startLine: 3 }, 1)).toEqual({ body: "", hasMore: false });
    expect(await scanText("abc\ndef", { plainText: true, charBudget: 5 }, 1))
      .toEqual({ body: "abc", hasMore: true, nextOffset: 2 });
  });
  for (const ending of ["", "\n", "\r\n"]) {
    test(`does not advertise a next page at EOF with ending ${JSON.stringify(ending)}`, async () => {
      expect(await scanText(`one\ntwo${ending}`, { maxLines: 2 })).toEqual({
        body: "     1\tone\n     2\ttwo", hasMore: false,
      });
      await expect(scanText(`one\ntwo${ending}`, { startLine: 3 })).rejects
        .toThrow("Offset 3 is beyond end of file (2 lines total)");
    });
  }

  test("handles empty files and real blank lines without a phantom terminal line", async () => {
    expect(await scanText("")).toEqual({ body: "", hasMore: false });
    await expect(scanText("", { startLine: 2 })).rejects.toThrow("Offset 2 is beyond end of file (0 lines total)");
    expect(await scanText("\n\n", { maxLines: 1 })).toEqual({ body: "     1\t", hasMore: true, nextOffset: 2 });
    expect(await scanText("\n\n", { startLine: 2 })).toEqual({ body: "     2\t", hasMore: false });
  });

  for (const ending of ["", "\n", "\r\n"]) {
    test(`accepts an exactly full line budget with ending ${JSON.stringify(ending)}`, async () => {
      expect(await scanText(`abc${ending}`, { charBudget: 10 }, 1)).toEqual({
        body: "     1\tabc", hasMore: false,
      });
    });
  }

  test("rolls an incomplete next line back so continuation neither skips nor duplicates it", async () => {
    const text = "one\r\n中文🙂\r\ntail";
    expect(await scanText(text, { charBudget: 17 }, 1)).toEqual({
      body: "     1\tone", hasMore: true, nextOffset: 2,
    });
    expect(await scanText(text, { startLine: 2, charBudget: 17 }, 1)).toEqual({
      body: "     2\t中文🙂", hasMore: true, nextOffset: 3,
    });
    expect(await scanText(text, { startLine: 3, charBudget: 17 }, 1)).toEqual({
      body: "     3\ttail", hasMore: false,
    });
  });

  test("does not split a Unicode character in an oversized-line preview", async () => {
    expect(await scanText("🙂🙂", { charBudget: 10 }, 1)).toEqual({
      body: "     1\t🙂", hasMore: true, truncatedLine: 1,
    });
    expect(await scanText("abc\r", { charBudget: 11 }, 1)).toEqual({
      body: "     1\tabc\r", hasMore: false,
    });
  });

  test("looks ahead once when a page ends exactly at a chunk boundary", async () => {
    let requested = 0;
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      requested += 1;
      yield encoder.encode("one\n");
      requested += 1;
      yield encoder.encode("two\n");
      throw new Error("scanner read beyond the lookahead chunk");
    };
    expect(await scanNumberedTextChunks(chunks(), { startLine: 1, maxLines: 1, charBudget: 10_000 }))
      .toEqual({ body: "     1\tone", hasMore: true, nextOffset: 2 });
    expect(requested).toBe(2);
  });

  test("stops requesting chunks as soon as the selected range is complete", async () => {
    let requested = 0;
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      requested += 1;
      yield encoder.encode("one\ntwo\nthree\nfour\n");
      requested += 1;
      throw new Error("scanner read beyond the requested range");
    };

    const result = await scanNumberedTextChunks(chunks(), {
      startLine: 2,
      maxLines: 2,
      charBudget: 10_000,
    });

    expect(requested).toBe(1);
    expect(result.body).toBe("     2\ttwo\n     3\tthree");
    expect(result).toMatchObject({ hasMore: true, nextOffset: 4 });
  });

  test("bounds a multi-megabyte unterminated line without requesting the remaining source", async () => {
    let requested = 0;
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 32; index += 1) {
        requested += 1;
        yield encoder.encode("中".repeat(65_536));
      }
    };

    const result = await scanNumberedTextChunks(chunks(), {
      startLine: 1,
      maxLines: 2_000,
      charBudget: 10_000,
    });

    expect(requested).toBe(1);
    expect(result.body.length).toBe(10_000);
    expect(result).toMatchObject({ hasMore: true, truncatedLine: 1 });
    expect(result.nextOffset).toBeUndefined();
  });

  test("preserves UTF-8 characters, CRLF lines, and an unterminated tail across chunk boundaries", async () => {
    const bytes = encoder.encode("alpha\r\n中文🙂\r\ntail");
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < bytes.length; offset += 3) yield bytes.subarray(offset, offset + 3);
    };

    const result = await scanNumberedTextChunks(chunks(), {
      startLine: 2,
      maxLines: 2,
      charBudget: 10_000,
    });

    expect(result.body).toBe("     2\t中文🙂\n     3\ttail");
    expect(result).toEqual({ body: result.body, hasMore: false });
  });

  test("honors cancellation between source chunks", async () => {
    const controller = new AbortController();
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      yield encoder.encode("one\n");
      controller.abort(new DOMException("cancelled", "AbortError"));
      yield encoder.encode("two\n");
    };

    await expect(scanNumberedTextChunks(chunks(), {
      startLine: 10,
      maxLines: 1,
      charBudget: 10_000,
      signal: controller.signal,
    })).rejects.toThrow("cancelled");
  });
});

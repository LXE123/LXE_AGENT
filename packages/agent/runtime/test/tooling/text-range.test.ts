import { describe, expect, test } from "bun:test";
import { scanNumberedTextChunks } from "../../src/tooling/text-range";

const encoder = new TextEncoder();

describe("bounded text range scanner", () => {
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

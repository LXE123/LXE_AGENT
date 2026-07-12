import { describe, expect, test } from "bun:test";
import {
  appendLimitedBytes,
  appendTailBytes,
  combineProcessStreams,
  decodeProcessOutput,
  formatCommandPayload,
} from "../src/process-output";

describe("process output compatibility", () => {
  test("decodes UTF-8, GBK and CP437 in main-compatible order", () => {
    expect(decodeProcessOutput(new TextEncoder().encode("中文 UTF-8"))).toBe("中文 UTF-8");
    expect(decodeProcessOutput(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe("你好");
    expect(decodeProcessOutput(new Uint8Array([0x82]))).toBe("é");
  });

  test("decodes multibyte characters after byte chunks are reassembled", () => {
    const first = appendLimitedBytes(new Uint8Array(), new Uint8Array([0xc4]), 100);
    const second = appendLimitedBytes(first.bytes, new Uint8Array([0xe3, 0xba, 0xc3]), 100);
    expect(decodeProcessOutput(second.bytes)).toBe("你好");
  });

  test("keeps bounded head and tail byte buffers independently", () => {
    const head = appendLimitedBytes(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), 4);
    expect([...head.bytes]).toEqual([1, 2, 3, 4]);
    expect(head.truncated).toBe(true);
    expect([...appendTailBytes(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), 3)]).toEqual([3, 4, 5]);
  });

  test("combines stdout and stderr without chunk-level prefixes", () => {
    expect(combineProcessStreams(
      new TextEncoder().encode("out\n"),
      new TextEncoder().encode("error\n"),
    )).toBe("out\n[stderr]\nerror\n");
  });

  test("formats model-visible command payloads without pretty JSON overhead", () => {
    const text = formatCommandPayload({
      session: "exec_1",
      status: "completed",
      exit_code: 0,
      output: JSON.stringify({ rows: [{ sku: "A", quantity: 2 }] }),
      duration_sec: 1.25,
    });
    expect(text).toContain("session: exec_1");
    expect(text).toContain("output:\n  rows:\n    -\n      sku: A");
    expect(text).not.toContain('  "session"');
    expect(text.length).toBeLessThan(JSON.stringify({
      session: "exec_1", status: "completed", exit_code: 0,
      output: JSON.stringify({ rows: [{ sku: "A", quantity: 2 }] }), duration_sec: 1.25,
    }, null, 2).length);
  });
});

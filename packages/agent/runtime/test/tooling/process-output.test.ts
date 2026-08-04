import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessOutputStore,
  decodeProcessOutput,
  formatCommandPayload,
  formatCommandPayloadWithBudget,
  renderProcessChunks,
  trimPartialUtf8,
} from "../../src/tooling/process-output";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-process-output-"));
  roots.push(root);
  return root;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("process output decoding", () => {
  test("decodes UTF-8 and GBK", () => {
    expect(decodeProcessOutput(utf8("中文 UTF-8"))).toBe("中文 UTF-8");
    expect(decodeProcessOutput(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe("你好");
  });

  test("repairs multibyte characters split by an arbitrary byte cut", () => {
    const full = utf8("构建失败：模块未找到");
    // Cut two bytes into the first character, and one byte before the end of the last.
    const cut = full.subarray(2, full.byteLength - 1);
    const decoded = decodeProcessOutput(cut);
    expect(decoded).toBe("建失败：模块未找");
    expect(decoded).not.toContain("�");
    expect([...trimPartialUtf8(cut)].length).toBeLessThan(cut.byteLength);
  });

  test("keeps undecodable bytes visible instead of inventing readable text", () => {
    // A lone continuation byte is not UTF-8 and not valid GBK. Single-byte codepages
    // would round-trip it into confident mojibake, which is what this guards against.
    expect(decodeProcessOutput(new Uint8Array([0x82]))).toBe("�");
  });
});

describe("process output rendering", () => {
  test("renders stdout-only output without stream markers", () => {
    expect(renderProcessChunks([
      { seq: 0, stream: "stdout", bytes: utf8("line one\n") },
      { seq: 1, stream: "stdout", bytes: utf8("line two\n") },
    ])).toBe("line one\nline two\n");
  });

  test("preserves interleaving order between stdout and stderr", () => {
    expect(renderProcessChunks([
      { seq: 0, stream: "stdout", bytes: utf8("step 1\n") },
      { seq: 1, stream: "stderr", bytes: utf8("warning\n") },
      { seq: 2, stream: "stdout", bytes: utf8("step 2\n") },
    ])).toBe("[stdout]\nstep 1\n[stderr]\nwarning\n[stdout]\nstep 2");
  });

  test("reassembles a character split across two reads of the same stream", () => {
    const full = utf8("模块");
    expect(renderProcessChunks([
      { seq: 0, stream: "stdout", bytes: full.subarray(0, 2) },
      { seq: 1, stream: "stdout", bytes: full.subarray(2) },
    ])).toBe("模块");
  });
});

describe("process output store", () => {
  test("keeps the tail in memory and the full transcript on disk", () => {
    const spillPath = join(scratch(), "exec_test.log");
    const store = new ProcessOutputStore({ retainBytes: 400, spillPath });
    const lines = Array.from({ length: 200 }, (_, index) => `第 ${index} 行 构建输出\n`);
    for (const line of lines) store.append("stdout", utf8(line));

    const complete = lines.join("");
    expect(store.totalBytes).toBe(Buffer.byteLength(complete, "utf8"));
    expect(store.truncated).toBe(true);
    expect(store.droppedBytes).toBeGreaterThan(0);
    expect(store.spillPath).toBe(spillPath);

    // The model-visible part is the END of the output, and it is not mojibake.
    const retained = store.renderRetained();
    expect(retained).not.toContain("�");
    expect(retained.endsWith("第 199 行 构建输出\n")).toBe(true);
    expect(complete.endsWith(retained)).toBe(true);
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(400);

    // The transcript is byte-exact and readable before close(), because the model is
    // handed output_path while the command may still be running.
    expect(readFileSync(spillPath, "utf8")).toBe(complete);
  });

  test("returns short output untouched and writes no transcript", () => {
    const spillPath = join(scratch(), "exec_small.log");
    const store = new ProcessOutputStore({ retainBytes: 10_000, spillPath });
    store.append("stdout", utf8("done\n"));
    expect(store.renderRetained()).toBe("done\n");
    expect(store.truncated).toBe(false);
    expect(store.spillPath).toBe("");
    expect(() => readFileSync(spillPath)).toThrow();
  });

  test("delivers poll increments once and reports evicted gaps", () => {
    const store = new ProcessOutputStore({ retainBytes: 64 });
    store.append("stdout", utf8("first\n"));
    const first = store.renderSince(0);
    expect(first.text).toBe("first\n");
    expect(first.missed).toBe(false);

    store.append("stdout", utf8("second\n"));
    const second = store.renderSince(first.cursor);
    expect(second.text).toBe("second\n");
    expect(second.missed).toBe(false);
    expect(store.renderSince(second.cursor).text).toBe("");

    for (let index = 0; index < 20; index += 1) store.append("stdout", utf8(`spam ${index}\n`));
    expect(store.renderSince(second.cursor).missed).toBe(true);
  });

  test("caps the transcript so a runaway command cannot fill the disk", () => {
    const spillPath = join(scratch(), "exec_runaway.log");
    const store = new ProcessOutputStore({ retainBytes: 32, spillPath, spillLimitBytes: 64 });
    for (let index = 0; index < 50; index += 1) store.append("stdout", utf8("0123456789\n"));
    expect(readFileSync(spillPath).byteLength).toBe(64);
    expect(store.outputFileBytes).toBe(64);
    expect(store.outputFileCoversCaptured).toBe(false);
    expect(store.outputFileTruncated).toBe(true);
  });

  test("materializes short output on demand and keeps appending while live", async () => {
    const spillPath = join(scratch(), "exec_on_demand.log");
    const store = new ProcessOutputStore({ retainBytes: 10_000, spillPath });
    store.append("stdout", utf8("first\n"));
    await store.ensureSpill();
    expect(readFileSync(spillPath, "utf8")).toBe("first\n");
    expect(store.outputFileCoversCaptured).toBe(true);

    store.append("stderr", utf8("second\n"));
    await store.ensureSpill();
    expect(readFileSync(spillPath, "utf8")).toBe("first\nsecond\n");
    expect(store.outputFileBytes).toBe(store.totalBytes);
    expect(store.outputFileCoversCaptured).toBe(true);
    await store.close();
  });

  test("materializes and closes output after the process store already closed", async () => {
    const spillPath = join(scratch(), "exec_terminal_on_demand.log");
    const store = new ProcessOutputStore({ retainBytes: 10_000, spillPath });
    store.append("stdout", utf8("terminal\n"));
    await store.close();
    await store.ensureSpill();
    await store.ensureSpill();
    expect(readFileSync(spillPath, "utf8")).toBe("terminal\n");
    expect(store.outputFileCoversCaptured).toBe(true);
  });

  test("reports the real output-file creation error", async () => {
    const root = scratch();
    const parentFile = join(root, "not-a-directory");
    await Bun.write(parentFile, "file");
    const store = new ProcessOutputStore({
      retainBytes: 10_000,
      spillPath: join(parentFile, "exec.log"),
    });
    store.append("stdout", utf8("captured\n"));
    await store.ensureSpill();
    expect(store.spillPath).toBe("");
    expect(store.outputFileCoversCaptured).toBe(false);
    expect(store.outputFileError).toMatch(/EEXIST|ENOTDIR|not a directory/iu);
  });

  test("renders a bounded tail across chunk boundaries", () => {
    const store = new ProcessOutputStore({ retainBytes: 10_000 });
    store.append("stdout", utf8("早期输出\n"));
    store.append("stdout", utf8("末尾输出\n"));
    const tail = store.renderTail(13);
    expect(tail).not.toContain("�");
    expect("早期输出\n末尾输出\n".endsWith(tail)).toBe(true);
  });
});

describe("model-visible payload formatting", () => {
  test("formats command payloads without pretty JSON overhead", () => {
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

  test("surfaces truncation metadata ahead of the output body", () => {
    const text = formatCommandPayload({
      session: "exec_2",
      status: "completed",
      exit_code: 1,
      truncated: true,
      omitted_bytes: 812_340,
      output_path: "/w/var/tmp/exec/exec_2.log",
      output: "[... 已省略开头 812340 字节 ...]\ntail line",
    });
    expect(text.indexOf("truncated: true")).toBeLessThan(text.indexOf("output:"));
    expect(text).toContain("omitted_bytes: 812340");
    expect(text).toContain("output_path: /w/var/tmp/exec/exec_2.log");
  });

  test("budgets the formatted output while preserving control metadata", () => {
    const formatted = formatCommandPayloadWithBudget({
      exec_id: "exec_budget",
      status: "running",
      pid: 123,
      output: `${"A".repeat(5_000)}TAIL`,
    }, 100);
    expect(formatted.observationTruncated).toBe(true);
    expect(formatted.originalTokens).toBeGreaterThan(1_000);
    expect(formatted.omittedTokens).toBeGreaterThan(0);
    expect(formatted.text).toContain("exec_id: exec_budget");
    expect(formatted.text).toContain("status: running");
    expect(formatted.text).toContain("observation_truncated: true");
    expect(formatted.text).toContain("TAIL");
    expect(Buffer.byteLength(formatted.text, "utf8")).toBeLessThanOrEqual(40_000);
  });

  test("keeps metadata visible at the minimum output budget", () => {
    const formatted = formatCommandPayloadWithBudget({
      exec_id: "exec_tiny",
      status: "running",
      output: "large output".repeat(1_000),
    }, 1);
    expect(formatted.observationTruncated).toBe(true);
    expect(formatted.text).toContain("exec_id: exec_tiny");
    expect(formatted.text).toContain("observation_omitted_tokens:");
    expect(formatted.text).toContain("output:\n…");
  });
});

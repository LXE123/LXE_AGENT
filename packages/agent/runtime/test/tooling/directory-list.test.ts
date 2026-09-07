import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { formatDirectoryPage, validateDirectoryListInput } from "../../src/tooling/coding/directory-list";
import { CodingPathPolicy } from "../../src/tooling/coding/path-policy";
import { createSearchTools } from "../../src/tooling/coding/search-tools";
import { ToolRegistry } from "../../src/tooling/registry";
import { workspaceFor } from "../workspace";

const entry = (name: string, kind: "file" | "directory" | "symlink" = "file") => ({
  name, isDirectory: () => kind === "directory", isSymbolicLink: () => kind === "symlink",
});
const pageEntries = (text: string): string[] => text.split("\n").slice(1, -1);
const nextOffset = (text: string): number | undefined => {
  const match = text.match(/Continue with offset=(\d+)\.$/);
  return match ? Number(match[1]) : undefined;
};

describe("ls arguments", () => {
  test("retains old calls and accepts the numeric boundaries", () => {
    expect(validateDirectoryListInput({})).toEqual({ path: ".", limit: 500, offset: 0 });
    expect(validateDirectoryListInput({ path: "dir" })).toEqual({ path: "dir", limit: 500, offset: 0 });
    expect(validateDirectoryListInput({ limit: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER }))
      .toEqual({ path: ".", limit: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER });
  });
  test.each([
    null, [], "{}", { path: null }, { path: 42 }, { path: "" }, { path: " \t" },
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: "2" }, { limit: null },
    { limit: Number.MAX_SAFE_INTEGER + 1 }, { limit: NaN }, { limit: Infinity },
    { offset: -1 }, { offset: 0.5 }, { offset: "0" }, { offset: null },
    { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: NaN }, { offset: Infinity },
    { recursive: true }, { head_limit: 10 }, { limit: undefined },
  ].map((input) => [input]))("rejects invalid arguments %#", (input) => {
    expect(() => validateDirectoryListInput(input)).toThrow();
  });
});

describe("directory page formatting", () => {
  test("sorts original names independent of enumeration order and entry type", () => {
    const entries = [entry("中文"), entry("z", "directory"), entry("a"), entry("A"), entry(".hidden"), entry("b", "symlink")];
    const expected = [".hidden", "A", "a", "b@", "z/", "中文"];
    for (const input of [entries, [...entries].reverse(), [...entries.slice(3), ...entries.slice(0, 3)]]) {
      expect(pageEntries(formatDirectoryPage(input, { offset: 0, limit: 500 }, 10_000))).toEqual(expected);
    }
    expect(entries.map((item) => item.name)).toEqual(["中文", "z", "a", "A", ".hidden", "b"]);
  });
  test("uses the default entry limit and then reaches the last page", () => {
    const entries = Array.from({ length: 503 }, (_, i) => entry(`f${String(i).padStart(3, "0")}`));
    const first = formatDirectoryPage(entries, validateDirectoryListInput({}), 10_000);
    expect(pageEntries(first)).toHaveLength(500);
    expect(first).toStartWith("Showing entries 1–500 of 503.");
    expect(first).toEndWith("Entry limit reached. Continue with offset=500.");
    const last = formatDirectoryPage(entries, { offset: 500, limit: 500 }, 10_000);
    expect(pageEntries(last)).toEqual(["f500", "f501", "f502"]);
    expect(last).toEndWith("End of directory.");
    expect(nextOffset(last)).toBeUndefined();
  });
  test("returns explicit empty and out-of-range statuses without a next offset", () => {
    expect(formatDirectoryPage([], { offset: 0, limit: 500 }, 10_000))
      .toBe("Empty directory. Total entries: 0. End of directory.");
    for (const offset of [1, 2, Number.MAX_SAFE_INTEGER]) {
      const text = formatDirectoryPage([entry("a")], { offset, limit: 500 }, 10_000);
      expect(text).toBe(`No more entries at offset=${offset}. Total entries: 1. End of directory.`);
      expect(nextOffset(text)).toBeUndefined();
    }
  });
  test("large requested counts do not overflow when offset is nonzero", () => {
    expect(pageEntries(formatDirectoryPage([entry("a"), entry("b")], { offset: 1, limit: Number.MAX_SAFE_INTEGER }, 10_000)))
      .toEqual(["b"]);
  });
  test("stops on character budget and resumes at the first unreturned name", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`${String(i).padStart(2, "0")}-${"中".repeat(90)}`));
    const first = formatDirectoryPage(entries, { offset: 0, limit: 500 }, 350);
    const returned = pageEntries(first);
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.length).toBeLessThan(entries.length);
    expect(returned).toEqual(entries.slice(0, returned.length).map((item) => item.name));
    expect(first).toContain("Output character limit reached.");
    expect(first.length).toBeLessThanOrEqual(350);
    expect(nextOffset(first)).toBe(returned.length);
    const second = formatDirectoryPage(entries, { offset: returned.length, limit: 500 }, 350);
    expect(pageEntries(second)[0]).toBe(entries[returned.length]!.name);
  });
  test("all pages cover an unchanged directory exactly once across both limits", () => {
    const names = Array.from({ length: 123 }, (_, i) => `f${String(i).padStart(3, "0")}-${"x".repeat(i % 35)}`);
    const entries = names.map((name) => entry(name)).reverse();
    for (const budget of [180, 500, 10_000]) {
      for (const limit of [1, 7, 500]) {
        let offset = 0;
        const observed: string[] = [];
        for (let page = 0; page <= names.length; page++) {
          const text = formatDirectoryPage(entries, { offset, limit }, budget);
          expect(text.length).toBeLessThanOrEqual(budget);
          const rows = pageEntries(text);
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.length).toBeLessThanOrEqual(limit);
          observed.push(...rows);
          const next = nextOffset(text);
          if (next === undefined) break;
          expect(next).toBe(offset + rows.length);
          offset = next;
        }
        expect(observed).toEqual(names);
      }
    }
  });
  test("fits an exact final-page budget including metadata", () => {
    const entries = [entry("a".repeat(100))];
    const full = formatDirectoryPage(entries, { offset: 0, limit: 500 }, 10_000);
    expect(formatDirectoryPage(entries, { offset: 0, limit: 500 }, full.length)).toBe(full);
    expect(() => formatDirectoryPage(entries, { offset: 0, limit: 500 }, full.length - 1)).toThrow("entry at offset=0 cannot fit");
  });
  test("does not skip oversized names or repeatedly return the same offset", () => {
    const entries = [entry("a"), entry("b".repeat(20_000)), entry("c")];
    const first = formatDirectoryPage(entries, { offset: 0, limit: 500 }, 10_000);
    expect(pageEntries(first)).toEqual(["a"]);
    expect(nextOffset(first)).toBe(1);
    expect(() => formatDirectoryPage(entries, { offset: 1, limit: 500 }, 10_000)).toThrow("entry at offset=1 cannot fit");
  });
  test("escapes names into one line while preserving original-name sort order", () => {
    const entries = [entry("a\\n"), entry("a\n"), entry("b\r\t\u0000\u001b\u007f\u0085\u2028\u2029\u202e")];
    const text = formatDirectoryPage(entries, { offset: 0, limit: 500 }, 10_000);
    expect(pageEntries(text)).toEqual(["a\\n", "a\\\\n", "b\\r\\t\\u0000\\u001b\\u007f\\u0085\\u2028\\u2029\\u202e"]);
    expect(text).not.toMatch(/[\r\t\u0000\u001b\u007f\u0085\u2028\u2029\u202e]/);
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-ls-pagination-"));
  roots.push(root);
  return root;
};
function setup() {
  const root = temporaryRoot();
  const registry = new ToolRegistry();
  for (const tool of createSearchTools({ paths: new CodingPathPolicy({ homeDirectory: root }), toolOutputLimit: 10_000 })) registry.register(tool);
  const controller = new AbortController();
  const context = {
    session_id: "ls-test", workspace: workspaceFor(root),
    handle: { signal: controller.signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => undefined },
  };
  const call = async (input: JsonObject = {}): Promise<string> => String((await registry.execute("ls", input, context)).content[0]?.text);
  return { root, registry, controller, call };
}

describe("ls execution", () => {
  test("retains empty/path-only calls and includes hidden and gitignored entries without recursion", async () => {
    const { root, call } = setup();
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(root, "ignored.txt"), "ignored");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "child.txt"), "child");
    const expected = [".gitignore", "ignored.txt", "nested/"];
    expect(pageEntries(await call())).toEqual(expected);
    expect(pageEntries(await call({ path: "." }))).toEqual(expected);
    expect(pageEntries(await call({ path: "nested" }))).toEqual(["child.txt"]);
    expect(pageEntries(await call({ path: "~" }))).toEqual(expected);
  });
  test("accepts absolute host paths and freshly enumerates each call", async () => {
    const { call } = setup();
    const external = temporaryRoot();
    writeFileSync(join(external, "one"), "");
    expect(pageEntries(await call({ path: external, limit: 1, offset: 0 }))).toEqual(["one"]);
    writeFileSync(join(external, "two"), "");
    expect(pageEntries(await call({ path: external, limit: 1, offset: 1 }))).toEqual(["two"]);
  });
  test("keeps the registered tool's character-limited output pageable", async () => {
    const { root, call } = setup();
    const names = Array.from({ length: 140 }, (_, i) => `${String(i).padStart(3, "0")}-${"x".repeat(80)}`);
    for (const name of names) writeFileSync(join(root, name), "");
    const first = await call();
    expect(first.length).toBeLessThanOrEqual(10_000);
    expect(first).toContain("Output character limit reached.");
    const next = nextOffset(first);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(names.length);
    const last = await call({ offset: next! });
    expect(last).toEndWith("End of directory.");
    expect([...pageEntries(first), ...pageEntries(last)]).toEqual(names);
  });
  test("marks directory links without following their contents", async () => {
    const { root, call } = setup();
    const external = temporaryRoot();
    writeFileSync(join(external, "not-listed"), "");
    symlinkSync(external, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(pageEntries(await call())).toEqual(["link@"]);
  });
  test.skipIf(process.platform === "win32")("includes broken links and escapes real unusual filenames", async () => {
    const { root, call } = setup();
    symlinkSync(join(root, "nonexistent"), join(root, "broken"));
    writeFileSync(join(root, "name\nwith\ttabs"), "");
    expect(pageEntries(await call())).toEqual(["broken@", "name\\nwith\\ttabs"]);
  });
  test("preserves missing-path and not-directory errors", async () => {
    const { root, call } = setup();
    writeFileSync(join(root, "file"), "");
    await expect(call({ path: "missing" })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(call({ path: "file" })).rejects.toMatchObject({ code: "ENOTDIR" });
  });
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("retains actual permission denial", async () => {
    const { root, call } = setup();
    const denied = join(root, "denied");
    mkdirSync(denied);
    chmodSync(denied, 0);
    try { await expect(call({ path: denied })).rejects.toMatchObject({ code: "EACCES" }); }
    finally { chmodSync(denied, 0o700); }
  });
  test("rejects invalid input before filesystem access", async () => {
    const { call } = setup();
    await expect(call({ path: "missing", limit: "500" })).rejects.toThrow("positive safe integer");
    await expect(call({ offset: -1 })).rejects.toThrow("non-negative safe integer");
    await expect(call({ recursive: true })).rejects.toThrow("accepts only");
  });
  test("honors an already-cancelled invocation", async () => {
    const { controller, call } = setup();
    controller.abort();
    await expect(call({ path: "missing" })).rejects.toThrow("Turn cancelled");
  });
});

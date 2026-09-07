import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { grepSchema, validateGrepInput } from "../../src/tooling/coding/grep-input";
import { CodingPathPolicy } from "../../src/tooling/coding/path-policy";
import { createSearchTools } from "../../src/tooling/coding/search-tools";
import { ToolRegistry } from "../../src/tooling/registry";
import { workspaceFor } from "../workspace";

describe("grep arguments", () => {
  test("preserves defaults, whitespace and empty filters", () => {
    expect(validateGrepInput({ pattern: " \t" })).toEqual({
      pattern: " \t", path: ".", glob: "", type: "", output_mode: "files_with_matches",
      literal: false, case_insensitive: false, multiline: false, head_limit: 100,
    });
    expect(validateGrepInput({ pattern: "x", path: " dir ", glob: "", type: "", context: 2, before_context: 0, after_context: 0 }))
      .toMatchObject({ path: " dir ", context: 2, before_context: 0, after_context: 0 });
    for (const key of ["head_limit", "context", "before_context", "after_context"]) {
      expect(validateGrepInput({ pattern: "x", [key]: Number.MAX_SAFE_INTEGER })[key as "head_limit"])
        .toBe(Number.MAX_SAFE_INTEGER);
    }
  });
  test.each([null, [], "{}", {}, { pattern: "" }, { pattern: null }, { pattern: 1 }].map(value => [value]))("rejects invalid input %#", value => {
    expect(() => validateGrepInput(value)).toThrow();
  });
  const invalid: [string, unknown][] = [
    ["unknown", true], ["output_mode", "lines"], ["output_mode", null],
    ...["path", "glob", "type"].flatMap(key => [null, 1, false, undefined].map(value => [key, value] as [string, unknown])),
    ["path", ""], ["path", " \t"],
    ...["literal", "case_insensitive", "multiline"].flatMap(key => [null, "true", 1, undefined].map(value => [key, value] as [string, unknown])),
    ...["head_limit", "context", "before_context", "after_context"].flatMap(key =>
      [null, "1", false, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, undefined].map(value => [key, value] as [string, unknown])),
    ["head_limit", 0],
  ];
  test.each(invalid)("rejects invalid %s (%#) without coercion", (key, value) => {
    expect(() => validateGrepInput({ pattern: "x", [key]: value })).toThrow(key);
  });
  test("requires multiline only for literal LF and leaves regex validation to the backend", () => {
    expect(() => validateGrepInput({ pattern: "a\nb", literal: true })).toThrow("multiline=true");
    expect(validateGrepInput({ pattern: "a\nb", literal: true, multiline: true }).pattern).toBe("a\nb");
    expect(validateGrepInput({ pattern: String.raw`a\nb`, literal: true }).multiline).toBe(false);
    expect(validateGrepInput({ pattern: "[" }).pattern).toBe("[");
  });
  test("publishes matching constraints and the literal newline prerequisite", () => {
    expect(grepSchema).toMatchObject({
      required: ["pattern"], additionalProperties: false,
      properties: {
        pattern: { type: "string", minLength: 1 }, literal: { type: "boolean", default: false },
        head_limit: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        before_context: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
      allOf: [{ then: { required: ["multiline"], properties: { multiline: { const: true } } } }],
    });
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporaryRoot = () => { const root = mkdtempSync(join(tmpdir(), "lxe-grep-input-")); roots.push(root); return root; };
function setup() {
  const root = temporaryRoot();
  const registry = new ToolRegistry();
  for (const tool of createSearchTools({ paths: new CodingPathPolicy(), toolOutputLimit: 10_000, ripgrepPath: null })) registry.register(tool);
  const controller = new AbortController();
  const context = {
    session_id: "grep-input-test", workspace: workspaceFor(root),
    handle: { signal: controller.signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => undefined },
  };
  const call = async (input: JsonObject) => String((await registry.execute("grep", input, context)).content[0]?.text);
  return { root, controller, call };
}

describe("grep tool execution", () => {
  test("retains defaults and supports literal relative and external paths", async () => {
    const { root, call } = setup();
    writeFileSync(join(root, "a.txt"), "items[0]\nitems0\n");
    expect(await call({ pattern: "items", path: "." })).toBe("a.txt");
    expect(await call({ pattern: "items[0]", path: "a.txt", literal: true, output_mode: "content" })).toBe("a.txt:1:items[0]");
    expect(await call({ pattern: "items[0]", literal: false, output_mode: "content" })).toBe("a.txt:2:items0");
    const external = join(temporaryRoot(), "outside.txt");
    writeFileSync(external, "items[0]\n");
    expect((await call({ pattern: "items[0]", literal: true, path: external })).replaceAll("\\", "/"))
      .toBe(external.replaceAll("\\", "/"));
  });
  test("validates before path access, keeps errors, and honors cancellation", async () => {
    const { call, controller } = setup();
    await expect(call({ pattern: "x", path: "missing", head_limit: "2" })).rejects.toThrow("head_limit");
    await expect(call({ pattern: "x", path: "missing", extra: true })).rejects.toThrow("extra");
    await expect(call({ pattern: "a\nb", literal: true, path: "missing" })).rejects.toThrow("multiline=true");
    await expect(call({ pattern: "x", path: "missing" })).rejects.toMatchObject({ code: "ENOENT" });
    controller.abort();
    await expect(call({ pattern: "x" })).rejects.toThrow("Turn cancelled");
  });
});

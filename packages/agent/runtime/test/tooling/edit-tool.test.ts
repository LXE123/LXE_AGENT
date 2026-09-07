import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelImageProcessor } from "../../src/providers/model-image";
import { createFileTools } from "../../src/tooling/coding/file-tools";
import { FileVersionLedger } from "../../src/tooling/coding/file-version-ledger";
import { CodingPathPolicy } from "../../src/tooling/coding/path-policy";
import { ToolRegistry } from "../../src/tooling/registry";
import { workspaceFor } from "../workspace";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(ledger = new FileVersionLedger()) {
  const root = mkdtempSync(join(tmpdir(), "lxe-edit-batch-"));
  roots.push(root);
  const path = join(root, "a.txt");
  writeFileSync(path, "first\nsecond\n");
  const registry = new ToolRegistry();
  for (const tool of createFileTools({ paths: new CodingPathPolicy({}), ledger, imageProcessor: new ModelImageProcessor(), toolOutputLimit: 10_000 })) registry.register(tool);
  const controller = new AbortController();
  const context = {
    session_id: "test", workspace: workspaceFor(root),
    handle: { signal: controller.signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => undefined },
  };
  return { root, path, registry, controller, context, ledger };
}

describe("edit file execution", () => {
  test("publishes only the new schema and rejects malformed arguments without writes", async () => {
    const { path, registry, context } = setup();
    const schema = registry.definition("edit")!.input_schema;
    expect(schema.required).toEqual(["path", "edits"]);
    expect(Object.keys(schema.properties as object)).toEqual(["path", "edits"]);
    await registry.execute("read", { path }, context);
    for (const input of [
      { file_path: path, old_string: "first", new_string: "FIRST" },
      { path, edits: [{ oldText: "first" }] },
      { path, edits: [{ oldText: "first", newText: false }] },
      { path, edits: [{ oldText: "first", newText: "x" }], extra: 1 },
    ]) {
      await expect(registry.execute("edit", input, context)).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
    }
  });
  test("retains read/version gates and updates the ledger after a successful batch", async () => {
    const { path, registry, context } = setup();
    const input = { path, edits: [{ oldText: "second", newText: "SECOND" }, { oldText: "first", newText: "FIRST" }] };
    await expect(registry.execute("edit", input, context)).rejects.toThrow("先用 read");
    await registry.execute("read", { path }, context);
    const result = await registry.execute("edit", input, context);
    expect(result.content[0]?.text).toContain("2 replacement(s)");
    expect(result.content[0]?.text).toContain("-1 first");
    expect(readFileSync(path, "utf8")).toBe("FIRST\nSECOND\n");
    await registry.execute("edit", { path, edits: [{ oldText: "FIRST", newText: "next" }] }, context);
    writeFileSync(path, "external modification\n");
    await expect(registry.execute("edit", { path, edits: [{ oldText: "external", newText: "lost" }] }, context)).rejects.toThrow("重新 read");
    expect(readFileSync(path, "utf8")).toBe("external modification\n");
  });
  test("any failed item leaves the entire file unchanged", async () => {
    const { path, registry, context } = setup();
    await registry.execute("read", { path }, context);
    for (const edits of [
      [{ oldText: "first", newText: "FIRST" }, { oldText: "missing", newText: "x" }],
      [{ oldText: "first", newText: "FIRST" }, { oldText: "irst", newText: "x" }],
      [{ oldText: "first", newText: "first" }],
    ]) {
      await expect(registry.execute("edit", { path, edits }, context)).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
    }
  });
  test("rechecks the version immediately before writing", async () => {
    class ChangingLedger extends FileVersionLedger {
      checks = 0;
      override assertCurrent(session: string, path: string, action: string): void {
        if (++this.checks === 2) writeFileSync(path, "external write before commit");
        super.assertCurrent(session, path, action);
      }
    }
    const { path, registry, context } = setup(new ChangingLedger());
    await registry.execute("read", { path }, context);
    await expect(registry.execute("edit", { path, edits: [{ oldText: "first", newText: "FIRST" }] }, context)).rejects.toThrow("重新 read");
    expect(readFileSync(path, "utf8")).toBe("external write before commit");
  });
  test("observes cancellation before writing even after preparation", async () => {
    let cancel: () => void = () => {};
    class CancellingLedger extends FileVersionLedger {
      checks = 0;
      override assertCurrent(session: string, path: string, action: string): void {
        super.assertCurrent(session, path, action);
        if (++this.checks === 2) cancel();
      }
    }
    const { path, registry, context, controller } = setup(new CancellingLedger());
    cancel = () => controller.abort(new Error("cancel before write"));
    await registry.execute("read", { path }, context);
    await expect(registry.execute("edit", { path, edits: [{ oldText: "first", newText: "FIRST" }] }, context)).rejects.toThrow("cancel before write");
    expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
  });
  test("retains actual filesystem errors", async () => {
    const { root, registry, context } = setup();
    await expect(registry.execute("edit", { path: join(root, "missing.txt"), edits: [{ oldText: "x", newText: "y" }] }, context))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
  test("preserves BOM and CRLF and returns a bounded normalized diff", async () => {
    const { path, registry, context } = setup();
    writeFileSync(path, "\uFEFFbefore  \r\n‘change’  \r\nafter  \r\n");
    await registry.execute("read", { path }, context);
    const result = await registry.execute("edit", { path, edits: [{ oldText: "'change'", newText: "x".repeat(20_000) }] }, context);
    expect(readFileSync(path, "utf8")).toBe("\uFEFFbefore  \r\n" + "x".repeat(20_000) + "\r\nafter  \r\n");
    const text = String(result.content[0]?.text);
    expect(text).toContain("Normalized matching used");
    expect(text).toContain("summary truncated");
    expect(text.length).toBeLessThanOrEqual(10_000);
  });
});

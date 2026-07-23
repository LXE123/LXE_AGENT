import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentFileVersion,
  FileVersionLedger,
} from "../../src/tooling/coding/file-version-ledger";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FileVersionLedger", () => {
  test("requires the same session to record the current file version", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-ledger-"));
    roots.push(root);
    const path = join(root, "document.txt");
    writeFileSync(path, "v1\n");
    const ledger = new FileVersionLedger();

    expect(() => ledger.assertCurrent("session-a", path, "edit")).toThrow("先用 read");
    ledger.recordCurrent("session-a", path);
    expect(() => ledger.assertCurrent("session-a", path, "edit")).not.toThrow();
    expect(() => ledger.assertCurrent("session-b", path, "edit")).toThrow("先用 read");

    writeFileSync(path, "externally changed\n");
    expect(() => ledger.assertCurrent("session-a", path, "write")).toThrow("重新 read");
  });

  test("detects rename/recreate and does not record a missing new file", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-ledger-recreate-"));
    roots.push(root);
    const path = join(root, "document.txt");
    const replacement = join(root, "replacement.txt");
    writeFileSync(path, "same size\n");
    const ledger = new FileVersionLedger();
    ledger.recordCurrent("session", path);
    writeFileSync(replacement, "same size\n");
    renameSync(replacement, path);
    expect(() => ledger.assertCurrent("session", path, "edit")).toThrow("重新 read");

    const newPath = join(root, "new.txt");
    expect(currentFileVersion(newPath)).toBeUndefined();
    ledger.recordCurrent("session", newPath);
    expect(() => ledger.assertCurrent("session", newPath, "write")).toThrow("先用 read");
  });

  test("evicts the oldest entry after reaching its capacity", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-ledger-capacity-"));
    roots.push(root);
    const paths = ["one.txt", "two.txt", "three.txt"].map((name) => join(root, name));
    for (const path of paths) writeFileSync(path, `${path}\n`);
    const ledger = new FileVersionLedger(2);
    for (const path of paths) ledger.recordCurrent("session", path);

    expect(() => ledger.assertCurrent("session", paths[0]!, "edit")).toThrow("先用 read");
    expect(() => ledger.assertCurrent("session", paths[1]!, "edit")).not.toThrow();
    expect(() => ledger.assertCurrent("session", paths[2]!, "edit")).not.toThrow();
  });
});

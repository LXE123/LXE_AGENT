import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyArtifacts } from "../src/main/migration";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy desktop migration", () => {
  test("imports only missing artifacts and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-migration-"));
    roots.push(root);
    const legacyRoot = join(root, "legacy");
    const dataRoot = join(root, "data");
    mkdirSync(join(legacyRoot, "artifacts", "reports"), { recursive: true });
    mkdirSync(join(dataRoot, "artifacts", "reports"), { recursive: true });
    writeFileSync(join(legacyRoot, "artifacts", "reports", "new.txt"), "new", "utf8");
    writeFileSync(join(legacyRoot, "artifacts", "reports", "existing.txt"), "legacy", "utf8");
    writeFileSync(join(dataRoot, "artifacts", "reports", "existing.txt"), "desktop", "utf8");
    writeFileSync(join(legacyRoot, "credentials.json"), "do-not-copy", "utf8");

    const first = migrateLegacyArtifacts({ legacyRoot, dataRoot });
    const second = migrateLegacyArtifacts({ legacyRoot, dataRoot });

    expect(first.copied).toEqual(["reports/new.txt"]);
    expect(first.skipped).toEqual(["reports/existing.txt"]);
    expect(second).toEqual(first);
    expect(readFileSync(join(dataRoot, "artifacts", "reports", "existing.txt"), "utf8")).toBe("desktop");
    expect(readFileSync(join(dataRoot, "artifacts", "reports", "new.txt"), "utf8")).toBe("new");
    expect(() => readFileSync(join(dataRoot, "credentials.json"), "utf8")).toThrow();
  });
});

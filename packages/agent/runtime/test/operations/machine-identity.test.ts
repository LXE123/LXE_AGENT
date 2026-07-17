import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMachineIdentity } from "../../src/operations/machine-identity";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("machine identity", () => {
  test("creates one stable identity shared by activation and snapshot uploads", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-machine-identity-"));
    roots.push(root);
    const path = join(root, "db", "machine_identity.json");
    const first = resolveMachineIdentity(path);
    const second = resolveMachineIdentity(path);
    expect(first.machine_id).toMatch(/^[a-f0-9]{32}$/u);
    expect(second).toEqual(first);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
  });

  test("keeps an identity published by another process during first creation", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-machine-identity-race-"));
    roots.push(root);
    const path = join(root, "machine_identity.json");
    writeFileSync(path, JSON.stringify({
      machine_id: "published-by-peer",
      hostname_at_creation: "peer",
      created_at: "2026-07-17T00:00:00.000Z",
    }));

    expect(resolveMachineIdentity(path).machine_id).toBe("published-by-peer");
  });
});

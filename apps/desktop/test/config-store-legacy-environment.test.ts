import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopConfigStore } from "../src/main/config-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value: Buffer) => value.toString("utf8").slice("encrypted:".length),
};

describe("legacy desktop environment migration", () => {
  test("keeps migration incomplete until plaintext cleanup succeeds and then retries", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-config-legacy-retry-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const managedFile = join(root, ".env.local");
    writeFileSync(managedFile, "MABANG_ACCOUNT=account\nMABANG_PASSWORD=plain-secret\nUNCHANGED=value\n");
    const blockedTemporary = `${managedFile}.${process.pid}.tmp`;
    mkdirSync(blockedTemporary);
    const store = new DesktopConfigStore(root, workspace, safeStorage);
    const options = {
      environment: { MABANG_ACCOUNT: "account", MABANG_PASSWORD: "plain-secret" },
      managedFiles: [managedFile],
    };

    expect(() => store.migrateLegacyEnvironment(options)).toThrow();
    expect(store.state()).toMatchObject({
      legacy_environment_imported: false,
      mabang: { managed: true, configured: true, password_configured: true },
    });
    expect(readFileSync(managedFile, "utf8")).toContain("MABANG_PASSWORD=plain-secret");

    rmSync(blockedTemporary, { recursive: true });
    expect(store.migrateLegacyEnvironment(options)).toMatchObject({
      legacy_environment_imported: true,
      mabang: { configured: true },
    });
    const cleaned = readFileSync(managedFile, "utf8");
    expect(cleaned).toContain("MABANG_ACCOUNT=account");
    expect(cleaned).toContain("UNCHANGED=value");
    expect(cleaned).not.toContain("MABANG_PASSWORD");
  });
});

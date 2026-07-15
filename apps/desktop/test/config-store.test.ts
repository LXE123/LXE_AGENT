import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("DesktopConfigStore", () => {
  test("keeps secrets out of desktop.json and never returns them in setup state", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-config-"));
    roots.push(root);
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    const state = store.save({
      provider: "kimi_coding",
      api_key: "model-secret",
      workspace_root: join(root, "workspace"),
      feishu_app_id: "cli_1234567890",
      feishu_app_secret: "feishu-secret",
    });

    expect(state).toMatchObject({
      complete: true,
      provider_key_configured: true,
      feishu_configured: true,
    });
    expect(JSON.stringify(state)).not.toContain("model-secret");
    expect(JSON.stringify(state)).not.toContain("feishu-secret");
    expect(readFileSync(join(root, "config", "desktop.json"), "utf8")).not.toContain("secret");
    expect(store.environment()).toMatchObject({
      KIMI_CODE_API_KEY: "model-secret",
      FEISHU_APP_SECRET: "feishu-secret",
    });
  });

  test("fails closed when operating-system encryption is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-config-"));
    roots.push(root);
    const store = new DesktopConfigStore(root, join(root, "workspace"), {
      ...safeStorage,
      isEncryptionAvailable: () => false,
    });
    expect(() => store.save({
      provider: "glm",
      api_key: "secret",
      workspace_root: join(root, "workspace"),
    })).toThrow("Secure credential storage is unavailable");
    expect(existsSync(join(root, "config", "desktop.json"))).toBe(false);
  });
});

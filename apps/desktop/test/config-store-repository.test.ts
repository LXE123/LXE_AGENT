import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneConfig,
  cloneSecrets,
} from "../src/main/config-store/model";
import { DesktopConfigRepository } from "../src/main/config-store/repository";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-config-repository-"));
  roots.push(root);
  return root;
};

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value: Buffer) => value.toString("utf8").slice("encrypted:".length),
};

describe("DesktopConfigRepository", () => {
  test("returns defaults and normalizes the legacy persisted schema", () => {
    const root = createRoot();
    const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(repository.hadExistingConfig).toBeFalse();
    expect(repository.readConfig()).toMatchObject({
      schema_version: 3,
      migration_version: 0,
      provider: "kimi_coding",
      logging: { profile: "standard", retention_days: 7 },
      cloud: { tunnel_name: "lxe-agent" },
    });
    expect(repository.readSecrets()).toEqual(cloneSecrets());

    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "desktop.json"), JSON.stringify({
      provider: "unknown",
      migration_version: -5,
      feishu_app_id: "legacy-app-id",
      integrations: {},
      logging: { profile: "unknown", retention_days: 999 },
      cloud: { sync_interval_seconds: 1 },
    }));
    expect(repository.readConfig()).toMatchObject({
      schema_version: 3,
      migration_version: 0,
      provider: "kimi_coding",
      integrations: { feishu: { managed: true, app_id: "legacy-app-id" } },
      logging: { profile: "standard", retention_days: 7 },
      cloud: { tunnel_name: "lxe-agent" },
    });
  });

  test("keeps every secret encrypted and fails closed without secure storage", () => {
    const root = createRoot();
    const opaqueStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "ascii"),
      decryptString: (value: Buffer) => Buffer.from(String(value), "base64").toString("utf8"),
    };
    const repository = new DesktopConfigRepository(root, opaqueStorage, "win32");
    const config = cloneConfig();
    const secrets = cloneSecrets();
    secrets.provider_keys.glm = "provider-secret";
    secrets.ziniao_password = "ziniao-secret";
    secrets.mabang_password = "mabang-secret";
    secrets.feishu_app_secret = "feishu-secret";
    secrets.data_server_api_key = "upload-secret";
    secrets.erp_api_key = "erp-secret";
    repository.commit(config, secrets);

    const publicConfig = readFileSync(join(root, "config", "desktop.json"), "utf8");
    const encryptedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    for (const secret of [
      "provider-secret",
      "ziniao-secret",
      "mabang-secret",
      "feishu-secret",
      "upload-secret",
      "erp-secret",
    ]) {
      expect(publicConfig).not.toContain(secret);
      expect(encryptedSecrets).not.toContain(`\"${secret}\"`);
    }
    expect(repository.readSecrets()).toMatchObject(secrets);

    const unavailable = new DesktopConfigRepository(root, {
      ...opaqueStorage,
      isEncryptionAvailable: () => false,
    }, "win32");
    expect(() => unavailable.readSecrets()).toThrow("Secure credential storage is unavailable");
    expect(() => unavailable.commit(cloneConfig(), cloneSecrets())).toThrow("Secure credential storage is unavailable");
  });

  test("restores both files when secret or public configuration persistence fails", () => {
    const root = createRoot();
    let encryptionFails = false;
    const repository = new DesktopConfigRepository(root, {
      ...safeStorage,
      encryptString: (value) => {
        if (encryptionFails) throw new Error("encryption failed");
        return safeStorage.encryptString(value);
      },
    }, "win32");
    const originalConfig = cloneConfig();
    const originalSecrets = cloneSecrets();
    originalSecrets.provider_keys.glm = "original-secret";
    repository.commit(originalConfig, originalSecrets);
    const configPath = join(root, "config", "desktop.json");
    const secretsPath = join(root, "config", "secrets.bin");
    const beforeConfig = readFileSync(configPath);
    const beforeSecrets = readFileSync(secretsPath);

    const changedConfig = cloneConfig();
    changedConfig.provider = "glm";
    const changedSecrets = cloneSecrets();
    changedSecrets.provider_keys.glm = "changed-secret";
    encryptionFails = true;
    expect(() => repository.commit(changedConfig, changedSecrets)).toThrow("encryption failed");
    expect(readFileSync(configPath)).toEqual(beforeConfig);
    expect(readFileSync(secretsPath)).toEqual(beforeSecrets);

    encryptionFails = false;
    mkdirSync(`${configPath}.${process.pid}.tmp`);
    expect(() => repository.commit(changedConfig, changedSecrets)).toThrow();
    expect(readFileSync(configPath)).toEqual(beforeConfig);
    expect(readFileSync(secretsPath)).toEqual(beforeSecrets);
    expect(existsSync(configPath)).toBeTrue();
    expect(existsSync(secretsPath)).toBeTrue();
  });
});

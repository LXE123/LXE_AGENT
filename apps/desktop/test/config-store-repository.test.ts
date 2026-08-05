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

const managedCredential = (apiKey: string) => ({
  provider: "deepseek" as const,
  model: "deepseek-v4-flash" as const,
  api_key: apiKey,
  credential_revision: "a".repeat(64),
  fetched_at: 1,
  invalid_revision: "",
});

describe("DesktopConfigRepository", () => {
  test("returns defaults and normalizes the legacy persisted schema", () => {
    const root = createRoot();
    const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(repository.hadExistingConfig).toBeFalse();
    expect(repository.readConfig()).toMatchObject({
      schema_version: 5,
      migration_version: 0,
      llm: {
        provider: "deepseek",
        profiles: { deepseek: { model: "deepseek-v4-flash", thinking_level: "low" } },
      },
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
      schema_version: 5,
      migration_version: 0,
      llm: {
        provider: "deepseek",
        profiles: { deepseek: { model: "deepseek-v4-flash", thinking_level: "low" } },
      },
      integrations: { feishu: { managed: true, app_id: "legacy-app-id" } },
      logging: { profile: "standard", retention_days: 7 },
      cloud: { tunnel_name: "lxe-agent" },
    });
    expect(existsSync(join(root, "config", "settings.json"))).toBeTrue();
    expect(existsSync(join(root, "config", "desktop.json.migrated-v3.bak"))).toBeTrue();
  });

  test("migrates schema 4 model settings to local credential-source defaults", () => {
    const root = createRoot();
    const legacy = structuredClone(cloneConfig()) as unknown as Record<string, unknown>;
    legacy.schema_version = 4;
    const llm = legacy.llm as Record<string, unknown>;
    delete llm.credential_source;
    delete llm.last_local_provider;
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "settings.json"), JSON.stringify(legacy));

    const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(repository.readConfig()).toMatchObject({
      schema_version: 5,
      llm: {
        provider: "deepseek",
        credential_source: "local",
        last_local_provider: "deepseek",
      },
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
    secrets.managed_llm_credential = managedCredential("provider-secret");
    secrets.ziniao_password = "ziniao-secret";
    secrets.mabang_password = "mabang-secret";
    secrets.feishu_app_secret = "feishu-secret";
    secrets.data_server_api_key = "upload-secret";
    secrets.erp_api_key = "erp-secret";
    secrets.saihu_mcp_api_key = "saihu-mcp-secret";
    repository.commit(config, secrets);

    const publicConfig = readFileSync(join(root, "config", "settings.json"), "utf8");
    const encryptedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    for (const secret of [
      "provider-secret",
      "ziniao-secret",
      "mabang-secret",
      "feishu-secret",
      "upload-secret",
      "erp-secret",
      "saihu-mcp-secret",
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
    originalSecrets.managed_llm_credential = managedCredential("original-secret");
    repository.commit(originalConfig, originalSecrets);
    const configPath = join(root, "config", "settings.json");
    const secretsPath = join(root, "config", "secrets.bin");
    const beforeConfig = readFileSync(configPath);
    const beforeSecrets = readFileSync(secretsPath);

    const changedConfig = cloneConfig();
    changedConfig.llm.provider = "glm";
    const changedSecrets = cloneSecrets();
    changedSecrets.managed_llm_credential = managedCredential("changed-secret");
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

  test("rejects invalid or secret-bearing settings without overwriting them", () => {
    const root = createRoot();
    const configRoot = join(root, "config");
    mkdirSync(configRoot, { recursive: true });
    const settingsPath = join(configRoot, "settings.json");
    writeFileSync(settingsPath, "{ invalid json", "utf8");
    const invalidJson = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(() => invalidJson.readConfig()).toThrow();
    expect(readFileSync(settingsPath, "utf8")).toBe("{ invalid json");

    const secretBearing = { ...cloneConfig(), api_key: "must-not-be-public" };
    writeFileSync(settingsPath, JSON.stringify(secretBearing), "utf8");
    const invalidSecret = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(() => invalidSecret.readConfig()).toThrow("settings contains a secret field");
    expect(readFileSync(settingsPath, "utf8")).toContain("must-not-be-public");

    const invalidOutputDirectory = cloneConfig() as unknown as Record<string, unknown>;
    invalidOutputDirectory.output_directories = { MABANG_STOCK_SKU_EXPORT_DIR: 42 };
    writeFileSync(settingsPath, JSON.stringify(invalidOutputDirectory), "utf8");
    const invalidOutput = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(() => invalidOutput.readConfig())
      .toThrow("settings.output_directories.MABANG_STOCK_SKU_EXPORT_DIR must be a string");

    const unknownSetting = { ...cloneConfig(), workspace_rooot: "/typo" };
    writeFileSync(settingsPath, JSON.stringify(unknownSetting), "utf8");
    const invalidUnknown = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(() => invalidUnknown.readConfig())
      .toThrow("settings.workspace_rooot is not a supported setting");
  });

  test("refuses to overwrite settings changed outside the repository", () => {
    const root = createRoot();
    const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
    const config = repository.readConfig();
    repository.commit(config, repository.readSecrets());
    const settingsPath = join(root, "config", "settings.json");
    const external = cloneConfig();
    external.workspace_root = "/external-edit";
    writeFileSync(settingsPath, `${JSON.stringify(external, null, 2)}\n`, "utf8");

    config.workspace_root = "/in-process-edit";
    expect(() => repository.commit(config, repository.readSecrets())).toThrow("changed outside LXE Agent");
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).workspace_root).toBe("/external-edit");
  });

  test("refuses a concurrent write while the settings lock is active", () => {
    const root = createRoot();
    const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
    const config = repository.readConfig();
    repository.commit(config, repository.readSecrets());
    writeFileSync(join(root, "config", "settings.lock"), "active", "utf8");

    config.workspace_root = "/concurrent-edit";
    expect(() => repository.commit(config, repository.readSecrets()))
      .toThrow("settings.json is being updated by another process");
    expect(JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")).workspace_root)
      .toBe("");
  });
});

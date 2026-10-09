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
      schema_version: 12,
      migration_version: 0,
      llm: {
        provider: "deepseek",
        profiles: { deepseek: { model: "deepseek-v4-flash", thinking_level: "low" } },
      },
      logging: { profile: "standard", retention_days: 7 },
      cloud: { tunnel_name: "lxe-agent", switch_in_progress: false },
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
      schema_version: 12,
      migration_version: 0,
      llm: {
        provider: "deepseek",
        profiles: { deepseek: { model: "deepseek-v4-flash", thinking_level: "low" } },
      },
      integrations: { feishu: { managed: true, app_id: "legacy-app-id" } },
      logging: { profile: "standard", retention_days: 7 },
      cloud: { tunnel_name: "lxe-agent", switch_in_progress: false },
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
      schema_version: 12,
      llm: {
        provider: "deepseek",
        credential_source: "local",
        last_local_provider: "deepseek",
      },
    });
  });

  test("migrates schema 5 cloud settings to an idle switch state", () => {
    const root = createRoot();
    const legacy = structuredClone(cloneConfig()) as unknown as Record<string, unknown>;
    legacy.schema_version = 5;
    delete (legacy.cloud as Record<string, unknown>).switch_in_progress;
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "settings.json"), JSON.stringify(legacy));

    const repository = new DesktopConfigRepository(root, safeStorage, "win32");
    expect(repository.readConfig()).toMatchObject({
      schema_version: 12,
      cloud: { switch_in_progress: false },
    });
  });

  test("migrates schema 7 profiles to schema 10 without losing provider preferences", () => {
    const root = createRoot();
    const legacy = structuredClone(cloneConfig()) as unknown as Record<string, unknown>;
    legacy.schema_version = 7;
    const llm = legacy.llm as Record<string, unknown>;
    llm.provider = "kimi_coding";
    llm.last_local_provider = "kimi_coding";
    llm.profiles = {
      deepseek: { model: "deepseek-v4-pro", thinking_level: "max" },
      kimi_coding: { model: "k3", thinking_level: "high" },
    };
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "settings.json"), JSON.stringify(legacy));

    const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(repository.readConfig()).toMatchObject({
      schema_version: 12,
      llm: {
        provider: "kimi_coding",
        last_local_provider: "kimi_coding",
        profiles: {
          deepseek: { model: "deepseek-v4-pro", thinking_level: "max" },
          kimi_coding: { model: "k3", thinking_level: "high" },
        },
      },
    });
  });

  test("migrates schema 11 without Vietnam settings and rejects malformed schema 12 without rewriting", () => {
    const root = createRoot();
    const configRoot = join(root, "config");
    mkdirSync(configRoot, { recursive: true });
    const settingsPath = join(configRoot, "settings.json");
    const old = structuredClone(cloneConfig()) as unknown as Record<string, unknown>;
    old.schema_version = 11;
    delete old.vietnam_recommendation;
    writeFileSync(settingsPath, JSON.stringify(old), "utf8");
    const migrated = new DesktopConfigRepository(root, safeStorage, "darwin").readConfig();
    expect(migrated.schema_version).toBe(12);
    expect(migrated.vietnam_recommendation).toEqual({
      weight_30d: "0.8", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900",
    });

    const cases: [string, unknown][] = [
      ["missing object", undefined],
      ["missing field", { weight_30d: "0.8", weight_15d: "0.8", weight_7d: "0" }],
      ["extra field", { weight_30d: "0.8", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900", note: "x" }],
      ["number field", { weight_30d: 0.8, weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900" }],
      ["not a number", { weight_30d: "NaN", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900" }],
      ["infinite", { weight_30d: "Infinity", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900" }],
      ["negative weight", { weight_30d: "-0.1", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900" }],
      ["zero exchange", { weight_30d: "0.8", weight_15d: "0.8", weight_7d: "0", exchange_rate: "0" }],
      ["too precise", { weight_30d: "0.1234567890123456", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900" }],
      ["float round trip", { weight_30d: "1.23456789012345e-310", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900" }],
      ["underflow", { weight_30d: "1e-10000", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900" }],
      ["overflow", { weight_30d: "1e10000", weight_15d: "0.8", weight_7d: "0", exchange_rate: "3900" }],
    ];
    for (const [label, candidate] of cases) {
      const raw = { ...cloneConfig() } as Record<string, unknown>;
      if (candidate === undefined) delete raw.vietnam_recommendation;
      else raw.vietnam_recommendation = candidate;
      const content = JSON.stringify(raw);
      writeFileSync(settingsPath, content, "utf8");
      const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
      expect(() => repository.readConfig(), label).toThrow();
      expect(readFileSync(settingsPath, "utf8"), label).toBe(content);
    }
  });

  test("rejects invalid Vietnam settings before writing either config file", () => {
    const root = createRoot();
    const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
    repository.commit(cloneConfig(), cloneSecrets());
    const configPath = join(root, "config", "settings.json");
    const secretsPath = join(root, "config", "secrets.bin");
    const beforeConfig = readFileSync(configPath);
    const beforeSecrets = readFileSync(secretsPath);
    const invalid = cloneConfig() as unknown as Record<string, unknown>;
    invalid.vietnam_recommendation = {
      weight_30d: "0.8", weight_15d: "0.8", weight_7d: "0", exchange_rate: "0",
    };
    expect(() => repository.commit(invalid as unknown as ReturnType<typeof cloneConfig>, cloneSecrets())).toThrow();
    expect(readFileSync(configPath)).toEqual(beforeConfig);
    expect(readFileSync(secretsPath)).toEqual(beforeSecrets);
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
    secrets.data_server_api_key = "device-identity-secret";
    repository.commit(config, secrets);

    const publicConfig = readFileSync(join(root, "config", "settings.json"), "utf8");
    const encryptedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    for (const secret of [
      "provider-secret",
      "ziniao-secret",
      "mabang-secret",
      "feishu-secret",
      "device-identity-secret",
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
    changedConfig.llm.provider = "kimi_coding";
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

    const missingSwitchMarker = cloneConfig() as unknown as Record<string, unknown>;
    delete (missingSwitchMarker.cloud as Record<string, unknown>).switch_in_progress;
    writeFileSync(settingsPath, JSON.stringify(missingSwitchMarker), "utf8");
    const invalidSwitchMarker = new DesktopConfigRepository(root, safeStorage, "darwin");
    expect(() => invalidSwitchMarker.readConfig())
      .toThrow("settings.cloud.switch_in_progress must be a boolean");

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

for (const expiresAt of [1, 4_000_000_000]) {
  test(`discards obsolete business secrets without reenrollment (expiry ${expiresAt})`, () => {
    const root = createRoot();
    const repository = new DesktopConfigRepository(root, safeStorage, "darwin");
    const config = cloneConfig();
    config.cloud.managed = true;
    config.cloud.device_id = "existing-device";
    repository.commit(config, cloneSecrets());
    const path = join(root, "config/secrets.bin");
    const legacy = { ...cloneSecrets(), data_server_api_key: "device-identity",
      cloud_business_token: "obsolete-business", cloud_business_erp_token: "obsolete-erp",
      cloud_business_expires_at: expiresAt, erp_api_key: "obsolete-erp-key", saihu_mcp_api_key: "obsolete-mcp-key" };
    writeFileSync(path, safeStorage.encryptString(JSON.stringify(legacy)));
    const current = repository.readSecrets();
    expect(current.data_server_api_key).toBe("device-identity");
    expect(JSON.stringify(current)).not.toContain("obsolete-");
    repository.commit(repository.readConfig(), current);
    expect(safeStorage.decryptString(readFileSync(path))).not.toContain("cloud_business_");
    expect(safeStorage.decryptString(readFileSync(path))).not.toContain("obsolete-");
    expect(repository.readConfig().cloud.device_id).toBe("existing-device");
    expect(repository.readConfig().schema_version).toBe(12);
  });
}

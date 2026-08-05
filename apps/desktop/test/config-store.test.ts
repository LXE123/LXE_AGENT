import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopConfigStore } from "../src/main/config-store";
import { cloneConfig } from "../src/main/config-store/model";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value: Buffer) => value.toString("utf8").slice("encrypted:".length),
};

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-desktop-config-"));
  mkdirSync(join(root, "workspace"));
  roots.push(root);
  return root;
};

describe("DesktopConfigStore", () => {
  test("keeps every secret encrypted and maps complete integrations and diagnostic logs", () => {
    const root = createRoot();
    const appPath = join(root, "ziniao.exe");
    writeFileSync(appPath, "binary");
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    store.saveLocalModelCredential({ provider: "kimi_coding", api_key: "model-secret" });
    const state = store.save({
      workspace_root: join(root, "workspace"),
      ziniao: {
        action: "save",
        company: "LXE",
        username: "ziniao-user",
        password: "ziniao-secret",
        app_version: "v6",
        app_path: appPath,
        webdriver_path: join(root, "drivers"),
      },
      mabang: { action: "save", account: "mabang-user", password: "mabang-secret" },
      feishu: { action: "save", app_id: "cli_1234567890", app_secret: "feishu-secret" },
      logging: { profile: "diagnostic", retention_days: 14 },
    });

    expect(state).toMatchObject({
      complete: true,
      provider: "kimi_coding",
      credential_source: "local",
      local_model_credentials: { kimi_coding: true },
      ziniao: { configured: true, password_configured: true },
      mabang: { configured: true, password_configured: true },
      feishu: { configured: true, app_secret_configured: true },
      logging: { profile: "diagnostic", retention_days: 14 },
    });
    expect(state.logging.directory).toBe(join(root, "logs"));
    const serializedState = JSON.stringify(state);
    for (const secret of ["model-secret", "ziniao-secret", "mabang-secret", "feishu-secret"]) {
      expect(serializedState).not.toContain(secret);
      expect(readFileSync(join(root, "config", "settings.json"), "utf8")).not.toContain(secret);
    }
    const environment = store.environment();
    expect(environment).toMatchObject({
      ZINIAO_REGISTER_PLANNER_TOOLS: "1",
      ZINIAO_PASSWORD: "ziniao-secret",
      MABANG_PASSWORD: "mabang-secret",
      LXE_FEISHU_GATEWAY_ENABLED: "1",
      FEISHU_APP_SECRET: "feishu-secret",
      LOCAL_LOGS_ENABLED: "1",
      RUNTIME_LOG_LEVEL: "DEBUG",
      AGENT_SSE_WIRE_TRACE_ENABLED: "1",
      FEISHU_RAW_EVENT_DUMP_ENABLED: "1",
    });
    expect(environment).not.toHaveProperty("KIMI_CODE_API_KEY");
    expect(environment).not.toHaveProperty("AGENT_STREAM_TRACE_ENABLED");
    expect(environment).not.toHaveProperty("AGENT_STREAM_TRACE_DIR");
  });

  test("uses source-development integration secrets without accepting model keys from the environment", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, {
      platform: "darwin",
      secretEnvironment: {
        KIMI_CODE_API_KEY: "source-model-secret",
        DEEPSEEK_API: "source-deepseek-secret",
        MABANG_PASSWORD: "source-mabang-secret",
        FEISHU_APP_SECRET: "source-feishu-secret",
        LXE_SAIHU_MCP_API_KEY: "source-saihu-secret",
      },
    });

    expect(store.state()).toMatchObject({ complete: false, managed_model_configured: false });
    expect(store.environment()).not.toHaveProperty("KIMI_CODE_API_KEY");
    expect(store.environment()).not.toHaveProperty("DEEPSEEK_API");
    store.saveLocalModelCredential({ provider: "kimi_coding", api_key: "local-model-secret" });
    expect(store.environment()).toMatchObject({
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_THINKING_ENABLED: "1",
      AGENT_LLM_THINKING_EFFORT: "low",
    });
    expect(store.save({
      workspace_root: join(root, "workspace"),
      mabang: { action: "save", account: "source-account" },
      feishu: { action: "save", app_id: "source-app-id" },
    })).toMatchObject({
      complete: true,
      mabang: { configured: true, password_configured: true },
      feishu: { configured: true, app_secret_configured: true },
    });
    expect(store.environment()).toMatchObject({
      MABANG_PASSWORD: "source-mabang-secret",
      FEISHU_APP_SECRET: "source-feishu-secret",
      LXE_SAIHU_MCP_API_KEY: "source-saihu-secret",
    });
    expect(store.environment()).not.toHaveProperty("KIMI_CODE_API_KEY");
    store.saveRuntimePreference("kimi_coding", "k3", "high");
    const persistedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    expect(readFileSync(join(root, "config", "auth.json"), "utf8")).toContain("local-model-secret");
    expect(persistedSecrets).not.toContain("source-mabang-secret");
    expect(persistedSecrets).not.toContain("source-feishu-secret");
    expect(persistedSecrets).not.toContain("source-saihu-secret");
  });

  test("preserves blank secret patches and explicitly clears an integration", () => {
    const root = createRoot();
    const appPath = join(root, "ziniao.exe");
    writeFileSync(appPath, "binary");
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    store.saveLocalModelCredential({ provider: "glm", api_key: "model-secret" });
    store.save({
      workspace_root: join(root, "workspace"),
      mabang: { action: "save", account: "first", password: "mabang-secret" },
    });
    expect(store.save({
      workspace_root: join(root, "workspace"),
      mabang: { action: "save", account: "second" },
    }).mabang.configured).toBe(true);
    const cleared = store.save({
      workspace_root: join(root, "workspace"),
      mabang: { action: "clear" },
    });
    expect(cleared.mabang).toMatchObject({ managed: true, configured: false, password_configured: false });
    expect(store.environment()).toMatchObject({ MABANG_ACCOUNT: "", MABANG_PASSWORD: "" });
    expect(() => store.save({
      workspace_root: join(root, "workspace"),
      ziniao: {
        action: "save",
        company: "LXE",
        username: "",
        app_version: "v6",
        app_path: appPath,
        webdriver_path: join(root, "drivers"),
      },
    })).toThrow("紫鸟配置缺少");
  });

  test("retires legacy model credentials and dotenv files before startup", () => {
    const root = createRoot();
    const configRoot = join(root, "config");
    mkdirSync(configRoot, { recursive: true });
    const legacyConfig = cloneConfig();
    legacyConfig.migration_version = 3;
    legacyConfig.llm.provider = "glm";
    legacyConfig.llm.credential_source = "local";
    legacyConfig.llm.last_local_provider = "glm";
    writeFileSync(join(configRoot, "settings.json"), JSON.stringify(legacyConfig));
    writeFileSync(join(configRoot, "secrets.bin"), safeStorage.encryptString(JSON.stringify({
      provider_keys: { glm: "retired-secret" },
      managed_llm_credential: null,
    })));
    writeFileSync(join(root, ".env"), "GLM_API_KEY=retired-env-secret\n");
    writeFileSync(join(root, ".env.local"), "AGENT_LLM_PROVIDER=glm\n");

    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);

    expect(store.state()).toMatchObject({
      complete: false,
      provider: "deepseek",
      credential_source: "cloud",
      managed_model_configured: false,
      local_model_credentials: { kimi_coding: false, deepseek: false, glm: false },
    });
    expect(existsSync(join(root, ".env"))).toBeFalse();
    expect(existsSync(join(root, ".env.local"))).toBeFalse();
    expect(readFileSync(join(configRoot, "settings.json"), "utf8")).not.toContain("glm");
    expect(readFileSync(join(configRoot, "secrets.bin"), "utf8")).not.toContain("retired-secret");
  });

  test("uses standard logging for a new install and validates platform app paths", () => {
    const root = createRoot();
    const appPath = join(root, "Ziniao.app");
    mkdirSync(appPath);
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    expect(store.state().logging).toMatchObject({ profile: "standard", retention_days: 7 });
    store.saveLocalModelCredential({ provider: "kimi_coding", api_key: "secret" });
    const state = store.save({
      workspace_root: join(root, "workspace"),
      ziniao: {
        action: "save",
        company: "LXE",
        username: "user",
        password: "secret",
        app_version: "v5",
        app_path: appPath,
        webdriver_path: join(root, "drivers"),
      },
    });
    expect(state.ziniao.app_version).toBe("v6");
  });

  test("fails closed when operating-system encryption is unavailable", () => {
    const root = createRoot();
    expect(() => new DesktopConfigStore(root, join(root, "workspace"), {
      ...safeStorage,
      isEncryptionAvailable: () => false,
    })).toThrow("Secure credential storage is unavailable");
    expect(existsSync(join(root, "config", "settings.json"))).toBe(false);
  });

  test("requires an explicitly selected workspace to already exist", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    const missing = join(root, "missing-workspace");
    store.saveLocalModelCredential({ provider: "glm", api_key: "secret" });
    expect(() => store.save({
      workspace_root: missing,
    })).toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(() => store.save({
      workspace_root: "relative-workspace",
    })).toThrow("absolute path");
  });

  test("does not report setup complete after its configured workspace is removed", () => {
    const root = createRoot();
    const workspace = join(root, "workspace");
    const canonicalWorkspace = realpathSync.native(workspace);
    const store = new DesktopConfigStore(root, workspace, safeStorage);
    store.saveLocalModelCredential({ provider: "glm", api_key: "secret" });
    expect(store.save({
      workspace_root: workspace,
    }).complete).toBeTrue();

    rmSync(workspace, { recursive: true, force: true });

    expect(store.state()).toMatchObject({
      complete: false,
      local_model_credentials: { glm: true },
      workspace_root: canonicalWorkspace,
    });
  });

  test("keeps a default-workspace-only change out of the process environment", () => {
    const root = createRoot();
    const nextWorkspace = join(root, "next-workspace");
    mkdirSync(nextWorkspace);
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    store.saveLocalModelCredential({ provider: "glm", api_key: "secret" });
    store.save({
      workspace_root: join(root, "workspace"),
    });
    const before = store.environment();
    const state = store.save({
      workspace_root: nextWorkspace,
    });
    expect(state.workspace_root).toBe(realpathSync.native(nextWorkspace));
    expect(store.environment()).toEqual(before);
    expect(store.environment()).not.toHaveProperty("LXE_WORKSPACE_ROOT");
  });

  test("persists Dashboard model preferences in settings instead of dotenv", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    store.saveLocalModelCredential({ provider: "kimi_coding", api_key: "secret" });
    store.save({
      workspace_root: join(root, "workspace"),
    });

    store.saveRuntimePreference("kimi_coding", "k3", "max");

    expect(store.environment()).toMatchObject({
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "k3",
      AGENT_LLM_THINKING_ENABLED: "1",
      AGENT_LLM_THINKING_EFFORT: "max",
      AGENT_LLM_MODEL_KIMI_CODING: "k3",
      AGENT_LLM_THINKING_EFFORT_KIMI_CODING: "max",
    });
    expect(existsSync(join(root, ".env.local"))).toBeFalse();
    expect(JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8"))).toMatchObject({
      schema_version: 6,
      llm: {
        provider: "kimi_coding",
        profiles: { kimi_coding: { model: "k3", thinking_level: "max" } },
      },
    });
  });

  test("stores cloud metadata separately from the encrypted upload token", () => {
    const root = createRoot();
    const opaqueStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "ascii"),
      decryptString: (value: Buffer) => Buffer.from(String(value), "base64").toString("utf8"),
    };
    const store = new DesktopConfigStore(root, join(root, "workspace"), opaqueStorage, { platform: "win32" });
    const cloud = store.saveCloudEnrollment({
      deviceId: "0123456789abcdef0123456789abcdef",
      deviceName: "Finance-PC-01",
      vpnIp: "10.88.0.8",
      dataServerUrl: "http://10.88.0.1:8000",
      tunnelName: "lxe-agent",
      apiKey: "lxe_dev_0123456789abcdef0123456789abcdef.secret-value",
      erpApiKey: "erp-dedicated-secret",
    });

    expect(cloud).toMatchObject({ managed: true, vpn_ip: "10.88.0.8", api_key_configured: true });
    const publicConfig = readFileSync(join(root, "config", "settings.json"), "utf8");
    expect(publicConfig).toContain("Finance-PC-01");
    expect(publicConfig).not.toContain("secret-value");
    expect(publicConfig).not.toContain("erp-dedicated-secret");
    const encryptedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    expect(encryptedSecrets).not.toContain("secret-value");
    expect(encryptedSecrets).not.toContain("erp-dedicated-secret");
    expect(store.environment()).toMatchObject({
      LXE_DATA_SERVER_ENABLED: "1",
      LXE_DATA_SERVER_URL: "http://10.88.0.1:8000",
      LXE_DATA_SERVER_API_KEY: "lxe_dev_0123456789abcdef0123456789abcdef.secret-value",
      LXE_ERP_API_KEY: "erp-dedicated-secret",
      LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "0",
    });

    store.saveCloudPermissionSnapshot({
      device_id: "0123456789abcdef0123456789abcdef",
      permission_profile: "fba",
      permission_version: 2,
      allowed_skill_types: ["amazon_fba", "ziniao_browser", "default"],
      verified_at: 123,
    });
    expect(store.cloudPermissionSnapshot()).toMatchObject({
      permission_profile: "fba",
      permission_version: 2,
    });
    expect(readFileSync(join(root, "config", "settings.json"), "utf8"))
      .not.toContain("permission_profile");
    expect(readFileSync(join(root, "config", "secrets.bin"), "utf8"))
      .not.toContain("amazon_fba");

    store.saveCloudEnrollment({
      deviceId: "fedcba9876543210fedcba9876543210",
      deviceName: "Replacement device",
      vpnIp: "10.88.0.9",
      dataServerUrl: "http://10.88.0.1:8000",
      tunnelName: "lxe-agent",
      apiKey: "replacement-token",
    });
    expect(store.cloudPermissionSnapshot()).toBeNull();
  });

  test("persists, aborts, clears, and atomically commits a destructive enrollment switch", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    store.saveLocalModelCredential({ provider: "kimi_coding", api_key: "local-model-secret" });
    store.save({
      workspace_root: join(root, "workspace"),
    });
    store.saveCloudEnrollment({
      deviceId: "0123456789abcdef0123456789abcdef",
      deviceName: "Old device",
      vpnIp: "10.88.0.8",
      dataServerUrl: "http://10.88.0.1:8000",
      tunnelName: "lxe-agent",
      apiKey: "old-data-token",
      erpApiKey: "old-erp-token",
    });
    store.saveCloudPermissionSnapshot({
      device_id: "0123456789abcdef0123456789abcdef",
      permission_profile: "fba",
      permission_version: 1,
      allowed_skill_types: ["amazon_fba", "ziniao_browser", "default"],
      verified_at: 123,
    });
    store.saveManagedLlmCredential({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      api_key: "old-managed-model-token",
      credential_revision: "a".repeat(64),
      fetched_at: 123,
      invalid_revision: "",
    });
    store.saveRuntimePreference("deepseek", "deepseek-v4-flash", "low", "cloud");

    expect(store.beginCloudEnrollmentSwitch()).toMatchObject({
      managed: true,
      switch_in_progress: true,
    });
    expect(store.environment()).toMatchObject({
      LXE_DATA_SERVER_ENABLED: "0",
      LXE_DATA_SERVER_API_KEY: "",
      LXE_ERP_API_KEY: "",
      LXE_MANAGED_LLM_API_KEY: "",
    });
    expect(store.state()).toMatchObject({ complete: false, managed_model_configured: false });

    expect(store.abortCloudEnrollmentSwitch()).toMatchObject({
      managed: true,
      switch_in_progress: false,
    });
    expect(store.environment()).toMatchObject({
      LXE_DATA_SERVER_ENABLED: "1",
      LXE_DATA_SERVER_API_KEY: "old-data-token",
      LXE_ERP_API_KEY: "old-erp-token",
      LXE_MANAGED_LLM_API_KEY: "old-managed-model-token",
    });
    expect(store.cloudPermissionSnapshot()).toMatchObject({ permission_profile: "fba" });

    store.beginCloudEnrollmentSwitch();
    expect(store.saveCloudEnrollment({
      deviceId: "fedcba9876543210fedcba9876543210",
      deviceName: "New device",
      vpnIp: "10.88.0.9",
      dataServerUrl: "http://10.88.0.2:8000",
      tunnelName: "lxe-agent",
      apiKey: "new-data-token",
      erpApiKey: "new-erp-token",
    })).toMatchObject({
      device_name: "New device",
      switch_in_progress: false,
    });
    expect(store.cloudPermissionSnapshot()).toBeNull();
    expect(store.managedLlmCredential()).toBeNull();
    expect(store.state()).toMatchObject({
      complete: false,
      provider: "deepseek",
      credential_source: "cloud",
    });
    let encryptedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    expect(encryptedSecrets).not.toContain("old-data-token");
    expect(encryptedSecrets).not.toContain("old-erp-token");
    expect(encryptedSecrets).not.toContain("old-managed-model-token");

    store.saveCloudPermissionSnapshot({
      device_id: "fedcba9876543210fedcba9876543210",
      permission_profile: "replenishment",
      permission_version: 2,
      allowed_skill_types: ["amazon_replenish"],
      verified_at: 456,
    });
    store.saveManagedLlmCredential({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      api_key: "new-managed-model-token",
      credential_revision: "b".repeat(64),
      fetched_at: 456,
      invalid_revision: "",
    });
    store.saveRuntimePreference("deepseek", "deepseek-v4-flash", "low", "cloud");
    store.beginCloudEnrollmentSwitch();
    expect(store.clearCloudEnrollment()).toMatchObject({
      managed: false,
      device_id: "",
      switch_in_progress: false,
    });
    expect(store.cloudPermissionSnapshot()).toBeNull();
    expect(store.managedLlmCredential()).toBeNull();
    expect(store.state()).toMatchObject({
      complete: false,
      provider: "deepseek",
      credential_source: "cloud",
    });
    expect(store.environment()).toMatchObject({
      LXE_DATA_SERVER_ENABLED: "0",
      LXE_DATA_SERVER_API_KEY: "",
      LXE_ERP_API_KEY: "",
      LXE_MANAGED_LLM_API_KEY: "",
    });
    encryptedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    expect(encryptedSecrets).not.toContain("new-data-token");
    expect(encryptedSecrets).not.toContain("new-erp-token");
    expect(encryptedSecrets).not.toContain("new-managed-model-token");
  });

  test("uses an encrypted managed credential as a standalone cloud model configuration", () => {
    const root = createRoot();
    const opaqueStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "ascii"),
      decryptString: (value: Buffer) => Buffer.from(String(value), "base64").toString("utf8"),
    };
    const revision = "a".repeat(64);
    const store = new DesktopConfigStore(root, join(root, "workspace"), opaqueStorage);
    store.saveManagedLlmCredential({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      api_key: "managed-deepseek-secret",
      credential_revision: revision,
      fetched_at: 123,
      invalid_revision: "",
    });

    expect(store.state()).toMatchObject({
      complete: true,
      provider: "deepseek",
      credential_source: "cloud",
      managed_model_configured: true,
    });
    expect(store.environment()).toMatchObject({
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_CREDENTIAL_SOURCE: "cloud",
      LXE_MANAGED_LLM_MODEL: "deepseek-v4-flash",
      LXE_MANAGED_LLM_API_KEY: "managed-deepseek-secret",
      LXE_MANAGED_LLM_CREDENTIAL_REVISION: revision,
    });
    expect(readFileSync(join(root, "config", "settings.json"), "utf8"))
      .not.toContain("managed-deepseek-secret");
    expect(readFileSync(join(root, "config", "secrets.bin"), "utf8"))
      .not.toContain("managed-deepseek-secret");

    const restarted = new DesktopConfigStore(root, join(root, "workspace"), opaqueStorage);
    expect(restarted.state()).toMatchObject({ complete: true, credential_source: "cloud" });
    restarted.invalidateManagedLlmCredential(revision);
    expect(restarted.state()).toMatchObject({ complete: false, managed_model_configured: false });
  });

  test("keeps an existing local model selected when a managed credential arrives", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    store.saveLocalModelCredential({ provider: "deepseek", api_key: "local-deepseek-secret" });
    store.saveManagedLlmCredential({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      api_key: "managed-deepseek-secret",
      credential_revision: "c".repeat(64),
      fetched_at: 123,
      invalid_revision: "",
    });

    expect(store.state()).toMatchObject({
      complete: true,
      provider: "deepseek",
      credential_source: "local",
      local_model_credentials: { deepseek: true },
      managed_model_configured: true,
    });
    expect(store.deleteLocalModelCredential("deepseek")).toMatchObject({
      complete: true,
      provider: "deepseek",
      credential_source: "cloud",
      local_model_credentials: { deepseek: false },
      managed_model_configured: true,
    });
  });

  test("falls back from a deleted active local key without selecting an unavailable model", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    store.saveLocalModelCredential({ provider: "glm", api_key: "glm-secret" });
    store.saveLocalModelCredential({ provider: "kimi_coding", api_key: "kimi-secret" });

    expect(store.deleteLocalModelCredential("kimi_coding")).toMatchObject({
      complete: true,
      provider: "glm",
      credential_source: "local",
      local_model_credentials: { kimi_coding: false, glm: true },
    });

    expect(store.deleteLocalModelCredential("glm")).toMatchObject({
      complete: false,
      credential_source: "local",
      local_model_credentials: { kimi_coding: false, deepseek: false, glm: false },
    });
  });

  test("keeps cloud selected and pending when the server revokes the company credential", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    store.saveManagedLlmCredential({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      api_key: "managed-secret",
      credential_revision: "d".repeat(64),
      fetched_at: 123,
      invalid_revision: "",
    });
    store.saveLocalModelCredential({ provider: "glm", api_key: "glm-secret" });
    expect(store.state()).toMatchObject({ credential_source: "cloud", provider: "deepseek" });

    store.clearManagedLlmCredential();

    expect(store.state()).toMatchObject({
      complete: false,
      provider: "deepseek",
      credential_source: "cloud",
      managed_model_configured: false,
      local_model_credentials: { glm: true },
    });
  });
});

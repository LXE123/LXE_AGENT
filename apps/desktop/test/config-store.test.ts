import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    const state = store.save({
      provider: "kimi_coding",
      api_key: "model-secret",
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
      provider_key_configured: true,
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
      KIMI_CODE_API_KEY: "model-secret",
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
    expect(environment).not.toHaveProperty("AGENT_STREAM_TRACE_ENABLED");
    expect(environment).not.toHaveProperty("AGENT_STREAM_TRACE_DIR");
  });

  test("uses source-development secrets without migrating them into encrypted storage", () => {
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

    expect(store.state()).toMatchObject({ complete: true, provider_key_configured: true });
    expect(store.save({
      provider: "kimi_coding",
      workspace_root: join(root, "workspace"),
      mabang: { action: "save", account: "source-account" },
      feishu: { action: "save", app_id: "source-app-id" },
    })).toMatchObject({
      complete: true,
      mabang: { configured: true, password_configured: true },
      feishu: { configured: true, app_secret_configured: true },
    });
    expect(store.environment()).toMatchObject({
      KIMI_CODE_API_KEY: "source-model-secret",
      DEEPSEEK_API: "source-deepseek-secret",
      MABANG_PASSWORD: "source-mabang-secret",
      FEISHU_APP_SECRET: "source-feishu-secret",
      LXE_SAIHU_MCP_API_KEY: "source-saihu-secret",
    });
    store.saveRuntimePreference("kimi_coding", "k3", "high");
    const persistedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    expect(persistedSecrets).not.toContain("source-model-secret");
    expect(persistedSecrets).not.toContain("source-deepseek-secret");
    expect(persistedSecrets).not.toContain("source-mabang-secret");
    expect(persistedSecrets).not.toContain("source-feishu-secret");
    expect(persistedSecrets).not.toContain("source-saihu-secret");
  });

  test("preserves blank secret patches and explicitly clears an integration", () => {
    const root = createRoot();
    const appPath = join(root, "ziniao.exe");
    writeFileSync(appPath, "binary");
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    store.save({
      provider: "glm",
      api_key: "model-secret",
      workspace_root: join(root, "workspace"),
      mabang: { action: "save", account: "first", password: "mabang-secret" },
    });
    expect(store.save({
      provider: "glm",
      workspace_root: join(root, "workspace"),
      mabang: { action: "save", account: "second" },
    }).mabang.configured).toBe(true);
    const cleared = store.save({
      provider: "glm",
      workspace_root: join(root, "workspace"),
      mabang: { action: "clear" },
    });
    expect(cleared.mabang).toMatchObject({ managed: true, configured: false, password_configured: false });
    expect(store.environment()).toMatchObject({ MABANG_ACCOUNT: "", MABANG_PASSWORD: "" });
    expect(() => store.save({
      provider: "glm",
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

  test("imports legacy credentials once and removes secrets from app-managed env files", () => {
    const root = createRoot();
    const configRoot = join(root, "config");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(join(configRoot, "desktop.json"), JSON.stringify({
      provider: "deepseek",
      workspace_root: join(root, "workspace"),
      feishu_app_id: "legacy-app",
    }));
    writeFileSync(join(configRoot, "secrets.bin"), safeStorage.encryptString(JSON.stringify({
      provider_keys: { deepseek: "model-secret" },
      feishu_app_secret: "legacy-safe-secret",
    })));
    const managedEnv = join(root, ".env.local");
    writeFileSync(managedEnv, [
      "MABANG_ACCOUNT=mabang-user",
      "MABANG_PASSWORD=mabang-secret",
      "FEISHU_APP_SECRET=legacy-plain-secret",
      "LOCAL_LOGS_ENABLED=0",
      "LOCAL_LOG_RETENTION_DAYS=30",
      "LXE_DATA_SERVER_API_KEY=data-secret",
      "LXE_SAIHU_MCP_API_KEY=saihu-mcp-secret",
      "UNCHANGED=value",
    ].join("\n"));
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    const state = store.migrateLegacyEnvironment({
      environment: {
        MABANG_ACCOUNT: "mabang-user",
        MABANG_PASSWORD: "mabang-secret",
        FEISHU_APP_ID: "legacy-app",
        FEISHU_APP_SECRET: "legacy-plain-secret",
        LOCAL_LOGS_ENABLED: "0",
        LOCAL_LOG_RETENTION_DAYS: "30",
        AGENT_LLM_PROVIDER: "deepseek",
        AGENT_LLM_MODEL: "deepseek-v4-pro",
        AGENT_LLM_THINKING_ENABLED: "1",
        AGENT_LLM_THINKING_EFFORT: "max",
        MABANG_STOCK_SKU_EXPORT_DIR: "/tmp/legacy-stock-output",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "http://127.0.0.1:18000",
        LXE_DATA_SERVER_API_KEY: "data-secret",
        LXE_SAIHU_MCP_API_KEY: "saihu-mcp-secret",
      },
      managedFiles: [managedEnv],
    });

    expect(state).toMatchObject({
      legacy_environment_imported: true,
      mabang: { configured: true },
      feishu: { configured: true, app_id: "legacy-app" },
      logging: { profile: "off", retention_days: 30 },
    });
    const cleaned = readFileSync(managedEnv, "utf8");
    expect(cleaned).toContain("MABANG_ACCOUNT=mabang-user");
    expect(cleaned).toContain("UNCHANGED=value");
    expect(cleaned).not.toContain("MABANG_PASSWORD");
    expect(cleaned).not.toContain("FEISHU_APP_SECRET");
    expect(cleaned).not.toContain("LXE_DATA_SERVER_API_KEY");
    expect(cleaned).not.toContain("LXE_SAIHU_MCP_API_KEY");
    expect(store.environment()).toMatchObject({
      AGENT_LLM_MODEL: "deepseek-v4-pro",
      AGENT_LLM_THINKING_EFFORT: "max",
      LXE_DATA_SERVER_ENABLED: "1",
      LXE_DATA_SERVER_URL: "http://127.0.0.1:18000",
      LXE_DATA_SERVER_API_KEY: "data-secret",
      LXE_SAIHU_MCP_API_KEY: "saihu-mcp-secret",
      MABANG_STOCK_SKU_EXPORT_DIR: "/tmp/legacy-stock-output",
    });
    expect(store.migrateLegacyEnvironment({ environment: { MABANG_ACCOUNT: "changed" } }).mabang.account)
      .toBe("mabang-user");
  });

  test("deletes retired dotenv files only after their settings are committed", () => {
    const root = createRoot();
    const retired = join(root, ".env.local");
    writeFileSync(retired, "AGENT_LLM_PROVIDER=kimi_coding\nLOCAL_LOGS_ENABLED=0\n");
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, {
      secretEnvironment: { KIMI_CODE_API_KEY: "source-secret" },
    });

    const state = store.migrateLegacyEnvironment({
      environment: { AGENT_LLM_PROVIDER: "kimi_coding", LOCAL_LOGS_ENABLED: "0" },
      retiredFiles: [retired],
    });

    expect(state.legacy_environment_imported).toBeTrue();
    expect(existsSync(retired)).toBeFalse();
    expect(store.environment().KIMI_CODE_API_KEY).toBe("source-secret");
  });

  test("uses standard logging for a new install and validates platform app paths", () => {
    const root = createRoot();
    const appPath = join(root, "Ziniao.app");
    mkdirSync(appPath);
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    expect(store.migrateLegacyEnvironment({
      environment: { LOCAL_LOGS_ENABLED: "0", LOCAL_LOG_RETENTION_DAYS: "30" },
    }).logging).toMatchObject({ profile: "standard", retention_days: 7 });
    const state = store.save({
      provider: "kimi_coding",
      api_key: "secret",
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
    const store = new DesktopConfigStore(root, join(root, "workspace"), {
      ...safeStorage,
      isEncryptionAvailable: () => false,
    });
    expect(() => store.save({
      provider: "glm",
      api_key: "secret",
      workspace_root: join(root, "workspace"),
    })).toThrow("Secure credential storage is unavailable");
    expect(existsSync(join(root, "config", "settings.json"))).toBe(false);
  });

  test("requires an explicitly selected workspace to already exist", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    const missing = join(root, "missing-workspace");
    expect(() => store.save({
      provider: "glm",
      api_key: "secret",
      workspace_root: missing,
    })).toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(() => store.save({
      provider: "glm",
      api_key: "secret",
      workspace_root: "relative-workspace",
    })).toThrow("absolute path");
  });

  test("does not report setup complete after its configured workspace is removed", () => {
    const root = createRoot();
    const workspace = join(root, "workspace");
    const canonicalWorkspace = realpathSync.native(workspace);
    const store = new DesktopConfigStore(root, workspace, safeStorage);
    expect(store.save({
      provider: "glm",
      api_key: "secret",
      workspace_root: workspace,
    }).complete).toBeTrue();

    rmSync(workspace, { recursive: true, force: true });

    expect(store.state()).toMatchObject({
      complete: false,
      provider_key_configured: true,
      workspace_root: canonicalWorkspace,
    });
  });

  test("keeps a default-workspace-only change out of the process environment", () => {
    const root = createRoot();
    const nextWorkspace = join(root, "next-workspace");
    mkdirSync(nextWorkspace);
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    store.save({
      provider: "glm",
      api_key: "secret",
      workspace_root: join(root, "workspace"),
    });
    const before = store.environment();
    const state = store.save({
      provider: "glm",
      workspace_root: nextWorkspace,
    });
    expect(state.workspace_root).toBe(realpathSync.native(nextWorkspace));
    expect(store.environment()).toEqual(before);
    expect(store.environment()).not.toHaveProperty("LXE_WORKSPACE_ROOT");
  });

  test("persists Dashboard model preferences in settings instead of dotenv", () => {
    const root = createRoot();
    const store = new DesktopConfigStore(root, join(root, "workspace"), safeStorage);
    store.save({
      provider: "kimi_coding",
      api_key: "secret",
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
      schema_version: 4,
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
});

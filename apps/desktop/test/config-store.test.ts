import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const serializedState = JSON.stringify(state);
    for (const secret of ["model-secret", "ziniao-secret", "mabang-secret", "feishu-secret"]) {
      expect(serializedState).not.toContain(secret);
      expect(readFileSync(join(root, "config", "desktop.json"), "utf8")).not.toContain(secret);
    }
    expect(store.environment()).toMatchObject({
      KIMI_CODE_API_KEY: "model-secret",
      ZINIAO_REGISTER_PLANNER_TOOLS: "1",
      ZINIAO_PASSWORD: "ziniao-secret",
      MABANG_PASSWORD: "mabang-secret",
      FEISHU_GATEWAY_ENABLED: "1",
      FEISHU_APP_SECRET: "feishu-secret",
      LOCAL_LOGS_ENABLED: "1",
      RUNTIME_LOG_LEVEL: "DEBUG",
      AGENT_SSE_WIRE_TRACE_ENABLED: "1",
      FEISHU_RAW_EVENT_DUMP_ENABLED: "1",
    });
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
    expect(store.migrateLegacyEnvironment({ environment: { MABANG_ACCOUNT: "changed" } }).mabang.account)
      .toBe("mabang-user");
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
    expect(existsSync(join(root, "config", "desktop.json"))).toBe(false);
  });
});

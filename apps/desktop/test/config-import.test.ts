import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopConfigImportManager } from "../src/main/config-import";
import { DesktopConfigStore } from "../src/main/config-store";
import { prepareDesktopRuntimeState } from "../src/main/runtime-state";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(Buffer.from(value, "utf8").toString("base64url"), "utf8"),
  decryptString: (value: Buffer) => Buffer.from(String(value), "base64url").toString("utf8"),
};

const createFixture = (platform: "win32" | "darwin" = "win32") => {
  const root = mkdtempSync(join(tmpdir(), "lxe-config-import-"));
  roots.push(root);
  const workspace = join(root, "default-workspace");
  mkdirSync(workspace);
  mkdirSync(join(root, "workspace"));
  const store = new DesktopConfigStore(root, workspace, safeStorage, { platform });
  return { root, store, manager: new DesktopConfigImportManager(store) };
};

const writeEnv = (root: string, content: string, name = ".env"): string => {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
};

describe("DesktopConfigImportManager", () => {
  test("previews a complete env without secrets and applies every supported group", () => {
    const { root, store, manager } = createFixture();
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "ziniao.exe"), "executable");
    const file = writeEnv(root, [
      "# Existing deployment configuration",
      "export AGENT_LLM_PROVIDER=deepseek",
      "DEEPSEEK_API='deepseek-secret'",
      "LXE_WORKSPACE_ROOT=./workspace",
      "ZINIAO_COMPANY=First Company",
      "ZINIAO_COMPANY=Ignored Duplicate",
      "ZINIAO_USERNAME=ziniao-user",
      "ZINIAO_PASSWORD=ziniao-secret",
      "ZINIAO_BROWSER_VERSION=v6",
      "ZINIAO_CLIENT_PATH=./bin/ziniao.exe",
      "ZINIAO_WEBDRIVER_PATH=./drivers",
      "MABANG_ACCOUNT=mabang-user",
      "MABANG_PASSWORD=mabang-secret",
      "FEISHU_APP_ID=cli_123",
      "FEISHU_APP_SECRET=feishu-secret",
      "LOCAL_LOGS_ENABLED=1",
      "LOCAL_LOG_RETENTION_DAYS=14",
      "RUNTIME_LOG_LEVEL=DEBUG",
      "UNRELATED_SETTING=ignored",
    ].join("\n"));

    const preview = manager.select(file);
    expect(preview).toMatchObject({
      file_name: ".env",
      diagnostic_logging: true,
      unknown_variable_count: 1,
    });
    expect(preview.groups.map((group) => [group.group, group.status])).toEqual([
      ["base", "ready"],
      ["ziniao", "ready"],
      ["mabang", "ready"],
      ["feishu", "ready"],
      ["logging", "ready"],
    ]);
    const serializedPreview = JSON.stringify(preview);
    for (const secret of ["deepseek-secret", "ziniao-secret", "mabang-secret", "feishu-secret"]) {
      expect(serializedPreview).not.toContain(secret);
    }
    expect(serializedPreview).not.toContain(file);

    const result = manager.apply(preview.import_id);
    expect(result.state).toMatchObject({
      complete: true,
      provider: "deepseek",
      provider_key_configured: true,
      workspace_root: realpathSync.native(join(root, "workspace")),
      ziniao: { configured: true, company: "First Company", password_configured: true },
      mabang: { configured: true, password_configured: true },
      feishu: { configured: true, app_secret_configured: true },
      logging: { profile: "diagnostic", retention_days: 14 },
    });
    expect(result.pending_groups).toEqual([]);
    expect(store.environment()).toMatchObject({
      AGENT_LLM_PROVIDER: "deepseek",
      DEEPSEEK_API: "deepseek-secret",
      ZINIAO_REGISTER_PLANNER_TOOLS: "1",
      ZINIAO_PASSWORD: "ziniao-secret",
      MABANG_PASSWORD: "mabang-secret",
      LXE_FEISHU_GATEWAY_ENABLED: "1",
      FEISHU_APP_SECRET: "feishu-secret",
      LOCAL_LOGS_ENABLED: "1",
      RUNTIME_LOG_LEVEL: "DEBUG",
    });
    const desktopJson = readFileSync(join(root, "config", "desktop.json"), "utf8");
    const encryptedSecrets = readFileSync(join(root, "config", "secrets.bin"), "utf8");
    for (const secret of ["deepseek-secret", "ziniao-secret", "mabang-secret", "feishu-secret"]) {
      expect(desktopJson).not.toContain(secret);
      expect(encryptedSecrets).not.toContain(secret);
    }
    expect(() => manager.apply(preview.import_id)).toThrow("不存在或已失效");
  });

  test("keeps blank values and the current usable provider, then permits an explicit saved provider", () => {
    const { root, store, manager } = createFixture();
    const workspace = join(root, "workspace");
    store.save({
      provider: "deepseek",
      api_key: "existing-deepseek-key",
      workspace_root: realpathSync.native(workspace),
      mabang: { action: "save", account: "existing-account", password: "existing-password" },
    });
    const first = manager.select(writeEnv(root, [
      "DEEPSEEK_API=",
      "KIMI_CODE_API_KEY=new-kimi-key",
      "LXE_WORKSPACE_ROOT=",
      "MABANG_ACCOUNT=",
      "MABANG_PASSWORD=",
    ].join("\n")));
    expect(manager.apply(first.import_id).state).toMatchObject({
      provider: "deepseek",
      workspace_root: realpathSync.native(workspace),
      mabang: { account: "existing-account", configured: true },
    });
    expect(store.environment()).toMatchObject({
      AGENT_LLM_PROVIDER: "deepseek",
      DEEPSEEK_API: "existing-deepseek-key",
      MABANG_PASSWORD: "existing-password",
    });

    const second = manager.select(writeEnv(root, "AGENT_LLM_PROVIDER=kimi-coding\n"));
    expect(manager.apply(second.import_id).state).toMatchObject({
      provider: "kimi_coding",
      provider_key_configured: true,
    });
    expect(store.environment().KIMI_CODE_API_KEY).toBe("new-kimi-key");
  });

  test("leaves provider selection pending when multiple new keys are ambiguous", () => {
    const { root, manager } = createFixture();
    const preview = manager.select(writeEnv(root, [
      "DEEPSEEK_API=deepseek-key",
      "GLM_API_KEY=glm-key",
    ].join("\n")));
    expect(preview.warnings).toContain("检测到多个模型 API Key，无法自动选择模型服务，请在导入后手动选择");
    expect(preview.groups[0]).toMatchObject({
      group: "base",
      status: "pending",
      issues: ["缺少所选模型服务的 API Key"],
    });
    expect(manager.apply(preview.import_id).state.complete).toBe(false);
  });

  test("uses the managed var workspace when an API key import omits LXE_WORKSPACE_ROOT", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-config-import-managed-workspace-"));
    roots.push(root);
    const dataRoot = join(root, "var");
    const runtimeState = prepareDesktopRuntimeState(dataRoot);
    const store = new DesktopConfigStore(dataRoot, runtimeState.workspace, safeStorage);
    const manager = new DesktopConfigImportManager(store);

    const preview = manager.select(writeEnv(root, "KIMI_CODE_API_KEY=model-key\n"));
    const result = manager.apply(preview.import_id);

    expect(result.state).toMatchObject({
      complete: true,
      provider: "kimi_coding",
      provider_key_configured: true,
      workspace_root: runtimeState.workspace,
    });
  });

  test("does not create an explicitly imported workspace that is missing", () => {
    const { root, manager } = createFixture();
    const missing = join(root, "missing-explicit-workspace");
    expect(() => manager.select(writeEnv(root, [
      "KIMI_CODE_API_KEY=model-key",
      `LXE_WORKSPACE_ROOT=${missing}`,
    ].join("\n")))).toThrow();
    expect(existsSync(missing)).toBeFalse();
  });

  test("persists partial integrations but never injects an invalid Ziniao path", () => {
    const { root, store, manager } = createFixture();
    const preview = manager.select(writeEnv(root, [
      "KIMI_CODE_API_KEY=model-key",
      "ZINIAO_COMPANY=LXE",
      "ZINIAO_PASSWORD=ziniao-secret",
      "ZINIAO_CLIENT_PATH=./missing-ziniao.exe",
      "MABANG_ACCOUNT=mabang-only",
      "FEISHU_APP_SECRET=feishu-only",
    ].join("\n")));
    expect(preview.groups.find((group) => group.group === "ziniao")).toMatchObject({
      status: "pending",
      issues: expect.arrayContaining(["缺少账号", "缺少浏览器驱动安装目录"]),
    });
    expect(preview.groups.find((group) => group.group === "mabang")).toMatchObject({
      status: "pending",
      issues: ["缺少密码"],
    });
    expect(preview.groups.find((group) => group.group === "feishu")).toMatchObject({
      status: "pending",
      issues: ["缺少 App ID"],
    });

    const result = manager.apply(preview.import_id);
    expect(result.state.ziniao).toMatchObject({ managed: true, configured: false, password_configured: true });
    expect(result.state.mabang).toMatchObject({ managed: true, configured: false });
    expect(result.state.feishu).toMatchObject({ managed: true, configured: false, app_secret_configured: true });
    expect(store.environment()).toMatchObject({
      ZINIAO_REGISTER_PLANNER_TOOLS: "0",
      ZINIAO_PASSWORD: "",
      ZINIAO_CLIENT_PATH: "",
      MABANG_ACCOUNT: "",
      MABANG_PASSWORD: "",
      LXE_FEISHU_GATEWAY_ENABLED: "0",
      FEISHU_APP_SECRET: "",
    });
  });

  test("normalizes macOS Ziniao to v6 and reports an invalid app bundle", () => {
    const { root, store, manager } = createFixture("darwin");
    writeFileSync(join(root, "Ziniao.app"), "not a bundle directory");
    const preview = manager.select(writeEnv(root, [
      "KIMI_CODE_API_KEY=model-key",
      "ZINIAO_COMPANY=LXE",
      "ZINIAO_USERNAME=user",
      "ZINIAO_PASSWORD=password",
      "ZINIAO_BROWSER_VERSION=v5",
      "ZINIAO_CLIENT_PATH=./Ziniao.app",
      "ZINIAO_WEBDRIVER_PATH=./drivers",
    ].join("\n")));
    expect(preview.warnings).toContain("macOS 仅支持紫鸟 v6，导入时已按 v6 处理");
    expect(preview.groups.find((group) => group.group === "ziniao")).toMatchObject({
      status: "pending",
      issues: ["macOS 紫鸟 APP 必须是 .app 或可执行文件"],
    });
    const result = manager.apply(preview.import_id);
    expect(result.state.ziniao).toMatchObject({ app_version: "v6", configured: false });
    expect(store.environment()).toMatchObject({
      ZINIAO_REGISTER_PLANNER_TOOLS: "0",
      ZINIAO_CLIENT_PATH: "",
    });
  });

  test("maps imported logging values to coherent off and standard profiles", () => {
    const { root, store, manager } = createFixture();
    const off = manager.select(writeEnv(root, [
      "LOCAL_LOGS_ENABLED=0",
      "RUNTIME_LOG_LEVEL=DEBUG",
      "AGENT_SSE_WIRE_TRACE_ENABLED=1",
    ].join("\n")));
    expect(manager.apply(off.import_id).state.logging.profile).toBe("off");
    expect(store.environment()).toMatchObject({
      LOCAL_LOGS_ENABLED: "0",
      RUNTIME_LOG_LEVEL: "INFO",
      AGENT_SSE_WIRE_TRACE_ENABLED: "0",
      ZINIAO_DIAGNOSTIC_TRACE_ENABLED: "0",
      FEISHU_RAW_EVENT_DUMP_ENABLED: "0",
    });

    const standard = manager.select(writeEnv(root, [
      "LOCAL_LOGS_ENABLED=1",
      "RUNTIME_LOG_LEVEL=INFO",
      "AGENT_STREAM_TRACE_ENABLED=0",
    ].join("\n")));
    expect(manager.apply(standard.import_id).state.logging.profile).toBe("standard");
    expect(store.environment()).toMatchObject({
      LOCAL_LOGS_ENABLED: "1",
      RUNTIME_LOG_LEVEL: "INFO",
      AGENT_STREAM_TRACE_ENABLED: "0",
      AGENT_SSE_WIRE_TRACE_ENABLED: "0",
    });
  });

  test("expires, discards, and supersedes one-time drafts", () => {
    const { root, store } = createFixture();
    let now = 1_000;
    let sequence = 0;
    const manager = new DesktopConfigImportManager(store, {
      now: () => now,
      createId: () => `draft-${++sequence}`,
    });
    const file = writeEnv(root, "KIMI_CODE_API_KEY=secret\n");
    const first = manager.select(file);
    const second = manager.select(file);
    expect(() => manager.apply(first.import_id)).toThrow("不存在或已失效");
    manager.discard(second.import_id);
    expect(() => manager.discard(second.import_id)).toThrow("不存在或已失效");
    const third = manager.select(file);
    now = third.expires_at;
    expect(() => manager.apply(third.import_id)).toThrow("已过期");
  });

  test("rejects oversized, binary, malformed UTF-8, unrelated, and incorrectly named files", () => {
    const { root, manager } = createFixture();
    const oversized = writeEnv(root, "x".repeat(1024 * 1024 + 1));
    expect(() => manager.select(oversized)).toThrow("1 MiB");
    writeFileSync(oversized, Buffer.from([75, 0, 61, 49]));
    expect(() => manager.select(oversized)).toThrow("二进制");
    writeFileSync(oversized, Buffer.from([0xc3, 0x28]));
    expect(() => manager.select(oversized)).toThrow("UTF-8");
    writeFileSync(oversized, "UNRELATED=value\n");
    expect(() => manager.select(oversized)).toThrow("没有检测到");
    expect(() => manager.select(writeEnv(root, "KIMI_CODE_API_KEY=secret", "config.env")))
      .toThrow("请选择 .env 或 .env.local");
  });

  test("rolls back persistent configuration when encrypted storage fails", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-config-import-rollback-"));
    roots.push(root);
    const store = new DesktopConfigStore(root, join(root, "workspace"), {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error("encryption failed"); },
      decryptString: () => "{}",
    });
    const manager = new DesktopConfigImportManager(store);
    const preview = manager.select(writeEnv(root, "KIMI_CODE_API_KEY=secret\n"));
    expect(() => manager.apply(preview.import_id)).toThrow("encryption failed");
    expect(existsSync(join(root, "config", "desktop.json"))).toBe(false);
    expect(existsSync(join(root, "config", "secrets.bin"))).toBe(false);
  });
});

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { resolveWorkspaceContext } from "@lxe/core";
import type {
  DesktopConfigImportApplyResult,
  DesktopConfigImportGroupPreview,
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopPlatform,
  DesktopSetupInput,
  DesktopSetupState,
  DesktopZiniaoVersion,
} from "@lxe/desktop-protocol";

interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface DesktopConfig {
  schema_version: 3;
  migration_version: number;
  provider: DesktopSetupInput["provider"];
  workspace_root: string;
  integrations: {
    ziniao: {
      managed: boolean;
      company: string;
      username: string;
      app_version: DesktopZiniaoVersion;
      app_path: string;
      webdriver_path: string;
    };
    mabang: { managed: boolean; account: string };
    feishu: { managed: boolean; app_id: string };
  };
  logging: {
    profile: DesktopLogProfile;
    retention_days: DesktopLogRetentionDays;
  };
  cloud: {
    managed: boolean;
    device_id: string;
    device_name: string;
    vpn_ip: string;
    data_server_url: string;
    sync_interval_seconds: number;
    tunnel_name: string;
  };
}

interface DesktopSecrets {
  provider_keys: Partial<Record<DesktopSetupInput["provider"], string>>;
  ziniao_password: string;
  mabang_password: string;
  feishu_app_secret: string;
  data_server_api_key: string;
}

export interface DesktopCloudConfiguration {
  managed: boolean;
  device_id: string;
  device_name: string;
  vpn_ip: string;
  data_server_url: string;
  sync_interval_seconds: number;
  tunnel_name: string;
  api_key_configured: boolean;
}

export interface DesktopCloudEnrollmentConfig {
  deviceId: string;
  deviceName: string;
  vpnIp: string;
  dataServerUrl: string;
  syncIntervalSeconds: number;
  tunnelName: string;
  apiKey: string;
}

export interface DesktopConfigStoreOptions {
  platform?: DesktopPlatform;
  pathExists?: (path: string) => boolean;
  pathIsDirectory?: (path: string) => boolean;
  pathIsExecutable?: (path: string) => boolean;
}

export interface LegacyEnvironmentMigrationOptions {
  environment: Readonly<Record<string, string | undefined>>;
  managedFiles?: readonly string[];
}

export interface PreparedDesktopConfigImport {
  summary: {
    groups: DesktopConfigImportGroupPreview[];
    warnings: string[];
    diagnostic_logging: boolean;
  };
  apply(): DesktopConfigImportApplyResult;
}

const LOG_RETENTION_DAYS = new Set<DesktopLogRetentionDays>([3, 7, 14, 30]);
const MIGRATION_VERSION = 1;
const SECRET_ENV_NAMES = new Set(["ZINIAO_PASSWORD", "MABANG_PASSWORD", "FEISHU_APP_SECRET"]);
const PROVIDER_KEY_ENV = {
  kimi_coding: "KIMI_CODE_API_KEY",
  deepseek: "DEEPSEEK_API",
  glm: "GLM_API_KEY",
} as const;
const PROVIDER_LABEL = {
  kimi_coding: "Kimi Coding API Key（秘密）",
  deepseek: "DeepSeek API Key（秘密）",
  glm: "GLM API Key（秘密）",
} as const;

const DEFAULT_CONFIG: DesktopConfig = {
  schema_version: 3,
  migration_version: 0,
  provider: "kimi_coding",
  workspace_root: "",
  integrations: {
    ziniao: {
      managed: false,
      company: "",
      username: "",
      app_version: "v6",
      app_path: "",
      webdriver_path: "",
    },
    mabang: { managed: false, account: "" },
    feishu: { managed: false, app_id: "" },
  },
  logging: { profile: "standard", retention_days: 7 },
  cloud: {
    managed: false,
    device_id: "",
    device_name: "",
    vpn_ip: "",
    data_server_url: "",
    sync_interval_seconds: 3_600,
    tunnel_name: "lxe-agent",
  },
};
const DEFAULT_SECRETS: DesktopSecrets = {
  provider_keys: {},
  ziniao_password: "",
  mabang_password: "",
  feishu_app_secret: "",
  data_server_api_key: "",
};

const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string => String(value ?? "").trim();
const flag = (value: unknown): boolean => ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
const ziniaoVersion = (value: unknown, platform: DesktopPlatform): DesktopZiniaoVersion =>
  platform !== "darwin" && text(value).toLowerCase() === "v5" ? "v5" : "v6";
const logRetention = (value: unknown): DesktopLogRetentionDays => {
  const parsed = Number(text(value));
  return LOG_RETENTION_DAYS.has(parsed as DesktopLogRetentionDays)
    ? parsed as DesktopLogRetentionDays
    : 7;
};
const logProfile = (value: unknown): DesktopLogProfile => {
  const normalized = text(value).toLowerCase();
  return normalized === "off" || normalized === "diagnostic" ? normalized : "standard";
};

const cloneConfig = (): DesktopConfig => structuredClone(DEFAULT_CONFIG);
const cloneSecrets = (): DesktopSecrets => structuredClone(DEFAULT_SECRETS);

export class DesktopConfigStore {
  private readonly configPath: string;
  private readonly secretsPath: string;
  private readonly platform: DesktopPlatform;
  private readonly pathExists: (path: string) => boolean;
  private readonly pathIsDirectory: (path: string) => boolean;
  private readonly pathIsExecutable: (path: string) => boolean;
  private readonly hadExistingConfig: boolean;

  constructor(
    private readonly dataRoot: string,
    private readonly defaultWorkspaceRoot: string,
    private readonly safeStorage: SafeStoragePort,
    options: DesktopConfigStoreOptions = {},
  ) {
    this.configPath = join(dataRoot, "config", "desktop.json");
    this.secretsPath = join(dataRoot, "config", "secrets.bin");
    this.platform = options.platform ?? "win32";
    this.pathExists = options.pathExists ?? existsSync;
    this.pathIsDirectory = options.pathIsDirectory ?? ((path) => statSync(path).isDirectory());
    this.pathIsExecutable = options.pathIsExecutable ?? ((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    this.hadExistingConfig = existsSync(this.configPath);
  }

  state(): DesktopSetupState {
    const config = this.readConfig();
    const secrets = this.readSecrets();
    const providerKey = text(secrets.provider_keys[config.provider]);
    const workspaceRoot = config.workspace_root || this.defaultWorkspaceRoot;
    const ziniao = config.integrations.ziniao;
    const mabang = config.integrations.mabang;
    const feishu = config.integrations.feishu;
    const ziniaoIssues = ziniao.managed ? this.ziniaoIssues(ziniao, secrets) : [];
    const mabangIssues = mabang.managed ? this.mabangIssues(mabang, secrets) : [];
    const feishuIssues = feishu.managed ? this.feishuIssues(feishu, secrets) : [];
    const ziniaoConfigured = ziniao.managed && ziniaoIssues.length === 0;
    const mabangConfigured = mabang.managed && mabangIssues.length === 0;
    const feishuConfigured = feishu.managed && feishuIssues.length === 0;
    return {
      complete: Boolean(providerKey && workspaceRoot),
      provider: config.provider,
      provider_key_configured: Boolean(providerKey),
      workspace_root: workspaceRoot,
      ziniao: {
        managed: ziniao.managed,
        configured: ziniaoConfigured,
        issues: ziniaoIssues,
        company: ziniao.company,
        username: ziniao.username,
        password_configured: Boolean(secrets.ziniao_password),
        app_version: ziniao.app_version,
        app_path: ziniao.app_path,
        webdriver_path: ziniao.webdriver_path,
      },
      mabang: {
        managed: mabang.managed,
        configured: mabangConfigured,
        issues: mabangIssues,
        account: mabang.account,
        password_configured: Boolean(secrets.mabang_password),
      },
      feishu: {
        managed: feishu.managed,
        configured: feishuConfigured,
        issues: feishuIssues,
        app_id: feishu.app_id,
        app_secret_configured: Boolean(secrets.feishu_app_secret),
      },
      logging: {
        ...config.logging,
        directory: join(this.dataRoot, "logs"),
      },
      legacy_environment_imported: config.migration_version >= MIGRATION_VERSION,
    };
  }

  save(input: DesktopSetupInput): DesktopSetupState {
    this.requireSafeStorage();
    const provider = input.provider;
    if (!["kimi_coding", "deepseek", "glm"].includes(provider)) {
      throw new Error("Unsupported model provider");
    }
    const workspaceRoot = this.validateWorkspaceRoot(text(input.workspace_root) || this.defaultWorkspaceRoot);
    const config = this.readConfig();
    const secrets = this.readSecrets();
    config.provider = provider;
    config.workspace_root = workspaceRoot;
    config.migration_version = Math.max(config.migration_version, MIGRATION_VERSION);
    if (text(input.api_key)) secrets.provider_keys[provider] = text(input.api_key);
    if (!secrets.provider_keys[provider]) throw new Error("Model API key is required");

    if (input.ziniao?.action === "clear") {
      config.integrations.ziniao = { ...cloneConfig().integrations.ziniao, managed: true };
      secrets.ziniao_password = "";
    } else if (input.ziniao?.action === "save") {
      const company = text(input.ziniao.company);
      const username = text(input.ziniao.username);
      const appPath = text(input.ziniao.app_path);
      const webdriverPath = text(input.ziniao.webdriver_path);
      const password = text(input.ziniao.password) || secrets.ziniao_password;
      const missing = [
        !company && "公司名",
        !username && "账号",
        !password && "密码",
        !appPath && "紫鸟 APP 文件地址",
        !webdriverPath && "浏览器驱动安装目录",
      ].filter(Boolean);
      if (missing.length > 0) throw new Error(`紫鸟配置缺少：${missing.join("、")}`);
      this.validateZiniaoPaths(appPath, webdriverPath);
      config.integrations.ziniao = {
        managed: true,
        company,
        username,
        app_version: ziniaoVersion(input.ziniao.app_version, this.platform),
        app_path: resolve(appPath),
        webdriver_path: resolve(webdriverPath),
      };
      secrets.ziniao_password = password;
    }

    if (input.mabang?.action === "clear") {
      config.integrations.mabang = { managed: true, account: "" };
      secrets.mabang_password = "";
    } else if (input.mabang?.action === "save") {
      const account = text(input.mabang.account);
      const password = text(input.mabang.password) || secrets.mabang_password;
      if (!account || !password) throw new Error("马帮账号和密码必须同时填写");
      config.integrations.mabang = { managed: true, account };
      secrets.mabang_password = password;
    }

    if (input.feishu?.action === "clear") {
      config.integrations.feishu = { managed: true, app_id: "" };
      secrets.feishu_app_secret = "";
    } else if (input.feishu?.action === "save") {
      const appId = text(input.feishu.app_id);
      const appSecret = text(input.feishu.app_secret) || secrets.feishu_app_secret;
      if (!appId || !appSecret) throw new Error("飞书 App ID 和 App Secret 必须同时填写");
      config.integrations.feishu = { managed: true, app_id: appId };
      secrets.feishu_app_secret = appSecret;
    }

    if (input.logging) {
      config.logging = {
        profile: logProfile(input.logging.profile),
        retention_days: logRetention(input.logging.retention_days),
      };
    }
    this.commit(config, secrets);
    return this.state();
  }

  cloudConfiguration(): DesktopCloudConfiguration {
    const cloud = this.readConfig().cloud;
    return {
      ...cloud,
      api_key_configured: Boolean(text(this.readSecrets().data_server_api_key)),
    };
  }

  saveCloudEnrollment(input: DesktopCloudEnrollmentConfig): DesktopCloudConfiguration {
    this.requireSafeStorage();
    const apiKey = text(input.apiKey);
    if (!apiKey) throw new Error("Device upload token is required");
    const config = this.readConfig();
    const secrets = this.readSecrets();
    config.cloud = {
      managed: true,
      device_id: text(input.deviceId),
      device_name: text(input.deviceName),
      vpn_ip: text(input.vpnIp),
      data_server_url: text(input.dataServerUrl).replace(/\/+$/u, ""),
      sync_interval_seconds: Math.max(30, Math.trunc(input.syncIntervalSeconds)),
      tunnel_name: text(input.tunnelName) || "lxe-agent",
    };
    if (!config.cloud.device_id || !config.cloud.device_name || !config.cloud.vpn_ip
      || !config.cloud.data_server_url) {
      throw new Error("Cloud enrollment metadata is incomplete");
    }
    secrets.data_server_api_key = apiKey;
    this.commit(config, secrets);
    return this.cloudConfiguration();
  }

  migrateLegacyEnvironment(options: LegacyEnvironmentMigrationOptions): DesktopSetupState {
    const config = this.readConfig();
    if (config.migration_version >= MIGRATION_VERSION) return this.state();
    this.requireSafeStorage();
    const secrets = this.readSecrets();
    const environment = options.environment;
    const legacyText = (name: string): string => text(environment[name]);

    const ziniaoValues = [
      legacyText("ZINIAO_COMPANY"),
      legacyText("ZINIAO_USERNAME"),
      legacyText("ZINIAO_PASSWORD"),
      legacyText("ZINIAO_CLIENT_PATH"),
      legacyText("ZINIAO_WEBDRIVER_PATH"),
    ];
    if (ziniaoValues.some(Boolean)) {
      config.integrations.ziniao = {
        managed: true,
        company: legacyText("ZINIAO_COMPANY") || config.integrations.ziniao.company,
        username: legacyText("ZINIAO_USERNAME") || config.integrations.ziniao.username,
        app_version: ziniaoVersion(
          legacyText("ZINIAO_BROWSER_VERSION") || config.integrations.ziniao.app_version,
          this.platform,
        ),
        app_path: legacyText("ZINIAO_CLIENT_PATH") || config.integrations.ziniao.app_path,
        webdriver_path: legacyText("ZINIAO_WEBDRIVER_PATH") || config.integrations.ziniao.webdriver_path,
      };
      secrets.ziniao_password = legacyText("ZINIAO_PASSWORD") || secrets.ziniao_password;
    }
    if ([legacyText("MABANG_ACCOUNT"), legacyText("MABANG_PASSWORD")].some(Boolean)) {
      config.integrations.mabang = {
        managed: true,
        account: legacyText("MABANG_ACCOUNT") || config.integrations.mabang.account,
      };
      secrets.mabang_password = legacyText("MABANG_PASSWORD") || secrets.mabang_password;
    }
    if ([legacyText("FEISHU_APP_ID"), legacyText("FEISHU_APP_SECRET")].some(Boolean)) {
      config.integrations.feishu = {
        managed: true,
        app_id: legacyText("FEISHU_APP_ID") || config.integrations.feishu.app_id,
      };
      secrets.feishu_app_secret = legacyText("FEISHU_APP_SECRET") || secrets.feishu_app_secret;
    }
    if (this.hadExistingConfig) {
      const logsEnabled = legacyText("LOCAL_LOGS_ENABLED");
      if (logsEnabled) {
        config.logging.profile = flag(logsEnabled)
          ? ([
              "AGENT_STREAM_TRACE_ENABLED",
              "AGENT_SSE_WIRE_TRACE_ENABLED",
              "ZINIAO_DIAGNOSTIC_TRACE_ENABLED",
              "FEISHU_RAW_EVENT_DUMP_ENABLED",
            ].some((name) => flag(environment[name])) ? "diagnostic" : "standard")
          : "off";
      }
      config.logging.retention_days = logRetention(
        legacyText("LOCAL_LOG_RETENTION_DAYS") || config.logging.retention_days,
      );
    }
    // Persist imported credentials before touching plaintext files. Keep the
    // migration incomplete until cleanup succeeds so a later launch can retry.
    config.migration_version = 0;
    this.commit(config, secrets);
    for (const path of options.managedFiles ?? []) this.removeMigratedSecrets(path);
    config.migration_version = MIGRATION_VERSION;
    this.commit(config, secrets);
    return this.state();
  }

  prepareEnvironmentImport(
    environment: Readonly<Record<string, string | undefined>>,
  ): PreparedDesktopConfigImport {
    this.requireSafeStorage();
    const config = this.readConfig();
    const secrets = this.readSecrets();
    const previousConfig = structuredClone(config);
    const previousSecrets = structuredClone(secrets);
    const imported = (name: string): string => text(environment[name]);
    const groups: DesktopConfigImportGroupPreview[] = [];
    const warnings: string[] = [];

    const baseFields: string[] = [];
    const baseOverwrites: string[] = [];
    const importedProviders: DesktopSetupInput["provider"][] = [];
    for (const provider of Object.keys(PROVIDER_KEY_ENV) as DesktopSetupInput["provider"][]) {
      const value = imported(PROVIDER_KEY_ENV[provider]);
      if (!value) continue;
      importedProviders.push(provider);
      baseFields.push(PROVIDER_LABEL[provider]);
      if (previousSecrets.provider_keys[provider]) baseOverwrites.push(PROVIDER_LABEL[provider]);
      secrets.provider_keys[provider] = value;
    }
    const rawProvider = imported("AGENT_LLM_PROVIDER").toLowerCase().replaceAll("-", "_");
    const explicitProvider = rawProvider === "kimi_coding" || rawProvider === "deepseek" || rawProvider === "glm"
      ? rawProvider as DesktopSetupInput["provider"]
      : undefined;
    if (imported("AGENT_LLM_PROVIDER")) {
      baseFields.push("模型服务");
      if (!explicitProvider) warnings.push(`无法识别模型服务：${imported("AGENT_LLM_PROVIDER")}`);
    }
    if (explicitProvider) {
      if (secrets.provider_keys[explicitProvider]) {
        if (config.provider !== explicitProvider) baseOverwrites.push("模型服务");
        config.provider = explicitProvider;
      } else {
        warnings.push("文件指定的模型服务没有对应 API Key，已保留当前模型服务");
      }
    } else if (!secrets.provider_keys[config.provider]) {
      if (importedProviders.length === 1) config.provider = importedProviders[0]!;
      else if (importedProviders.length > 1) {
        warnings.push("检测到多个模型 API Key，无法自动选择模型服务，请在导入后手动选择");
      }
    }
    const workspaceRoot = imported("LXE_WORKSPACE_ROOT");
    if (workspaceRoot) {
      const validatedWorkspace = this.validateWorkspaceRoot(workspaceRoot);
      baseFields.push("默认工作区");
      if (previousConfig.workspace_root && resolve(previousConfig.workspace_root) !== validatedWorkspace) {
        baseOverwrites.push("默认工作区");
      }
      config.workspace_root = validatedWorkspace;
    }
    if (baseFields.length > 0) {
      const issues = secrets.provider_keys[config.provider] ? [] : ["缺少所选模型服务的 API Key"];
      groups.push({
        group: "base",
        label: "基础设置",
        status: issues.length === 0 ? "ready" : "pending",
        detected_fields: baseFields,
        overwritten_fields: [...new Set(baseOverwrites)],
        issues,
      });
    }

    const ziniaoFields: string[] = [];
    const ziniaoOverwrites: string[] = [];
    const ziniao = config.integrations.ziniao;
    const ziniaoTextFields = [
      ["ZINIAO_COMPANY", "公司名", "company"],
      ["ZINIAO_USERNAME", "账号", "username"],
      ["ZINIAO_CLIENT_PATH", "紫鸟 APP 文件地址", "app_path"],
      ["ZINIAO_WEBDRIVER_PATH", "浏览器驱动安装目录", "webdriver_path"],
    ] as const;
    for (const [name, label, key] of ziniaoTextFields) {
      const value = imported(name);
      if (!value) continue;
      ziniaoFields.push(label);
      if (previousConfig.integrations.ziniao[key]) ziniaoOverwrites.push(label);
      ziniao[key] = key === "app_path" || key === "webdriver_path" ? resolve(value) : value;
    }
    const ziniaoPassword = imported("ZINIAO_PASSWORD");
    if (ziniaoPassword) {
      ziniaoFields.push("密码（秘密）");
      if (previousSecrets.ziniao_password) ziniaoOverwrites.push("密码（秘密）");
      secrets.ziniao_password = ziniaoPassword;
    }
    const rawZiniaoVersion = imported("ZINIAO_BROWSER_VERSION").toLowerCase();
    if (rawZiniaoVersion) {
      ziniaoFields.push("紫鸟 APP 版本");
      if (rawZiniaoVersion === "v5" || rawZiniaoVersion === "v6") {
        const nextVersion = ziniaoVersion(rawZiniaoVersion, this.platform);
        if (nextVersion !== ziniao.app_version) ziniaoOverwrites.push("紫鸟 APP 版本");
        ziniao.app_version = nextVersion;
        if (this.platform === "darwin" && rawZiniaoVersion === "v5") {
          warnings.push("macOS 仅支持紫鸟 v6，导入时已按 v6 处理");
        }
      } else {
        warnings.push(`无法识别紫鸟 APP 版本：${imported("ZINIAO_BROWSER_VERSION")}`);
      }
    }
    if (ziniaoFields.length > 0) {
      ziniao.managed = true;
      const issues = this.ziniaoIssues(ziniao, secrets);
      groups.push({
        group: "ziniao",
        label: "紫鸟自动化",
        status: issues.length === 0 ? "ready" : "pending",
        detected_fields: ziniaoFields,
        overwritten_fields: [...new Set(ziniaoOverwrites)],
        issues,
      });
    }

    const mabangFields: string[] = [];
    const mabangOverwrites: string[] = [];
    const mabangAccount = imported("MABANG_ACCOUNT");
    if (mabangAccount) {
      mabangFields.push("账号");
      if (previousConfig.integrations.mabang.account) mabangOverwrites.push("账号");
      config.integrations.mabang.account = mabangAccount;
    }
    const mabangPassword = imported("MABANG_PASSWORD");
    if (mabangPassword) {
      mabangFields.push("密码（秘密）");
      if (previousSecrets.mabang_password) mabangOverwrites.push("密码（秘密）");
      secrets.mabang_password = mabangPassword;
    }
    if (mabangFields.length > 0) {
      config.integrations.mabang.managed = true;
      const issues = this.mabangIssues(config.integrations.mabang, secrets);
      groups.push({
        group: "mabang",
        label: "马帮",
        status: issues.length === 0 ? "ready" : "pending",
        detected_fields: mabangFields,
        overwritten_fields: mabangOverwrites,
        issues,
      });
    }

    const feishuFields: string[] = [];
    const feishuOverwrites: string[] = [];
    const feishuAppId = imported("FEISHU_APP_ID");
    if (feishuAppId) {
      feishuFields.push("App ID");
      if (previousConfig.integrations.feishu.app_id) feishuOverwrites.push("App ID");
      config.integrations.feishu.app_id = feishuAppId;
    }
    const feishuSecret = imported("FEISHU_APP_SECRET");
    if (feishuSecret) {
      feishuFields.push("App Secret（秘密）");
      if (previousSecrets.feishu_app_secret) feishuOverwrites.push("App Secret（秘密）");
      secrets.feishu_app_secret = feishuSecret;
    }
    if (feishuFields.length > 0) {
      config.integrations.feishu.managed = true;
      const issues = this.feishuIssues(config.integrations.feishu, secrets);
      groups.push({
        group: "feishu",
        label: "飞书",
        status: issues.length === 0 ? "ready" : "pending",
        detected_fields: feishuFields,
        overwritten_fields: feishuOverwrites,
        issues,
      });
    }

    const logNames = [
      "LOCAL_LOGS_ENABLED",
      "LOCAL_LOG_RETENTION_DAYS",
      "RUNTIME_LOG_LEVEL",
      "AGENT_STREAM_TRACE_ENABLED",
      "AGENT_SSE_WIRE_TRACE_ENABLED",
      "ZINIAO_DIAGNOSTIC_TRACE_ENABLED",
      "FEISHU_RAW_EVENT_DUMP_ENABLED",
    ] as const;
    const loggingFields = logNames.filter((name) => imported(name)).map((name) => ({
      LOCAL_LOGS_ENABLED: "文件日志",
      LOCAL_LOG_RETENTION_DAYS: "保留周期",
      RUNTIME_LOG_LEVEL: "日志级别",
      AGENT_STREAM_TRACE_ENABLED: "模型流式轨迹",
      AGENT_SSE_WIRE_TRACE_ENABLED: "SSE Wire Trace",
      ZINIAO_DIAGNOSTIC_TRACE_ENABLED: "紫鸟诊断",
      FEISHU_RAW_EVENT_DUMP_ENABLED: "飞书原始事件",
    })[name]);
    if (loggingFields.length > 0) {
      const logsEnabled = imported("LOCAL_LOGS_ENABLED");
      const traceNames = logNames.slice(2);
      const anyDiagnostic = traceNames.some((name) =>
        name === "RUNTIME_LOG_LEVEL"
          ? imported(name).toUpperCase() === "DEBUG"
          : flag(imported(name)));
      const anyTraceSpecified = traceNames.some((name) => Boolean(imported(name)));
      if (logsEnabled) {
        config.logging.profile = flag(logsEnabled) ? (anyDiagnostic ? "diagnostic" : "standard") : "off";
      } else if (anyTraceSpecified) {
        config.logging.profile = anyDiagnostic ? "diagnostic" : "standard";
      }
      const retention = imported("LOCAL_LOG_RETENTION_DAYS");
      if (retention) {
        const parsed = Number(retention);
        if (LOG_RETENTION_DAYS.has(parsed as DesktopLogRetentionDays)) {
          config.logging.retention_days = parsed as DesktopLogRetentionDays;
        } else {
          warnings.push(`不支持的日志保留周期：${retention}，已保留当前设置`);
        }
      }
      groups.push({
        group: "logging",
        label: "日志与排障",
        status: "ready",
        detected_fields: loggingFields,
        overwritten_fields: previousConfig.logging.profile !== config.logging.profile
          || previousConfig.logging.retention_days !== config.logging.retention_days
          ? loggingFields
          : [],
        issues: [],
      });
    }

    const diagnosticLogging = loggingFields.length > 0
      && previousConfig.logging.profile !== "diagnostic"
      && config.logging.profile === "diagnostic";
    config.migration_version = Math.max(config.migration_version, MIGRATION_VERSION);
    let applied = false;
    const appliedGroups = groups.map((group) => group.label);
    const pendingGroups = groups.filter((group) => group.status === "pending").map((group) => group.label);
    return {
      summary: { groups, warnings, diagnostic_logging: diagnosticLogging },
      apply: () => {
        if (applied) throw new Error("This configuration import has already been applied");
        applied = true;
        this.commit(config, secrets);
        return {
          state: this.state(),
          applied_groups: appliedGroups,
          pending_groups: pendingGroups,
          warnings,
        };
      },
    };
  }

  environment(): Record<string, string> {
    const config = this.readConfig();
    const secrets = this.readSecrets();
    const providerKey = text(secrets.provider_keys[config.provider]);
    const providerEnvironment = config.provider === "deepseek"
      ? { DEEPSEEK_API: providerKey }
      : config.provider === "glm"
        ? { GLM_API_KEY: providerKey }
        : { KIMI_CODE_API_KEY: providerKey };
    const ziniao = config.integrations.ziniao;
    const mabang = config.integrations.mabang;
    const feishu = config.integrations.feishu;
    const ziniaoConfigured = ziniao.managed && this.ziniaoIssues(ziniao, secrets).length === 0;
    const mabangConfigured = mabang.managed && this.mabangIssues(mabang, secrets).length === 0;
    const feishuConfigured = feishu.managed && this.feishuIssues(feishu, secrets).length === 0;
    const diagnostic = config.logging.profile === "diagnostic";
    const logsEnabled = config.logging.profile !== "off";
    const cloudEnabled = config.cloud.managed && Boolean(text(secrets.data_server_api_key));
    return {
      AGENT_LLM_PROVIDER: config.provider,
      ...providerEnvironment,
      ZINIAO_REGISTER_PLANNER_TOOLS: ziniaoConfigured ? "1" : "0",
      ZINIAO_COMPANY: ziniaoConfigured ? ziniao.company : "",
      ZINIAO_USERNAME: ziniaoConfigured ? ziniao.username : "",
      ZINIAO_PASSWORD: ziniaoConfigured ? secrets.ziniao_password : "",
      ZINIAO_BROWSER_VERSION: ziniao.app_version,
      ZINIAO_CLIENT_PATH: ziniaoConfigured ? ziniao.app_path : "",
      ZINIAO_WEBDRIVER_PATH: ziniaoConfigured ? ziniao.webdriver_path : "",
      MABANG_ACCOUNT: mabangConfigured ? mabang.account : "",
      MABANG_PASSWORD: mabangConfigured ? secrets.mabang_password : "",
      FEISHU_GATEWAY_ENABLED: feishuConfigured ? "1" : "0",
      FEISHU_APP_ID: feishuConfigured ? feishu.app_id : "",
      FEISHU_APP_SECRET: feishuConfigured ? secrets.feishu_app_secret : "",
      LOCAL_LOGS_ENABLED: logsEnabled ? "1" : "0",
      LOCAL_LOG_RETENTION_DAYS: String(config.logging.retention_days),
      RUNTIME_LOG_LEVEL: diagnostic ? "DEBUG" : "INFO",
      AGENT_STREAM_TRACE_ENABLED: diagnostic ? "1" : "0",
      AGENT_SSE_WIRE_TRACE_ENABLED: diagnostic ? "1" : "0",
      ZINIAO_DIAGNOSTIC_TRACE_ENABLED: diagnostic ? "1" : "0",
      FEISHU_RAW_EVENT_DUMP_ENABLED: diagnostic ? "1" : "0",
      LXE_DATA_SERVER_ENABLED: cloudEnabled ? "1" : "0",
      LXE_DATA_SERVER_URL: cloudEnabled ? config.cloud.data_server_url : "",
      LXE_DATA_SERVER_API_KEY: cloudEnabled ? secrets.data_server_api_key : "",
      LXE_DATA_SERVER_SYNC_INTERVAL_SECONDS: String(config.cloud.sync_interval_seconds),
      LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "0",
    };
  }

  private ziniaoIssues(
    ziniao: DesktopConfig["integrations"]["ziniao"],
    secrets: DesktopSecrets,
  ): string[] {
    const issues = [
      !ziniao.company && "缺少公司名",
      !ziniao.username && "缺少账号",
      !secrets.ziniao_password && "缺少密码",
      !ziniao.app_path && "缺少紫鸟 APP 文件地址",
      !ziniao.webdriver_path && "缺少浏览器驱动安装目录",
    ].filter((value): value is string => Boolean(value));
    if (ziniao.app_path) {
      try {
        this.validateZiniaoPaths(ziniao.app_path, ziniao.webdriver_path);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    } else if (ziniao.webdriver_path
      && this.pathExists(ziniao.webdriver_path)
      && !this.pathIsDirectory(ziniao.webdriver_path)) {
      issues.push("紫鸟浏览器驱动安装地址必须是目录");
    }
    return issues;
  }

  private mabangIssues(
    mabang: DesktopConfig["integrations"]["mabang"],
    secrets: DesktopSecrets,
  ): string[] {
    return [
      !mabang.account && "缺少账号",
      !secrets.mabang_password && "缺少密码",
    ].filter((value): value is string => Boolean(value));
  }

  private feishuIssues(
    feishu: DesktopConfig["integrations"]["feishu"],
    secrets: DesktopSecrets,
  ): string[] {
    return [
      !feishu.app_id && "缺少 App ID",
      !secrets.feishu_app_secret && "缺少 App Secret",
    ].filter((value): value is string => Boolean(value));
  }

  private validateZiniaoPaths(appPath: string, webdriverPath: string): void {
    if (!this.pathExists(appPath)) throw new Error("紫鸟 APP 文件不存在");
    if (this.platform === "win32" && extname(appPath).toLowerCase() !== ".exe") {
      throw new Error("Windows 紫鸟 APP 必须是 .exe 文件");
    }
    if (this.platform === "win32" && this.pathIsDirectory(appPath)) {
      throw new Error("Windows 紫鸟 APP 必须是 .exe 文件");
    }
    if (this.platform === "darwin") {
      const appBundle = extname(appPath).toLowerCase() === ".app";
      if ((appBundle && !this.pathIsDirectory(appPath))
        || (!appBundle && (this.pathIsDirectory(appPath) || !this.pathIsExecutable(appPath)))) {
        throw new Error("macOS 紫鸟 APP 必须是 .app 或可执行文件");
      }
    }
    if (this.pathExists(webdriverPath) && !this.pathIsDirectory(webdriverPath)) {
      throw new Error("紫鸟浏览器驱动安装地址必须是目录");
    }
  }

  private validateWorkspaceRoot(value: string): string {
    const requestedWorkspace = text(value);
    if (!requestedWorkspace) throw new Error("Workspace is required");
    const workspace = resolveWorkspaceContext(requestedWorkspace);
    accessSync(workspace.directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return workspace.directory;
  }

  private readConfig(): DesktopConfig {
    try {
      const value = objectValue(JSON.parse(readFileSync(this.configPath, "utf8")));
      const provider = text(value.provider);
      const integrations = objectValue(value.integrations);
      const rawZiniao = objectValue(integrations.ziniao);
      const rawMabang = objectValue(integrations.mabang);
      const rawFeishu = objectValue(integrations.feishu);
      const rawLogging = objectValue(value.logging);
      const rawCloud = objectValue(value.cloud);
      const legacyFeishuAppId = text(value.feishu_app_id);
      return {
        schema_version: 3,
        migration_version: Number.isFinite(Number(value.migration_version))
          ? Math.max(0, Math.trunc(Number(value.migration_version)))
          : 0,
        provider: ["kimi_coding", "deepseek", "glm"].includes(provider)
          ? provider as DesktopConfig["provider"]
          : DEFAULT_CONFIG.provider,
        workspace_root: text(value.workspace_root),
        integrations: {
          ziniao: {
            managed: Boolean(rawZiniao.managed),
            company: text(rawZiniao.company),
            username: text(rawZiniao.username),
            app_version: ziniaoVersion(rawZiniao.app_version, this.platform),
            app_path: text(rawZiniao.app_path),
            webdriver_path: text(rawZiniao.webdriver_path),
          },
          mabang: {
            managed: Boolean(rawMabang.managed),
            account: text(rawMabang.account),
          },
          feishu: {
            managed: Boolean(rawFeishu.managed) || Boolean(legacyFeishuAppId),
            app_id: text(rawFeishu.app_id) || legacyFeishuAppId,
          },
        },
        logging: {
          profile: logProfile(rawLogging.profile),
          retention_days: logRetention(rawLogging.retention_days),
        },
        cloud: {
          managed: Boolean(rawCloud.managed),
          device_id: text(rawCloud.device_id),
          device_name: text(rawCloud.device_name),
          vpn_ip: text(rawCloud.vpn_ip),
          data_server_url: text(rawCloud.data_server_url),
          sync_interval_seconds: Math.max(
            30,
            Number.isFinite(Number(rawCloud.sync_interval_seconds))
              ? Math.trunc(Number(rawCloud.sync_interval_seconds))
              : 3_600,
          ),
          tunnel_name: text(rawCloud.tunnel_name) || "lxe-agent",
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return cloneConfig();
    }
  }

  private readSecrets(): DesktopSecrets {
    let encrypted: Buffer;
    try {
      encrypted = readFileSync(this.secretsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return cloneSecrets();
    }
    this.requireSafeStorage();
    const value = objectValue(JSON.parse(this.safeStorage.decryptString(encrypted)));
    const keys = objectValue(value.provider_keys);
    return {
      provider_keys: {
        kimi_coding: text(keys.kimi_coding),
        deepseek: text(keys.deepseek),
        glm: text(keys.glm),
      },
      ziniao_password: text(value.ziniao_password),
      mabang_password: text(value.mabang_password),
      feishu_app_secret: text(value.feishu_app_secret),
      data_server_api_key: text(value.data_server_api_key),
    };
  }

  private requireSafeStorage(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system");
    }
  }

  private commit(config: DesktopConfig, secrets: DesktopSecrets): void {
    const previousConfig = this.readRaw(this.configPath);
    const previousSecrets = this.readRaw(this.secretsPath);
    try {
      this.writeSecrets(secrets);
      this.writeJson(this.configPath, config);
    } catch (error) {
      this.restoreRaw(this.configPath, previousConfig);
      this.restoreRaw(this.secretsPath, previousSecrets);
      throw error;
    }
  }

  private readRaw(path: string): Buffer | undefined {
    try {
      return readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private restoreRaw(path: string, value: Buffer | undefined): void {
    if (value === undefined) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }

  private writeSecrets(secrets: DesktopSecrets): void {
    this.requireSafeStorage();
    mkdirSync(dirname(this.secretsPath), { recursive: true });
    const temporary = `${this.secretsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, this.safeStorage.encryptString(JSON.stringify(secrets)));
    renameSync(temporary, this.secretsPath);
  }

  private writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  }

  private removeMigratedSecrets(path: string): void {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const filtered = content.split(/\r?\n/u).filter((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
      return !match?.[1] || !SECRET_ENV_NAMES.has(match[1]);
    });
    this.writeText(path, `${filtered.join("\n").replace(/\n+$/u, "")}\n`);
  }

  private writeText(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  }
}

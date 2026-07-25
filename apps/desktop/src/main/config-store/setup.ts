import { join, resolve } from "node:path";
import type { DesktopSetupInput, DesktopSetupState } from "@lxe/desktop-protocol";
import {
  cloneConfig,
  logProfile,
  logRetention,
  MIGRATION_VERSION,
  text,
  ziniaoVersion,
} from "./model";
import type { DesktopConfigRepository } from "./repository";
import { effectiveDesktopSecrets } from "./secrets";
import type { DesktopConfigValidation } from "./validation";

export class DesktopSetupService {
  constructor(
    private readonly dataRoot: string,
    private readonly defaultWorkspaceRoot: string,
    private readonly repository: DesktopConfigRepository,
    private readonly validation: DesktopConfigValidation,
    private readonly secretEnvironment: Readonly<Record<string, string | undefined>> = {},
  ) {}

  state(): DesktopSetupState {
    const config = this.repository.readConfig();
    const secrets = this.effectiveSecrets();
    const providerKey = text(secrets.provider_keys[config.llm.provider]);
    const workspaceRoot = config.workspace_root || this.defaultWorkspaceRoot;
    const workspaceAvailable = this.validation.workspaceAvailable(workspaceRoot);
    const ziniao = config.integrations.ziniao;
    const mabang = config.integrations.mabang;
    const feishu = config.integrations.feishu;
    const ziniaoIssues = ziniao.managed ? this.validation.ziniaoIssues(ziniao, secrets) : [];
    const mabangIssues = mabang.managed ? this.validation.mabangIssues(mabang, secrets) : [];
    const feishuIssues = feishu.managed ? this.validation.feishuIssues(feishu, secrets) : [];
    const ziniaoConfigured = ziniao.managed && ziniaoIssues.length === 0;
    const mabangConfigured = mabang.managed && mabangIssues.length === 0;
    const feishuConfigured = feishu.managed && feishuIssues.length === 0;
    return {
      complete: Boolean(providerKey && workspaceAvailable),
      provider: config.llm.provider,
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
    this.repository.requireSafeStorage();
    const provider = input.provider;
    if (!["kimi_coding", "deepseek", "glm"].includes(provider)) {
      throw new Error("Unsupported model provider");
    }
    const workspaceRoot = this.validation.validateWorkspaceRoot(text(input.workspace_root) || this.defaultWorkspaceRoot);
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    const effectiveSecrets = this.effectiveSecrets(secrets);
    config.llm.provider = provider;
    config.workspace_root = workspaceRoot;
    config.migration_version = Math.max(config.migration_version, MIGRATION_VERSION);
    if (text(input.api_key)) secrets.provider_keys[provider] = text(input.api_key);
    if (!text(input.api_key) && !effectiveSecrets.provider_keys[provider]) {
      throw new Error("Model API key is required");
    }

    if (input.ziniao?.action === "clear") {
      config.integrations.ziniao = { ...cloneConfig().integrations.ziniao, managed: true };
      secrets.ziniao_password = "";
    } else if (input.ziniao?.action === "save") {
      const company = text(input.ziniao.company);
      const username = text(input.ziniao.username);
      const appPath = text(input.ziniao.app_path);
      const webdriverPath = text(input.ziniao.webdriver_path);
      const inputPassword = text(input.ziniao.password);
      const password = inputPassword || effectiveSecrets.ziniao_password;
      const missing = [
        !company && "公司名",
        !username && "账号",
        !password && "密码",
        !appPath && "紫鸟 APP 文件地址",
        !webdriverPath && "浏览器驱动安装目录",
      ].filter(Boolean);
      if (missing.length > 0) throw new Error(`紫鸟配置缺少：${missing.join("、")}`);
      this.validation.validateZiniaoPaths(appPath, webdriverPath);
      config.integrations.ziniao = {
        managed: true,
        company,
        username,
        app_version: ziniaoVersion(input.ziniao.app_version, this.validation.platform),
        app_path: resolve(appPath),
        webdriver_path: resolve(webdriverPath),
      };
      if (inputPassword) secrets.ziniao_password = inputPassword;
    }

    if (input.mabang?.action === "clear") {
      config.integrations.mabang = { managed: true, account: "" };
      secrets.mabang_password = "";
    } else if (input.mabang?.action === "save") {
      const account = text(input.mabang.account);
      const inputPassword = text(input.mabang.password);
      const password = inputPassword || effectiveSecrets.mabang_password;
      if (!account || !password) throw new Error("马帮账号和密码必须同时填写");
      config.integrations.mabang = { managed: true, account };
      if (inputPassword) secrets.mabang_password = inputPassword;
    }

    if (input.feishu?.action === "clear") {
      config.integrations.feishu = { managed: true, app_id: "" };
      secrets.feishu_app_secret = "";
    } else if (input.feishu?.action === "save") {
      const appId = text(input.feishu.app_id);
      const inputSecret = text(input.feishu.app_secret);
      const appSecret = inputSecret || effectiveSecrets.feishu_app_secret;
      if (!appId || !appSecret) throw new Error("飞书 App ID 和 App Secret 必须同时填写");
      config.integrations.feishu = { managed: true, app_id: appId };
      if (inputSecret) secrets.feishu_app_secret = inputSecret;
    }

    if (input.logging) {
      config.logging = {
        profile: logProfile(input.logging.profile),
        retention_days: logRetention(input.logging.retention_days),
      };
    }
    this.repository.commit(config, secrets);
    return this.state();
  }

  saveRuntimePreference(provider: string, model: string, thinkingLevel: string): void {
    if (provider !== "kimi_coding" && provider !== "deepseek" && provider !== "glm") {
      throw new Error(`Unsupported model provider: ${provider}`);
    }
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    config.llm.provider = provider;
    config.llm.profiles[provider] = {
      model: text(model),
      thinking_level: text(thinkingLevel) || "off",
    };
    this.repository.commit(config, secrets);
  }

  environment(): Record<string, string> {
    const config = this.repository.readConfig();
    const secrets = this.effectiveSecrets();
    const provider = config.llm.provider;
    const providerEnvironment = {
      KIMI_CODE_API_KEY: text(secrets.provider_keys.kimi_coding),
      DEEPSEEK_API: text(secrets.provider_keys.deepseek),
      GLM_API_KEY: text(secrets.provider_keys.glm),
    };
    const preferenceEnvironment: Record<string, string> = {};
    for (const [name, preference] of Object.entries(config.llm.profiles)) {
      if (!preference) continue;
      const suffix = name.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, "_");
      preferenceEnvironment[`AGENT_LLM_MODEL_${suffix}`] = preference.model;
      preferenceEnvironment[`AGENT_LLM_THINKING_ENABLED_${suffix}`] = preference.thinking_level === "off" ? "0" : "1";
      preferenceEnvironment[`AGENT_LLM_THINKING_EFFORT_${suffix}`] = preference.thinking_level;
    }
    const activePreference = config.llm.profiles[provider];
    const activeThinkingLevel = activePreference?.thinking_level ?? "off";
    const ziniao = config.integrations.ziniao;
    const mabang = config.integrations.mabang;
    const feishu = config.integrations.feishu;
    const ziniaoConfigured = ziniao.managed && this.validation.ziniaoIssues(ziniao, secrets).length === 0;
    const mabangConfigured = mabang.managed && this.validation.mabangIssues(mabang, secrets).length === 0;
    const feishuConfigured = feishu.managed && this.validation.feishuIssues(feishu, secrets).length === 0;
    const diagnostic = config.logging.profile === "diagnostic";
    const logsEnabled = config.logging.profile !== "off";
    const cloudEnabled = config.cloud.managed && Boolean(text(secrets.data_server_api_key));
    return {
      AGENT_LLM_PROVIDER: provider,
      AGENT_LLM_MODEL: activePreference?.model ?? "",
      AGENT_LLM_THINKING_ENABLED: activeThinkingLevel === "off" ? "0" : "1",
      AGENT_LLM_THINKING_EFFORT: activeThinkingLevel,
      ...preferenceEnvironment,
      ...providerEnvironment,
      ...config.output_directories,
      ZINIAO_REGISTER_PLANNER_TOOLS: ziniaoConfigured ? "1" : "0",
      ZINIAO_COMPANY: ziniaoConfigured ? ziniao.company : "",
      ZINIAO_USERNAME: ziniaoConfigured ? ziniao.username : "",
      ZINIAO_PASSWORD: ziniaoConfigured ? secrets.ziniao_password : "",
      ZINIAO_BROWSER_VERSION: ziniao.app_version,
      ZINIAO_CLIENT_PATH: ziniaoConfigured ? ziniao.app_path : "",
      ZINIAO_WEBDRIVER_PATH: ziniaoConfigured ? ziniao.webdriver_path : "",
      MABANG_ACCOUNT: mabangConfigured ? mabang.account : "",
      MABANG_PASSWORD: mabangConfigured ? secrets.mabang_password : "",
      LXE_FEISHU_GATEWAY_ENABLED: feishuConfigured ? "1" : "0",
      FEISHU_APP_ID: feishuConfigured ? feishu.app_id : "",
      FEISHU_APP_SECRET: feishuConfigured ? secrets.feishu_app_secret : "",
      LOCAL_LOGS_ENABLED: logsEnabled ? "1" : "0",
      LOCAL_LOG_RETENTION_DAYS: String(config.logging.retention_days),
      LOG_LEVEL: diagnostic ? "DEBUG" : "INFO",
      LOG_LEVELS: "",
      RUNTIME_LOG_LEVEL: diagnostic ? "DEBUG" : "INFO",
      AGENT_SSE_WIRE_TRACE_ENABLED: diagnostic ? "1" : "0",
      ZINIAO_DIAGNOSTIC_TRACE_ENABLED: diagnostic ? "1" : "0",
      FEISHU_RAW_EVENT_DUMP_ENABLED: diagnostic ? "1" : "0",
      LXE_DATA_SERVER_ENABLED: cloudEnabled ? "1" : "0",
      LXE_DATA_SERVER_URL: cloudEnabled ? config.cloud.data_server_url : "",
      LXE_DATA_SERVER_API_KEY: cloudEnabled ? secrets.data_server_api_key : "",
      LXE_DATA_SERVER_FALLBACK_API_KEY: config.cloud.local_fallback_enabled
        ? secrets.data_server_fallback_api_key
        : "",
      LXE_ERP_API_KEY: cloudEnabled ? secrets.erp_api_key : "",
      LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: config.cloud.local_fallback_enabled ? "1" : "0",
      LXE_DATA_SERVER_FALLBACK_URL: config.cloud.local_fallback_url,
      BROWSER_AUTH_HEADLESS: "1",
    };
  }

  private effectiveSecrets(persisted = this.repository.readSecrets()) {
    return effectiveDesktopSecrets(persisted, this.secretEnvironment);
  }
}

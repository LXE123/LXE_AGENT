import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CredentialSource,
  DesktopModelProvider,
  DesktopLocalModelCredentialInput,
  DesktopSetupInput,
  DesktopSetupState,
  ManagedLlmCredential,
  ManagedLlmTarget,
} from "@lxe/desktop-protocol";
import type { LlmProviderCatalog } from "@lxe/core";
import {
  cloneConfig,
  logProfile,
  logRetention,
  MODEL_AUTH_MIGRATION_VERSION,
  text,
  ziniaoVersion,
} from "./model";
import type { DesktopConfigRepository } from "./repository";
import type { DesktopLocalAuthStore } from "./auth-store";
import { effectiveDesktopSecrets } from "./secrets";
import type { DesktopConfigValidation } from "./validation";
import { managedLlmTargetSupported } from "../managed-llm";

const sameManagedTarget = (
  left: ManagedLlmTarget,
  right: ManagedLlmTarget,
): boolean => left.provider === right.provider && left.model === right.model;

export class DesktopSetupService {
  constructor(
    private readonly dataRoot: string,
    private readonly defaultWorkspaceRoot: string,
    private readonly repository: DesktopConfigRepository,
    private readonly auth: DesktopLocalAuthStore,
    private readonly validation: DesktopConfigValidation,
    private readonly catalog: LlmProviderCatalog,
    private readonly secretEnvironment: Readonly<Record<string, string | undefined>> = {},
    private readonly llmConfigRoot = join(process.cwd(), "config", "llm"),
  ) {}

  private defaultProfile(providerName: string, modelName?: string): { model: string; thinking_level: string } {
    const provider = this.catalog.requireProvider(providerName);
    const model = this.catalog.resolveModel(provider, modelName) ?? provider.defaultModel;
    return { model, thinking_level: provider.models[model]!.thinkingDefault };
  }

  private localCandidates(preferred: string): DesktopModelProvider[] {
    return [...new Set([preferred, ...this.catalog.providers.map((provider) => provider.name)])];
  }

  state(): DesktopSetupState {
    const config = this.repository.readConfig();
    const secrets = this.effectiveSecrets();
    const localAuth = this.auth.snapshot();
    const providerKeyConfigured = Boolean(localAuth.configured[config.llm.provider]);
    const localProvider = this.catalog.provider(config.llm.last_local_provider)?.name ?? this.catalog.defaultProvider;
    const managedCredential = config.cloud.switch_in_progress
      ? null
      : secrets.managed_llm_credential;
    const managedModelConfigured = Boolean(
      managedCredential
      && sameManagedTarget(managedCredential, config.llm.managed_target)
      && managedLlmTargetSupported(this.llmConfigRoot, managedCredential)
      && managedCredential.invalid_revision !== managedCredential.credential_revision,
    );
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
      complete: Boolean(
        workspaceAvailable
        && (config.llm.credential_source === "cloud" ? managedModelConfigured : providerKeyConfigured),
      ),
      provider: config.llm.provider,
      local_provider: localProvider,
      credential_source: config.llm.credential_source,
      managed_model_configured: managedModelConfigured,
      local_model_providers: this.catalog.providers.map((provider) => ({
        provider: provider.name,
        label: provider.label,
        configured: Boolean(localAuth.configured[provider.name]),
      })),
      local_auth_path: this.auth.path,
      local_auth_error: localAuth.error,
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
    };
  }

  save(input: DesktopSetupInput): DesktopSetupState {
    this.repository.requireSafeStorage();
    const workspaceRoot = this.validation.validateWorkspaceRoot(text(input.workspace_root) || this.defaultWorkspaceRoot);
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    const effectiveSecrets = this.effectiveSecrets(secrets);
    config.workspace_root = workspaceRoot;

    if (input.ziniao?.action === "clear") {
      config.integrations.ziniao = { ...cloneConfig(this.catalog).integrations.ziniao, managed: true };
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

  migrateModelCredentialStorage(): void {
    const config = this.repository.readConfig();
    if (config.migration_version >= MODEL_AUTH_MIGRATION_VERSION) return;
    const secrets = this.repository.readSecrets();
    if (config.migration_version < 4) {
      const defaultProvider = this.catalog.requireProvider(this.catalog.defaultProvider);
      const defaultProfile = this.defaultProfile(defaultProvider.name);
      config.llm.provider = defaultProvider.name;
      config.llm.credential_source = "cloud";
      config.llm.last_local_provider = defaultProvider.name;
      config.llm.profiles[defaultProvider.name] = {
        model: defaultProfile.model,
        thinking_level: config.llm.profiles[defaultProvider.name]?.thinking_level
          || defaultProfile.thinking_level,
      };
      this.repository.commit(config, secrets);
      rmSync(join(this.dataRoot, ".env"), { force: true });
      rmSync(join(this.dataRoot, ".env.local"), { force: true });
      config.migration_version = 4;
      this.repository.commit(config, secrets);
    }

    this.auth.deleteRetiredProvider("glm");
    const configured = this.auth.snapshot().configured;
    const storedManagedCredential = secrets.managed_llm_credential;
    if (storedManagedCredential) {
      config.llm.managed_target = {
        provider: storedManagedCredential.provider,
        model: storedManagedCredential.model,
      };
    }
    const managedCredential = storedManagedCredential
      && managedLlmTargetSupported(this.llmConfigRoot, storedManagedCredential)
      ? storedManagedCredential
      : null;
    if (storedManagedCredential && !managedCredential) {
      secrets.managed_llm_credential = null;
    }
    const validManagedCredential = managedCredential
      && managedCredential.invalid_revision !== managedCredential.credential_revision
      ? { ...managedCredential, provider: managedCredential.provider }
      : null;
    const localCandidates = this.localCandidates(config.llm.last_local_provider);
    const localFallback = localCandidates.find((provider) => configured[provider]);
    if (config.llm.credential_source === "cloud" && validManagedCredential) {
      config.llm.provider = validManagedCredential.provider;
      config.llm.managed_target = {
        provider: validManagedCredential.provider,
        model: validManagedCredential.model,
      };
      config.llm.profiles[validManagedCredential.provider] = {
        model: validManagedCredential.model,
        thinking_level: config.llm.profiles[validManagedCredential.provider]?.thinking_level
          || this.defaultProfile(validManagedCredential.provider, validManagedCredential.model).thinking_level,
      };
    } else if (!configured[config.llm.provider]) {
      if (localFallback) {
        config.llm.provider = localFallback;
        config.llm.credential_source = "local";
        config.llm.last_local_provider = localFallback;
      } else if (validManagedCredential) {
        config.llm.provider = validManagedCredential.provider;
        config.llm.credential_source = "cloud";
        config.llm.managed_target = {
          provider: validManagedCredential.provider,
          model: validManagedCredential.model,
        };
      } else {
        config.llm.provider = this.catalog.defaultProvider;
        config.llm.credential_source = "local";
        config.llm.last_local_provider = this.catalog.defaultProvider;
      }
    }
    if (!configured[config.llm.last_local_provider]) {
      config.llm.last_local_provider = localFallback ?? this.catalog.defaultProvider;
    }
    config.migration_version = MODEL_AUTH_MIGRATION_VERSION;
    this.repository.commit(config, secrets);
  }

  saveLocalModelCredential(input: DesktopLocalModelCredentialInput): DesktopSetupState {
    const provider = this.catalog.requireProvider(input.provider);
    this.auth.save(provider.name, input.api_key);
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    config.llm.profiles[provider.name] ??= this.defaultProfile(provider.name);
    config.llm.last_local_provider = provider.name;
    const managedCredential = secrets.managed_llm_credential;
    const managedConfigured = Boolean(
      managedCredential
      && sameManagedTarget(managedCredential, config.llm.managed_target)
      && managedLlmTargetSupported(this.llmConfigRoot, managedCredential)
      && managedCredential.invalid_revision !== managedCredential.credential_revision,
    );
    if (!managedConfigured) {
      config.llm.provider = provider.name;
      config.llm.credential_source = "local";
    }
    this.repository.commit(config, secrets);
    return this.state();
  }

  deleteLocalModelCredential(provider: DesktopModelProvider): DesktopSetupState {
    const selectedProvider = this.catalog.requireProvider(provider).name;
    this.auth.delete(selectedProvider);
    const config = this.repository.readConfig();
    if (config.llm.credential_source !== "local" || config.llm.provider !== selectedProvider) return this.state();
    const secrets = this.repository.readSecrets();
    const managedCredential = secrets.managed_llm_credential;
    if (managedCredential
      && sameManagedTarget(managedCredential, config.llm.managed_target)
      && managedLlmTargetSupported(this.llmConfigRoot, managedCredential)
      && managedCredential.invalid_revision !== managedCredential.credential_revision) {
      config.llm.provider = managedCredential.provider;
      config.llm.credential_source = "cloud";
      config.llm.profiles[managedCredential.provider] = {
        model: managedCredential.model,
        thinking_level: config.llm.profiles[managedCredential.provider]?.thinking_level
          || this.defaultProfile(managedCredential.provider, managedCredential.model).thinking_level,
      };
    } else {
      const configured = this.auth.snapshot().configured;
      const candidates = this.localCandidates(config.llm.last_local_provider);
      const fallback = candidates.find((candidate) => configured[candidate]);
      if (fallback) {
        config.llm.provider = fallback;
        config.llm.credential_source = "local";
        config.llm.last_local_provider = fallback;
      } else {
        config.llm.provider = this.catalog.defaultProvider;
        config.llm.credential_source = "local";
        config.llm.last_local_provider = this.catalog.defaultProvider;
      }
    }
    this.repository.commit(config, secrets);
    return this.state();
  }

  saveRuntimePreference(
    provider: string,
    model: string,
    thinkingLevel: string,
    credentialSource: CredentialSource = "local",
  ): void {
    const selectedProvider = this.catalog.requireProvider(provider);
    const selectedModel = this.catalog.requireModel(selectedProvider, model);
    const level = text(thinkingLevel) || "off";
    const allowedLevels = selectedModel.thinkingLevels.length > 0 ? selectedModel.thinkingLevels : ["off"];
    if (!allowedLevels.includes(level)) {
      throw new Error(`Unsupported thinking level: ${selectedProvider.name}/${selectedModel.id}/${level}`);
    }
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    config.llm.provider = selectedProvider.name;
    config.llm.credential_source = credentialSource;
    if (credentialSource === "local") config.llm.last_local_provider = selectedProvider.name;
    config.llm.profiles[selectedProvider.name] = {
      model: selectedModel.id,
      thinking_level: level,
    };
    this.repository.commit(config, secrets);
  }

  managedLlmCredential(): ManagedLlmCredential | null {
    return this.repository.readSecrets().managed_llm_credential;
  }

  managedLlmTarget(): ManagedLlmTarget {
    return structuredClone(this.repository.readConfig().llm.managed_target);
  }

  saveManagedLlmTarget(target: ManagedLlmTarget): void {
    const config = this.repository.readConfig();
    if (sameManagedTarget(config.llm.managed_target, target)) return;
    config.llm.managed_target = structuredClone(target);
    this.repository.commit(config, this.repository.readSecrets());
  }

  saveManagedLlmCredential(credential: ManagedLlmCredential): void {
    this.repository.requireSafeStorage();
    if (!managedLlmTargetSupported(this.llmConfigRoot, credential)) {
      throw new Error(`Unsupported managed model: ${credential.provider}/${credential.model}`);
    }
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    secrets.managed_llm_credential = { ...credential, invalid_revision: "" };
    config.llm.managed_target = { provider: credential.provider, model: credential.model };
    const hasLocalProvider = Object.values(this.auth.snapshot().configured).some(Boolean);
    if (config.llm.credential_source === "cloud" || !hasLocalProvider) {
      config.llm.provider = credential.provider;
      config.llm.credential_source = "cloud";
      config.llm.profiles[credential.provider] = {
        model: credential.model,
        thinking_level: config.llm.profiles[credential.provider]?.thinking_level
          || this.defaultProfile(credential.provider, credential.model).thinking_level,
      };
    }
    this.repository.commit(config, secrets);
  }

  invalidateManagedLlmCredential(revision: string): void {
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    if (!secrets.managed_llm_credential
      || secrets.managed_llm_credential.credential_revision !== text(revision)) return;
    secrets.managed_llm_credential.invalid_revision = text(revision);
    this.repository.commit(config, secrets);
  }

  clearManagedLlmCredential(): void {
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    if (!secrets.managed_llm_credential) return;
    secrets.managed_llm_credential = null;
    this.repository.commit(config, secrets);
  }

  environment(): Record<string, string> {
    const config = this.repository.readConfig();
    const secrets = this.effectiveSecrets();
    const provider = config.llm.provider;
    const storedManagedCredential = config.cloud.switch_in_progress
      ? null
      : secrets.managed_llm_credential;
    const managedCredential = storedManagedCredential
      && sameManagedTarget(storedManagedCredential, config.llm.managed_target)
      && managedLlmTargetSupported(this.llmConfigRoot, storedManagedCredential)
      ? storedManagedCredential
      : null;
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
    const cloudEnabled = config.cloud.managed
      && !config.cloud.switch_in_progress
      && Boolean(text(secrets.data_server_api_key));
    return {
      AGENT_LLM_PROVIDER: provider,
      AGENT_LLM_CREDENTIAL_SOURCE: config.llm.credential_source,
      AGENT_LLM_MODEL: activePreference?.model ?? "",
      AGENT_LLM_THINKING_ENABLED: activeThinkingLevel === "off" ? "0" : "1",
      AGENT_LLM_THINKING_EFFORT: activeThinkingLevel,
      ...preferenceEnvironment,
      LXE_MANAGED_LLM_PROVIDER: config.llm.managed_target.provider,
      LXE_MANAGED_LLM_MODEL: config.llm.managed_target.model,
      LXE_MANAGED_LLM_API_KEY: managedCredential?.api_key ?? "",
      LXE_MANAGED_LLM_CREDENTIAL_REVISION: managedCredential?.credential_revision ?? "",
      LXE_MANAGED_LLM_INVALID_REVISION: managedCredential?.invalid_revision ?? "",
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
      LXE_SAIHU_MCP_API_KEY: secrets.saihu_mcp_api_key,
      LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: config.cloud.local_fallback_enabled ? "1" : "0",
      LXE_DATA_SERVER_FALLBACK_URL: config.cloud.local_fallback_url,
      BROWSER_AUTH_HEADLESS: "1",
    };
  }

  private effectiveSecrets(persisted = this.repository.readSecrets()) {
    return effectiveDesktopSecrets(persisted, this.secretEnvironment);
  }
}

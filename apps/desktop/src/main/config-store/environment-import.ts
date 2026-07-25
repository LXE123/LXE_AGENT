import { resolve } from "node:path";
import type {
  DesktopConfigImportGroupPreview,
  DesktopLogRetentionDays,
  DesktopSetupInput,
} from "@lxe/desktop-protocol";
import {
  flag,
  LOG_RETENTION_DAYS,
  MIGRATION_VERSION,
  OUTPUT_DIRECTORY_ENV_NAMES,
  text,
  ziniaoVersion,
} from "./model";
import type { PreparedDesktopConfigImport } from "./public-types";
import type { DesktopConfigRepository } from "./repository";
import type { DesktopSetupService } from "./setup";
import type { DesktopConfigValidation } from "./validation";

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

export class DesktopEnvironmentImport {
  constructor(
    private readonly repository: DesktopConfigRepository,
    private readonly setup: DesktopSetupService,
    private readonly validation: DesktopConfigValidation,
  ) {}

  prepare(
    environment: Readonly<Record<string, string | undefined>>,
  ): PreparedDesktopConfigImport {
    this.repository.requireSafeStorage();
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
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
        if (config.llm.provider !== explicitProvider) baseOverwrites.push("模型服务");
        config.llm.provider = explicitProvider;
      } else {
        warnings.push("文件指定的模型服务没有对应 API Key，已保留当前模型服务");
      }
    } else if (!secrets.provider_keys[config.llm.provider]) {
      if (importedProviders.length === 1) config.llm.provider = importedProviders[0]!;
      else if (importedProviders.length > 1) {
        warnings.push("检测到多个模型 API Key，无法自动选择模型服务，请在导入后手动选择");
      }
    }
    const importedModel = imported("AGENT_LLM_MODEL");
    const importedThinkingEnabled = imported("AGENT_LLM_THINKING_ENABLED");
    const importedThinkingEffort = imported("AGENT_LLM_THINKING_EFFORT");
    if (importedModel || importedThinkingEnabled || importedThinkingEffort) {
      const previous = config.llm.profiles[config.llm.provider];
      const thinkingLevel = importedThinkingEnabled && !flag(importedThinkingEnabled)
        ? "off"
        : importedThinkingEffort || previous?.thinking_level || "off";
      config.llm.profiles[config.llm.provider] = {
        model: importedModel || previous?.model || "",
        thinking_level: thinkingLevel,
      };
      baseFields.push("模型运行偏好");
      if (previous) baseOverwrites.push("模型运行偏好");
    }
    const workspaceRoot = imported("LXE_WORKSPACE_ROOT");
    if (workspaceRoot) {
      const validatedWorkspace = this.validation.validateWorkspaceRoot(workspaceRoot);
      baseFields.push("默认工作区");
      if (previousConfig.workspace_root && resolve(previousConfig.workspace_root) !== validatedWorkspace) {
        baseOverwrites.push("默认工作区");
      }
      config.workspace_root = validatedWorkspace;
    }
    if (baseFields.length > 0) {
      const issues = secrets.provider_keys[config.llm.provider] ? [] : ["缺少所选模型服务的 API Key"];
      groups.push({
        group: "base",
        label: "基础设置",
        status: issues.length === 0 ? "ready" : "pending",
        detected_fields: baseFields,
        overwritten_fields: [...new Set(baseOverwrites)],
        issues,
      });
    }

    const outputFields: string[] = [];
    const outputOverwrites: string[] = [];
    for (const name of OUTPUT_DIRECTORY_ENV_NAMES) {
      const value = imported(name);
      if (!value) continue;
      outputFields.push(name);
      if (previousConfig.output_directories[name]) outputOverwrites.push(name);
      config.output_directories[name] = resolve(value);
    }
    if (outputFields.length > 0) {
      groups.push({
        group: "outputs",
        label: "业务输出目录",
        status: "ready",
        detected_fields: outputFields,
        overwritten_fields: outputOverwrites,
        issues: [],
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
        const nextVersion = ziniaoVersion(rawZiniaoVersion, this.validation.platform);
        if (nextVersion !== ziniao.app_version) ziniaoOverwrites.push("紫鸟 APP 版本");
        ziniao.app_version = nextVersion;
        if (this.validation.platform === "darwin" && rawZiniaoVersion === "v5") {
          warnings.push("macOS 仅支持紫鸟 v6，导入时已按 v6 处理");
        }
      } else {
        warnings.push(`无法识别紫鸟 APP 版本：${imported("ZINIAO_BROWSER_VERSION")}`);
      }
    }
    if (ziniaoFields.length > 0) {
      ziniao.managed = true;
      const issues = this.validation.ziniaoIssues(ziniao, secrets);
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
      const issues = this.validation.mabangIssues(config.integrations.mabang, secrets);
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
      const issues = this.validation.feishuIssues(config.integrations.feishu, secrets);
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
      "AGENT_SSE_WIRE_TRACE_ENABLED",
      "ZINIAO_DIAGNOSTIC_TRACE_ENABLED",
      "FEISHU_RAW_EVENT_DUMP_ENABLED",
    ] as const;
    const loggingFields = logNames.filter((name) => imported(name)).map((name) => ({
      LOCAL_LOGS_ENABLED: "文件日志",
      LOCAL_LOG_RETENTION_DAYS: "保留周期",
      RUNTIME_LOG_LEVEL: "日志级别",
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

    const cloudFields: string[] = [];
    const cloudOverwrites: string[] = [];
    const dataServerUrl = imported("LXE_DATA_SERVER_URL");
    if (dataServerUrl) {
      cloudFields.push("Data Server 地址");
      if (config.cloud.data_server_url) cloudOverwrites.push("Data Server 地址");
      config.cloud.data_server_url = dataServerUrl;
    }
    const dataServerKey = imported("LXE_DATA_SERVER_API_KEY");
    if (dataServerKey) {
      cloudFields.push("Data Server API Key（秘密）");
      if (previousSecrets.data_server_api_key) cloudOverwrites.push("Data Server API Key（秘密）");
      secrets.data_server_api_key = dataServerKey;
    }
    const erpKey = imported("LXE_ERP_API_KEY");
    if (erpKey) {
      cloudFields.push("ERP API Key（秘密）");
      if (previousSecrets.erp_api_key) cloudOverwrites.push("ERP API Key（秘密）");
      secrets.erp_api_key = erpKey;
    }
    const fallbackUrl = imported("LXE_DATA_SERVER_FALLBACK_URL");
    if (fallbackUrl) {
      cloudFields.push("本地回退地址");
      if (config.cloud.local_fallback_url) cloudOverwrites.push("本地回退地址");
      config.cloud.local_fallback_url = fallbackUrl;
    }
    const fallbackKey = imported("LXE_DATA_SERVER_FALLBACK_API_KEY");
    if (fallbackKey) {
      cloudFields.push("本地回退 API Key（秘密）");
      if (previousSecrets.data_server_fallback_api_key) cloudOverwrites.push("本地回退 API Key（秘密）");
      secrets.data_server_fallback_api_key = fallbackKey;
    }
    if (cloudFields.length > 0) {
      config.cloud.managed = imported("LXE_DATA_SERVER_ENABLED")
        ? flag(imported("LXE_DATA_SERVER_ENABLED"))
        : Boolean(config.cloud.data_server_url && secrets.data_server_api_key);
      config.cloud.local_fallback_enabled = imported("LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED")
        ? flag(imported("LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED"))
        : config.cloud.local_fallback_enabled;
      const issues = [
        !config.cloud.data_server_url && "缺少 Data Server 地址",
        !secrets.data_server_api_key && "缺少 Data Server API Key",
      ].filter((value): value is string => Boolean(value));
      groups.push({
        group: "cloud",
        label: "Data Server",
        status: issues.length === 0 ? "ready" : "pending",
        detected_fields: cloudFields,
        overwritten_fields: cloudOverwrites,
        issues,
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
        this.repository.commit(config, secrets);
        return {
          state: this.setup.state(),
          applied_groups: appliedGroups,
          pending_groups: pendingGroups,
          warnings,
        };
      },
    };
  }
}

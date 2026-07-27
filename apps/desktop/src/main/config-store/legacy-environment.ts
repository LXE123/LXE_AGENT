import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  flag,
  logRetention,
  MIGRATION_VERSION,
  OUTPUT_DIRECTORY_ENV_NAMES,
  text,
  ziniaoVersion,
} from "./model";
import type { LegacyEnvironmentMigrationOptions } from "./public-types";
import type { DesktopConfigRepository } from "./repository";
import type { DesktopSetupService } from "./setup";
import type { DesktopConfigValidation } from "./validation";

const SECRET_ENV_NAMES = new Set([
  "DEEPSEEK_API",
  "KIMI_CODE_API_KEY",
  "GLM_API_KEY",
  "ZINIAO_PASSWORD",
  "MABANG_PASSWORD",
  "FEISHU_APP_SECRET",
  "LXE_DATA_SERVER_API_KEY",
  "LXE_DATA_SERVER_FALLBACK_API_KEY",
  "LXE_ERP_API_KEY",
  "LXE_SAIHU_MCP_API_KEY",
]);

export class LegacyEnvironmentMigration {
  constructor(
    private readonly repository: DesktopConfigRepository,
    private readonly setup: DesktopSetupService,
    private readonly validation: DesktopConfigValidation,
  ) {}

  migrate(options: LegacyEnvironmentMigrationOptions) {
    const config = this.repository.readConfig();
    if (config.migration_version >= MIGRATION_VERSION) return this.setup.state();
    this.repository.requireSafeStorage();
    const secrets = this.repository.readSecrets();
    const environment = options.environment;
    const legacyText = (name: string): string => text(environment[name]);

    const providerKeys = {
      kimi_coding: legacyText("KIMI_CODE_API_KEY"),
      deepseek: legacyText("DEEPSEEK_API"),
      glm: legacyText("GLM_API_KEY"),
    } as const;
    for (const [provider, key] of Object.entries(providerKeys)) {
      if (key) secrets.provider_keys[provider as keyof typeof providerKeys] = key;
    }
    const rawProvider = legacyText("AGENT_LLM_PROVIDER").toLowerCase().replaceAll("-", "_");
    if (rawProvider === "kimi_coding" || rawProvider === "deepseek" || rawProvider === "glm") {
      config.llm.provider = rawProvider;
    }
    const model = legacyText("AGENT_LLM_MODEL");
    const thinkingEnabled = legacyText("AGENT_LLM_THINKING_ENABLED");
    const thinkingEffort = legacyText("AGENT_LLM_THINKING_EFFORT");
    if (model || thinkingEnabled || thinkingEffort) {
      const previous = config.llm.profiles[config.llm.provider];
      config.llm.profiles[config.llm.provider] = {
        model: model || previous?.model || "",
        thinking_level: thinkingEnabled && !flag(thinkingEnabled)
          ? "off"
          : thinkingEffort || previous?.thinking_level || "off",
      };
    }

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
          this.validation.platform,
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
    const dataServerUrl = legacyText("LXE_DATA_SERVER_URL");
    const dataServerApiKey = legacyText("LXE_DATA_SERVER_API_KEY");
    if (dataServerUrl || dataServerApiKey) {
      config.cloud.managed = flag(legacyText("LXE_DATA_SERVER_ENABLED")) || config.cloud.managed;
      config.cloud.data_server_url = dataServerUrl || config.cloud.data_server_url;
      secrets.data_server_api_key = dataServerApiKey || secrets.data_server_api_key;
    }
    const fallbackUrl = legacyText("LXE_DATA_SERVER_FALLBACK_URL");
    const fallbackApiKey = legacyText("LXE_DATA_SERVER_FALLBACK_API_KEY");
    if (fallbackUrl || fallbackApiKey || legacyText("LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED")) {
      config.cloud.local_fallback_enabled = flag(legacyText("LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED"));
      config.cloud.local_fallback_url = fallbackUrl || config.cloud.local_fallback_url;
      secrets.data_server_fallback_api_key = fallbackApiKey || secrets.data_server_fallback_api_key;
    }
    secrets.erp_api_key = legacyText("LXE_ERP_API_KEY") || secrets.erp_api_key;
    secrets.saihu_mcp_api_key = legacyText("LXE_SAIHU_MCP_API_KEY") || secrets.saihu_mcp_api_key;
    for (const name of OUTPUT_DIRECTORY_ENV_NAMES) {
      config.output_directories[name] = legacyText(name) || config.output_directories[name];
    }
    if (this.repository.hadExistingConfig) {
      const logsEnabled = legacyText("LOCAL_LOGS_ENABLED");
      if (logsEnabled) {
        config.logging.profile = flag(logsEnabled)
          ? ([
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
    this.repository.commit(config, secrets);
    for (const path of options.managedFiles ?? []) this.removeMigratedSecrets(path);
    for (const path of options.retiredFiles ?? []) rmSync(path, { force: true });
    config.migration_version = MIGRATION_VERSION;
    this.repository.commit(config, secrets);
    return this.setup.state();
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

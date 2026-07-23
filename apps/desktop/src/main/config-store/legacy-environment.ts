import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  flag,
  logRetention,
  MIGRATION_VERSION,
  text,
  ziniaoVersion,
} from "./model";
import type { LegacyEnvironmentMigrationOptions } from "./public-types";
import type { DesktopConfigRepository } from "./repository";
import type { DesktopSetupService } from "./setup";
import type { DesktopConfigValidation } from "./validation";

const SECRET_ENV_NAMES = new Set(["ZINIAO_PASSWORD", "MABANG_PASSWORD", "FEISHU_APP_SECRET"]);

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

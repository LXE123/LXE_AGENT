import type {
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopPlatform,
  DesktopSetupInput,
  DesktopZiniaoVersion,
} from "@lxe/desktop-protocol";

export interface DesktopConfig {
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
    tunnel_name: string;
  };
}

export interface DesktopSecrets {
  provider_keys: Partial<Record<DesktopSetupInput["provider"], string>>;
  ziniao_password: string;
  mabang_password: string;
  feishu_app_secret: string;
  data_server_api_key: string;
  erp_api_key: string;
}

export const LOG_RETENTION_DAYS = new Set<DesktopLogRetentionDays>([3, 7, 14, 30]);
export const MIGRATION_VERSION = 1;

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
    tunnel_name: "lxe-agent",
  },
};

const DEFAULT_SECRETS: DesktopSecrets = {
  provider_keys: {},
  ziniao_password: "",
  mabang_password: "",
  feishu_app_secret: "",
  data_server_api_key: "",
  erp_api_key: "",
};

export const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const text = (value: unknown): string => String(value ?? "").trim();

export const flag = (value: unknown): boolean =>
  ["1", "true", "yes", "on"].includes(text(value).toLowerCase());

export const ziniaoVersion = (value: unknown, platform: DesktopPlatform): DesktopZiniaoVersion =>
  platform !== "darwin" && text(value).toLowerCase() === "v5" ? "v5" : "v6";

export const logRetention = (value: unknown): DesktopLogRetentionDays => {
  const parsed = Number(text(value));
  return LOG_RETENTION_DAYS.has(parsed as DesktopLogRetentionDays)
    ? parsed as DesktopLogRetentionDays
    : 7;
};

export const logProfile = (value: unknown): DesktopLogProfile => {
  const normalized = text(value).toLowerCase();
  return normalized === "off" || normalized === "diagnostic" ? normalized : "standard";
};

export const cloneConfig = (): DesktopConfig => structuredClone(DEFAULT_CONFIG);
export const cloneSecrets = (): DesktopSecrets => structuredClone(DEFAULT_SECRETS);

export const parseConfig = (raw: unknown, platform: DesktopPlatform): DesktopConfig => {
  const value = objectValue(raw);
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
        app_version: ziniaoVersion(rawZiniao.app_version, platform),
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
      tunnel_name: text(rawCloud.tunnel_name) || "lxe-agent",
    },
  };
};

export const parseSecrets = (raw: unknown): DesktopSecrets => {
  const value = objectValue(raw);
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
    erp_api_key: text(value.erp_api_key),
  };
};

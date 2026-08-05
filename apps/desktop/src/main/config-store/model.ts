import type {
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopPlatform,
  DesktopModelProvider,
  DesktopZiniaoVersion,
  DesktopCloudPermissionSnapshot,
  CredentialSource,
  ManagedLlmCredential,
} from "@lxe/desktop-protocol";
import { parseStoredDevicePermission } from "../cloud-permissions";

export const OUTPUT_DIRECTORY_ENV_NAMES = [
  "MABANG_STOCK_SKU_EXPORT_DIR",
  "MABANG_FBA_STORE_RESOLVER_OUTPUT_DIR",
  "MABANG_STORE_MSKU_OUTPUT_DIR",
  "MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR",
  "MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR",
  "MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR",
  "MABANG_FBA_UNLINKED_SHIPMENTS_OUTPUT_DIR",
  "MABANG_MSKU_DETAIL_OUTPUT_DIR",
  "FBA_DELIVERY_CSV_DIR",
] as const;

export type OutputDirectoryEnvironmentName = typeof OUTPUT_DIRECTORY_ENV_NAMES[number];

export interface DesktopConfig {
  schema_version: 6;
  migration_version: number;
  llm: {
    provider: DesktopModelProvider;
    credential_source: CredentialSource;
    last_local_provider: DesktopModelProvider;
    profiles: Partial<Record<DesktopModelProvider, {
      model: string;
      thinking_level: string;
    }>>;
  };
  workspace_root: string;
  output_directories: Record<OutputDirectoryEnvironmentName, string>;
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
    local_fallback_enabled: boolean;
    local_fallback_url: string;
    tunnel_name: string;
    switch_in_progress: boolean;
  };
}

export interface DesktopSecrets {
  ziniao_password: string;
  mabang_password: string;
  feishu_app_secret: string;
  data_server_api_key: string;
  data_server_fallback_api_key: string;
  erp_api_key: string;
  saihu_mcp_api_key: string;
  cloud_permission_snapshot: DesktopCloudPermissionSnapshot | null;
  managed_llm_credential: ManagedLlmCredential | null;
}

export const LOG_RETENTION_DAYS = new Set<DesktopLogRetentionDays>([3, 7, 14, 30]);
export const MODEL_AUTH_MIGRATION_VERSION = 4;

export const SETTINGS_SCHEMA_VERSION = 6 as const;

const DEFAULT_CONFIG: DesktopConfig = {
  schema_version: SETTINGS_SCHEMA_VERSION,
  migration_version: 0,
  llm: {
    provider: "deepseek",
    credential_source: "cloud",
    last_local_provider: "deepseek",
    profiles: {
      deepseek: { model: "deepseek-v4-flash", thinking_level: "low" },
    },
  },
  workspace_root: "",
  output_directories: Object.fromEntries(
    OUTPUT_DIRECTORY_ENV_NAMES.map((name) => [name, ""]),
  ) as DesktopConfig["output_directories"],
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
    local_fallback_enabled: false,
    local_fallback_url: "",
    tunnel_name: "lxe-agent",
    switch_in_progress: false,
  },
};

const DEFAULT_SECRETS: DesktopSecrets = {
  ziniao_password: "",
  mabang_password: "",
  feishu_app_secret: "",
  data_server_api_key: "",
  data_server_fallback_api_key: "",
  erp_api_key: "",
  saihu_mcp_api_key: "",
  cloud_permission_snapshot: null,
  managed_llm_credential: null,
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

const secretFieldPattern = /(?:secret|password|api[_-]?key|token)/iu;

const assertNoSecretFields = (value: unknown, path = "settings"): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`));
    return;
  }
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (secretFieldPattern.test(name)) throw new Error(`settings contains a secret field: ${path}.${name}`);
    assertNoSecretFields(item, `${path}.${name}`);
  }
};

const assertFieldTypes = (
  value: Record<string, unknown>,
  fields: Readonly<Record<string, "boolean" | "number" | "string">>,
  path: string,
): void => {
  for (const [name, expected] of Object.entries(fields)) {
    if (typeof value[name] !== expected) {
      throw new Error(`${path}.${name} must be a ${expected}`);
    }
  }
};

const assertOnlyFields = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void => {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).find((name) => !allowedFields.has(name));
  if (unknown) throw new Error(`${path}.${unknown} is not a supported setting`);
};

export const parseSettings = (raw: unknown, platform: DesktopPlatform): DesktopConfig => {
  const value = objectValue(raw);
  if (value.schema_version !== 4 && value.schema_version !== 5
    && value.schema_version !== SETTINGS_SCHEMA_VERSION) {
    throw new Error(`unsupported settings schema_version: ${String(value.schema_version ?? "missing")}`);
  }
  assertNoSecretFields(value);
  assertOnlyFields(value, [
    "schema_version",
    "migration_version",
    "llm",
    "workspace_root",
    "output_directories",
    "integrations",
    "logging",
    "cloud",
  ], "settings");
  assertFieldTypes(value, { migration_version: "number", workspace_root: "string" }, "settings");
  const llm = objectValue(value.llm);
  assertOnlyFields(llm, ["provider", "credential_source", "last_local_provider", "profiles"], "settings.llm");
  assertFieldTypes(llm, { provider: "string" }, "settings.llm");
  if (value.schema_version !== 4) {
    assertFieldTypes(llm, { credential_source: "string", last_local_provider: "string" }, "settings.llm");
  }
  if (!llm.profiles || typeof llm.profiles !== "object" || Array.isArray(llm.profiles)) {
    throw new Error("settings.llm.profiles must be an object");
  }
  for (const [name, profile] of Object.entries(objectValue(llm.profiles))) {
    if (!(["kimi_coding", "deepseek", "glm"] as string[]).includes(name)) {
      throw new Error(`settings.llm.profiles.${name} is not a supported setting`);
    }
    const profileValue = objectValue(profile);
    assertOnlyFields(profileValue, ["model", "thinking_level"], `settings.llm.profiles.${name}`);
    assertFieldTypes(profileValue, { model: "string", thinking_level: "string" }, `settings.llm.profiles.${name}`);
  }
  const outputDirectories = objectValue(value.output_directories);
  assertOnlyFields(outputDirectories, OUTPUT_DIRECTORY_ENV_NAMES, "settings.output_directories");
  for (const name of OUTPUT_DIRECTORY_ENV_NAMES) {
    if (value.output_directories !== undefined && typeof outputDirectories[name] !== "string") {
      throw new Error(`settings.output_directories.${name} must be a string`);
    }
  }
  const integrations = objectValue(value.integrations);
  const ziniao = objectValue(integrations.ziniao);
  const mabang = objectValue(integrations.mabang);
  const feishu = objectValue(integrations.feishu);
  assertOnlyFields(integrations, ["ziniao", "mabang", "feishu"], "settings.integrations");
  assertOnlyFields(ziniao, [
    "managed", "company", "username", "app_version", "app_path", "webdriver_path",
  ], "settings.integrations.ziniao");
  assertOnlyFields(mabang, ["managed", "account"], "settings.integrations.mabang");
  assertOnlyFields(feishu, ["managed", "app_id"], "settings.integrations.feishu");
  assertFieldTypes(ziniao, {
    managed: "boolean", company: "string", username: "string", app_version: "string",
    app_path: "string", webdriver_path: "string",
  }, "settings.integrations.ziniao");
  assertFieldTypes(mabang, { managed: "boolean", account: "string" }, "settings.integrations.mabang");
  assertFieldTypes(feishu, { managed: "boolean", app_id: "string" }, "settings.integrations.feishu");
  const logging = objectValue(value.logging);
  const cloud = objectValue(value.cloud);
  assertOnlyFields(logging, ["profile", "retention_days"], "settings.logging");
  assertOnlyFields(cloud, [
    "managed", "device_id", "device_name", "vpn_ip", "data_server_url",
    "local_fallback_enabled", "local_fallback_url", "tunnel_name", "switch_in_progress",
  ], "settings.cloud");
  assertFieldTypes(logging, { profile: "string", retention_days: "number" }, "settings.logging");
  assertFieldTypes(cloud, {
    managed: "boolean", device_id: "string", device_name: "string", vpn_ip: "string",
    data_server_url: "string", local_fallback_enabled: "boolean", local_fallback_url: "string",
    tunnel_name: "string",
  }, "settings.cloud");
  if (value.schema_version === SETTINGS_SCHEMA_VERSION) {
    assertFieldTypes(cloud, { switch_in_progress: "boolean" }, "settings.cloud");
  }
  return parseConfig(value, platform);
};

export const parseConfig = (raw: unknown, platform: DesktopPlatform): DesktopConfig => {
  const value = objectValue(raw);
  const rawLlm = objectValue(value.llm);
  const provider = text(rawLlm.provider || value.provider);
  const rawProfiles = objectValue(rawLlm.profiles);
  const integrations = objectValue(value.integrations);
  const rawZiniao = objectValue(integrations.ziniao);
  const rawMabang = objectValue(integrations.mabang);
  const rawFeishu = objectValue(integrations.feishu);
  const rawLogging = objectValue(value.logging);
  const rawCloud = objectValue(value.cloud);
  const rawOutputDirectories = objectValue(value.output_directories);
  const legacyFeishuAppId = text(value.feishu_app_id);
  const normalizedProvider = ["kimi_coding", "deepseek", "glm"].includes(provider)
    ? provider as DesktopConfig["llm"]["provider"]
    : DEFAULT_CONFIG.llm.provider;
  const credentialSource: CredentialSource = text(rawLlm.credential_source) === "cloud"
    ? "cloud"
    : "local";
  const rawLastLocalProvider = text(rawLlm.last_local_provider);
  const lastLocalProvider = ["kimi_coding", "deepseek", "glm"].includes(rawLastLocalProvider)
    ? rawLastLocalProvider as DesktopConfig["llm"]["last_local_provider"]
    : normalizedProvider;
  const profiles: DesktopConfig["llm"]["profiles"] = {};
  for (const name of ["kimi_coding", "deepseek", "glm"] as const) {
    const profile = objectValue(rawProfiles[name]);
    const model = text(profile.model);
    const thinkingLevel = text(profile.thinking_level);
    if (model || thinkingLevel) {
      profiles[name] = {
        model,
        thinking_level: thinkingLevel || "off",
      };
    }
  }
  if (Object.keys(profiles).length === 0 && normalizedProvider === DEFAULT_CONFIG.llm.provider) {
    profiles[normalizedProvider] = structuredClone(DEFAULT_CONFIG.llm.profiles[normalizedProvider]!);
  }
  return {
    schema_version: SETTINGS_SCHEMA_VERSION,
    migration_version: Number.isFinite(Number(value.migration_version))
      ? Math.max(0, Math.trunc(Number(value.migration_version)))
      : 0,
    llm: {
      provider: normalizedProvider,
      credential_source: credentialSource,
      last_local_provider: lastLocalProvider,
      profiles,
    },
    workspace_root: text(value.workspace_root),
    output_directories: Object.fromEntries(
      OUTPUT_DIRECTORY_ENV_NAMES.map((name) => [name, text(rawOutputDirectories[name])]),
    ) as DesktopConfig["output_directories"],
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
      local_fallback_enabled: Boolean(rawCloud.local_fallback_enabled),
      local_fallback_url: text(rawCloud.local_fallback_url),
      tunnel_name: text(rawCloud.tunnel_name) || "lxe-agent",
      switch_in_progress: Boolean(rawCloud.switch_in_progress),
    },
  };
};

export const parseSecrets = (raw: unknown): DesktopSecrets => {
  const value = objectValue(raw);
  const managedCredential = objectValue(value.managed_llm_credential);
  const revision = text(managedCredential.credential_revision).toLowerCase();
  const invalidRevision = text(managedCredential.invalid_revision).toLowerCase();
  const fetchedAt = Number(managedCredential.fetched_at);
  const parsedManagedCredential: ManagedLlmCredential | null =
    managedCredential.provider === "deepseek"
      && managedCredential.model === "deepseek-v4-flash"
      && text(managedCredential.api_key)
      && /^[a-f0-9]{64}$/u.test(revision)
      && (!invalidRevision || /^[a-f0-9]{64}$/u.test(invalidRevision))
      && Number.isSafeInteger(fetchedAt)
      && fetchedAt > 0
      ? {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          api_key: text(managedCredential.api_key),
          credential_revision: revision,
          fetched_at: fetchedAt,
          invalid_revision: invalidRevision,
        }
      : null;
  return {
    ziniao_password: text(value.ziniao_password),
    mabang_password: text(value.mabang_password),
    feishu_app_secret: text(value.feishu_app_secret),
    data_server_api_key: text(value.data_server_api_key),
    data_server_fallback_api_key: text(value.data_server_fallback_api_key),
    erp_api_key: text(value.erp_api_key),
    saihu_mcp_api_key: text(value.saihu_mcp_api_key),
    cloud_permission_snapshot: parseStoredDevicePermission(
      value.cloud_permission_snapshot,
    ),
    managed_llm_credential: parsedManagedCredential,
  };
};

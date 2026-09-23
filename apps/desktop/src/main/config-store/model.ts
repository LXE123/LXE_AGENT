import { parseManagedState, singleManagedState, type ManagedLlmState } from "@lxe/core";
import type {
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopPlatform,
  DesktopModelProvider,
  DesktopZiniaoVersion,
  DesktopCloudPermissionSnapshot,
  DesktopObservedDevice,
  CredentialSource,
  ManagedLlmCredential,
  ManagedLlmTarget,
} from "@lxe/desktop-protocol";
import {
  createLogger,
  loadLlmProviderCatalog,
  repositoryRoot,
  type LlmProviderCatalog,
} from "@lxe/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStoredDevicePermission, parseObservedDevice } from "../cloud-permissions";
import {
  parseWireGuardTunnelConfiguration,
  type WireGuardTunnelConfiguration,
} from "../wireguard-types";

const logger = createLogger("desktop.config.model");

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
  schema_version: 10;
  migration_version: number;
  llm: {
    provider: DesktopModelProvider;
    credential_source: CredentialSource;
    last_local_provider: DesktopModelProvider;
    managed_target: ManagedLlmTarget;
    profiles: Record<DesktopModelProvider, {
      model: string;
      thinking_level: string;
    }>;
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
    yacang: { managed: boolean; mobile: string; production_enabled: boolean };
    zhihui_tms: { managed: boolean; account: string; production_enabled: boolean };
    feishu: { managed: boolean; app_id: string };
    shangman: {
      managed: boolean;
      tenant_id: string;
      username: string;
      revision: string;
      production_enabled: boolean;
    };
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

export interface ZhihuiTmsSessionRecord {
  account_fingerprint: string;
  api_token: string;
  saved_at: number;
}

export interface DesktopSecrets {
  ziniao_password: string;
  mabang_password: string;
  yacang_password: string;
  zhihui_tms_password: string;
  zhihui_tms_session: ZhihuiTmsSessionRecord | null;
  feishu_app_secret: string;
  shangman_processed_password: string;
  data_server_api_key: string;
  cloud_identity_candidate: string;
  cloud_business_token: string;
  cloud_business_erp_token: string;
  cloud_business_expires_at: number;
  data_server_fallback_api_key: string;
  erp_api_key: string;
  saihu_mcp_api_key: string;
  cloud_permission_snapshot: DesktopCloudPermissionSnapshot | null;
  cloud_observed_device: DesktopObservedDevice | null;
  cloud_wireguard: WireGuardTunnelConfiguration | null;
  managed_llm_credential: ManagedLlmCredential | null;
  managed_llm_state?: ManagedLlmState | null;
}

export const LOG_RETENTION_DAYS = new Set<DesktopLogRetentionDays>([3, 7, 14, 30]);
export const MODEL_AUTH_MIGRATION_VERSION = 5;

export const SETTINGS_SCHEMA_VERSION = 10 as const;

const developmentCatalog = (): LlmProviderCatalog => loadLlmProviderCatalog(
  join(repositoryRoot(dirname(fileURLToPath(import.meta.url))), "config", "llm"),
);

const defaultConfig = (catalog: LlmProviderCatalog): DesktopConfig => {
  const provider = catalog.requireProvider(catalog.defaultProvider);
  const model = provider.models[provider.defaultModel]!;
  return {
    schema_version: SETTINGS_SCHEMA_VERSION,
    migration_version: 0,
    llm: {
      provider: provider.name,
      credential_source: "cloud",
      last_local_provider: provider.name,
      managed_target: { provider: provider.name, model: provider.defaultModel },
      profiles: {
        [provider.name]: { model: provider.defaultModel, thinking_level: model.thinkingDefault },
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
      yacang: { managed: false, mobile: "", production_enabled: false },
      zhihui_tms: { managed: false, account: "", production_enabled: false },
      feishu: { managed: false, app_id: "" },
      shangman: { managed: false, tenant_id: "", username: "", revision: "", production_enabled: false },
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
};

const DEFAULT_SECRETS: DesktopSecrets = {
  ziniao_password: "",
  mabang_password: "",
  yacang_password: "",
  zhihui_tms_password: "",
  zhihui_tms_session: null,
  feishu_app_secret: "",
  shangman_processed_password: "",
  data_server_api_key: "",
  cloud_identity_candidate: "",
  cloud_business_token: "",
  cloud_business_erp_token: "",
  cloud_business_expires_at: 0,
  data_server_fallback_api_key: "",
  erp_api_key: "",
  saihu_mcp_api_key: "",
  cloud_permission_snapshot: null,
  cloud_observed_device: null,
  cloud_wireguard: null,
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

export const cloneConfig = (catalog: LlmProviderCatalog = developmentCatalog()): DesktopConfig =>
  structuredClone(defaultConfig(catalog));
export const cloneSecrets = (): DesktopSecrets => structuredClone(DEFAULT_SECRETS);

const secretFieldPattern = /(?:secret|password|api[_-]?key|token|basic[_-]?auth)/iu;

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

export const parseSettings = (
  raw: unknown,
  platform: DesktopPlatform,
  catalog: LlmProviderCatalog = developmentCatalog(),
): DesktopConfig => {
  const value = objectValue(raw);
  if (value.schema_version !== 4 && value.schema_version !== 5
    && value.schema_version !== 6 && value.schema_version !== 7
    && value.schema_version !== 8 && value.schema_version !== 9
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
  assertOnlyFields(
    llm,
    ["provider", "credential_source", "last_local_provider", "managed_target", "profiles"],
    "settings.llm",
  );
  assertFieldTypes(llm, { provider: "string" }, "settings.llm");
  if (value.schema_version !== 4) {
    assertFieldTypes(llm, { credential_source: "string", last_local_provider: "string" }, "settings.llm");
  }
  if (Number(value.schema_version) >= 7) {
    const managedTarget = objectValue(llm.managed_target);
    assertOnlyFields(managedTarget, ["provider", "model"], "settings.llm.managed_target");
    assertFieldTypes(managedTarget, { provider: "string", model: "string" }, "settings.llm.managed_target");
  }
  if (!llm.profiles || typeof llm.profiles !== "object" || Array.isArray(llm.profiles)) {
    throw new Error("settings.llm.profiles must be an object");
  }
  for (const [name, profile] of Object.entries(objectValue(llm.profiles))) {
    const acceptedLegacyProviders = value.schema_version === 7
      ? ["kimi_coding", "deepseek"]
      : ["kimi_coding", "deepseek", "glm"];
    const validProviderName = /^[A-Za-z0-9_-]{1,128}$/u.test(name);
    if (value.schema_version >= 8
      ? !validProviderName
      : !acceptedLegacyProviders.includes(name)) {
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
  const yacang = objectValue(integrations.yacang);
  const zhihuiTms = objectValue(integrations.zhihui_tms);
  const feishu = objectValue(integrations.feishu);
  const shangman = objectValue(integrations.shangman);
  assertOnlyFields(integrations, ["ziniao", "mabang", "yacang", "zhihui_tms", "feishu", "shangman"], "settings.integrations");
  assertOnlyFields(ziniao, [
    "managed", "company", "username", "app_version", "app_path", "webdriver_path",
  ], "settings.integrations.ziniao");
  assertOnlyFields(mabang, ["managed", "account"], "settings.integrations.mabang");
  assertOnlyFields(yacang, ["managed", "mobile", "production_enabled"], "settings.integrations.yacang");
  assertOnlyFields(zhihuiTms, ["managed", "account", "production_enabled"], "settings.integrations.zhihui_tms");
  assertOnlyFields(feishu, ["managed", "app_id"], "settings.integrations.feishu");
  assertOnlyFields(shangman, ["managed", "tenant_id", "username", "revision", "production_enabled"], "settings.integrations.shangman");
  assertFieldTypes(ziniao, {
    managed: "boolean", company: "string", username: "string", app_version: "string",
    app_path: "string", webdriver_path: "string",
  }, "settings.integrations.ziniao");
  assertFieldTypes(mabang, { managed: "boolean", account: "string" }, "settings.integrations.mabang");
  if (value.schema_version === SETTINGS_SCHEMA_VERSION) {
    assertFieldTypes(yacang, { managed: "boolean", mobile: "string" }, "settings.integrations.yacang");
  }
  if (yacang.production_enabled !== undefined && typeof yacang.production_enabled !== "boolean") {
    throw new Error("settings.integrations.yacang.production_enabled must be a boolean");
  }
  if (integrations.zhihui_tms !== undefined) {
    assertFieldTypes(zhihuiTms, {
      managed: "boolean", account: "string", production_enabled: "boolean",
    }, "settings.integrations.zhihui_tms");
  }
  assertFieldTypes(feishu, { managed: "boolean", app_id: "string" }, "settings.integrations.feishu");
  if (value.schema_version >= SETTINGS_SCHEMA_VERSION || Object.keys(shangman).length > 0) {
    assertFieldTypes(shangman, {
      managed: "boolean", tenant_id: "string", username: "string",
      ...(value.schema_version >= SETTINGS_SCHEMA_VERSION ? { production_enabled: "boolean" as const } : {}),
    }, "settings.integrations.shangman");
  }
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
  if (Number(value.schema_version) >= 7) {
    assertFieldTypes(cloud, { switch_in_progress: "boolean" }, "settings.cloud");
  }
  return parseConfig(value, platform, catalog);
};

export const parseConfig = (
  raw: unknown,
  platform: DesktopPlatform,
  catalog: LlmProviderCatalog = developmentCatalog(),
): DesktopConfig => {
  const defaults = defaultConfig(catalog);
  const value = objectValue(raw);
  const rawLlm = objectValue(value.llm);
  const provider = text(rawLlm.provider || value.provider);
  const rawProfiles = objectValue(rawLlm.profiles);
  const integrations = objectValue(value.integrations);
  const rawZiniao = objectValue(integrations.ziniao);
  const rawMabang = objectValue(integrations.mabang);
  const rawYacang = objectValue(integrations.yacang);
  const rawZhihuiTms = objectValue(integrations.zhihui_tms);
  const rawFeishu = objectValue(integrations.feishu);
  const rawShangman = objectValue(integrations.shangman);
  const rawLogging = objectValue(value.logging);
  const rawCloud = objectValue(value.cloud);
  const rawOutputDirectories = objectValue(value.output_directories);
  const legacyFeishuAppId = text(value.feishu_app_id);
  const selectedProvider = catalog.provider(provider);
  const normalizedProvider = selectedProvider?.name ?? defaults.llm.provider;
  if (provider && !selectedProvider) {
    logger.warn("unsupported_active_provider_fell_back", {
      configured_provider: provider,
      fallback_provider: normalizedProvider,
    });
  }
  const credentialSource: CredentialSource = text(rawLlm.credential_source) === "cloud"
    ? "cloud"
    : "local";
  const rawLastLocalProvider = text(rawLlm.last_local_provider);
  const lastLocalProvider = catalog.provider(rawLastLocalProvider)?.name ?? normalizedProvider;
  const profiles: DesktopConfig["llm"]["profiles"] = {};
  for (const [rawName, rawProfile] of Object.entries(rawProfiles)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(rawName)) continue;
    const name = catalog.provider(rawName)?.name ?? rawName;
    const profile = objectValue(rawProfile);
    const model = text(profile.model);
    const thinkingLevel = text(profile.thinking_level);
    if (model || thinkingLevel) {
      profiles[name] = {
        model,
        thinking_level: thinkingLevel || "off",
      };
    }
  }
  if (!profiles[normalizedProvider]) {
    const spec = catalog.requireProvider(normalizedProvider);
    const model = spec.models[spec.defaultModel]!;
    profiles[normalizedProvider] = {
      model: spec.defaultModel,
      thinking_level: model.thinkingDefault,
    };
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
      managed_target: (() => {
        const target = objectValue(rawLlm.managed_target);
        const managedProvider = text(target.provider);
        const managedModel = text(target.model);
        return /^[a-z][a-z0-9_-]{0,63}$/u.test(managedProvider)
          && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(managedModel)
          ? { provider: managedProvider, model: managedModel }
          : structuredClone(defaults.llm.managed_target);
      })(),
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
      yacang: {
        managed: Boolean(rawYacang.managed),
        mobile: text(rawYacang.mobile),
        production_enabled: Boolean(rawYacang.production_enabled),
      },
      zhihui_tms: {
        managed: Boolean(rawZhihuiTms.managed),
        account: text(rawZhihuiTms.account),
        production_enabled: rawZhihuiTms.production_enabled === true,
      },
      feishu: {
        managed: Boolean(rawFeishu.managed) || Boolean(legacyFeishuAppId),
        app_id: text(rawFeishu.app_id) || legacyFeishuAppId,
      },
      shangman: {
        managed: Boolean(rawShangman.managed),
        tenant_id: text(rawShangman.tenant_id),
        username: text(rawShangman.username),
        revision: text(rawShangman.revision),
        production_enabled: rawShangman.production_enabled === true,
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
  const zhihuiSession = objectValue(value.zhihui_tms_session);
  const zhihuiSessionFingerprint = text(zhihuiSession.account_fingerprint);
  const zhihuiSessionToken = text(zhihuiSession.api_token);
  const zhihuiSessionSavedAt = Number(zhihuiSession.saved_at);
  const parsedZhihuiSession: ZhihuiTmsSessionRecord | null =
    /^[a-f0-9]{64}$/u.test(zhihuiSessionFingerprint)
      && zhihuiSessionToken.length > 0
      && zhihuiSessionToken.length <= 8_192
      && Number.isSafeInteger(zhihuiSessionSavedAt)
      && zhihuiSessionSavedAt > 0
      ? {
          account_fingerprint: zhihuiSessionFingerprint,
          api_token: zhihuiSessionToken,
          saved_at: zhihuiSessionSavedAt,
        }
      : null;
  const managedCredential = objectValue(value.managed_llm_credential);
  const revision = text(managedCredential.credential_revision).toLowerCase();
  const invalidRevision = text(managedCredential.invalid_revision).toLowerCase();
  const fetchedAt = Number(managedCredential.fetched_at);
  const parsedManagedCredential: ManagedLlmCredential | null =
    /^[a-z][a-z0-9_-]{0,63}$/u.test(text(managedCredential.provider))
      && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(text(managedCredential.model))
      && text(managedCredential.api_key)
      && /^[a-f0-9]{64}$/u.test(revision)
      && (!invalidRevision || /^[a-f0-9]{64}$/u.test(invalidRevision))
      && Number.isSafeInteger(fetchedAt)
      && fetchedAt > 0
      ? {
          provider: text(managedCredential.provider),
          model: text(managedCredential.model),
          api_key: text(managedCredential.api_key),
          credential_revision: revision,
          fetched_at: fetchedAt,
          invalid_revision: invalidRevision,
        }
      : null;
  return {
    ziniao_password: text(value.ziniao_password),
    mabang_password: text(value.mabang_password),
    yacang_password: text(value.yacang_password),
    zhihui_tms_password: text(value.zhihui_tms_password),
    zhihui_tms_session: parsedZhihuiSession,
    feishu_app_secret: text(value.feishu_app_secret),
    shangman_processed_password: text(value.shangman_processed_password),
    data_server_api_key: text(value.data_server_api_key),
    cloud_identity_candidate: text(value.cloud_identity_candidate),
    cloud_business_token: text(value.cloud_business_token),
    cloud_business_erp_token: text(value.cloud_business_erp_token),
    cloud_business_expires_at: Number(value.cloud_business_expires_at) || 0,
    data_server_fallback_api_key: text(value.data_server_fallback_api_key),
    erp_api_key: text(value.erp_api_key),
    saihu_mcp_api_key: text(value.saihu_mcp_api_key),
    cloud_permission_snapshot: parseStoredDevicePermission(
      value.cloud_permission_snapshot,
    ),
    cloud_observed_device: parseObservedDevice(value.cloud_observed_device),
    cloud_wireguard: parseWireGuardTunnelConfiguration(value.cloud_wireguard),
    managed_llm_credential: parsedManagedCredential,
    managed_llm_state: value.managed_llm_state == null ? singleManagedState(parsedManagedCredential) : parseManagedState(value.managed_llm_state),
  };
};

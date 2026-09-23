import type {
  DesktopCloudDestination,
  DesktopCloudState,
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopLoggingSinkStatus,
  DesktopModelProvider,
  DesktopSetupState,
  DesktopZiniaoVersion,
} from "@lxe/desktop-protocol";
import type { UiText } from "../shared/i18n";

export interface DesktopLoggingSinkView {
  label: string;
  tone: "ready" | "neutral" | "warning" | "error";
}

export const desktopCloudBindingSwitchAvailable = (cloud: DesktopCloudState): boolean =>
  cloud.configured
  && cloud.connection !== "unsupported"
  && cloud.device_id.trim().length > 0;

export const desktopCloudShortcutAvailable = (
  destination: DesktopCloudDestination,
  cloud: Pick<DesktopCloudState, "is_admin" | "desktop_features">,
): boolean => {
  if (destination === "admin_dashboard") return cloud.is_admin;
  if (destination === "erp_dashboard") {
    return cloud.desktop_features.includes("*")
      || cloud.desktop_features.includes("erp_dashboard");
  }
  return true;
};

export const desktopLoggingSinkView = (
  text: UiText["desktop"],
  status: DesktopLoggingSinkStatus | undefined,
): DesktopLoggingSinkView => {
  if (!status) return { label: text.sinkStates.notStarted, tone: "neutral" };
  if (status.local_file_enabled) return { label: text.sinkStates.writing, tone: "ready" };
  if (status.disabled_reason === "sink_failed") return { label: text.sinkStates.failed, tone: "error" };
  if (status.disabled_reason === "missing_log_file") return { label: text.sinkStates.missingConfig, tone: "warning" };
  return { label: text.sinkStates.disabled, tone: "neutral" };
};

export const ERP_INTEGRATIONS = ["mabangTms", "yacang", "shangman", "mabang"] as const;
export type ErpIntegrationName = typeof ERP_INTEGRATIONS[number];
export type DesktopIntegrationName = ErpIntegrationName | "ziniao" | "feishu";

export type DesktopSettingsSection =
  | "status"
  | "appearance"
  | "cloud"
  | "base"
  | "ziniao"
  | "erp"
  | "feishu"
  | "logging";

export type EditableDesktopSettingsSection = Exclude<DesktopSettingsSection, "status" | "appearance" | "cloud">;

export interface DesktopSettingsFormValue {
  localProvider: DesktopModelProvider;
  localApiKey: string;
  workspaceRoot: string;
  ziniaoCompany: string;
  ziniaoUsername: string;
  ziniaoPassword: string;
  ziniaoVersion: DesktopZiniaoVersion;
  ziniaoAppPath: string;
  ziniaoWebDriverPath: string;
  mabangTmsAccount: string;
  yacangMobile: string;
  mabangTmsPassword: string;
  yacangPassword: string;
  shangmanTenantId: string;
  shangmanUsername: string;
  shangmanPassword: string;
  mabangAccount: string;
  mabangPassword: string;
  feishuAppId: string;
  feishuAppSecret: string;
  logProfile: DesktopLogProfile;
  logRetentionDays: DesktopLogRetentionDays;
}

export const desktopSettingsForm = (state: DesktopSetupState): DesktopSettingsFormValue => ({
  localProvider: state.local_provider,
  localApiKey: "",
  workspaceRoot: state.workspace_root,
  ziniaoCompany: state.ziniao.company,
  ziniaoUsername: state.ziniao.username,
  ziniaoPassword: "",
  ziniaoVersion: state.ziniao.app_version,
  ziniaoAppPath: state.ziniao.app_path,
  ziniaoWebDriverPath: state.ziniao.webdriver_path,
  mabangTmsAccount: state.mabangTms.account,
  yacangMobile: state.yacang.mobile,
  mabangTmsPassword: "",
  yacangPassword: "",
  shangmanTenantId: state.shangman.tenant_id,
  shangmanUsername: state.shangman.username,
  shangmanPassword: "",
  mabangAccount: state.mabang.account,
  mabangPassword: "",
  feishuAppId: state.feishu.app_id,
  feishuAppSecret: "",
  logProfile: state.logging.profile,
  logRetentionDays: state.logging.retention_days,
});

export type DesktopSettingsFormSection = Exclude<EditableDesktopSettingsSection, "erp"> | ErpIntegrationName;

const SECTION_FIELDS: Record<DesktopSettingsFormSection, readonly (keyof DesktopSettingsFormValue)[]> = {
  base: ["workspaceRoot"],
  ziniao: [
    "ziniaoCompany",
    "ziniaoUsername",
    "ziniaoPassword",
    "ziniaoVersion",
    "ziniaoAppPath",
    "ziniaoWebDriverPath",
  ],
  mabangTms: ["mabangTmsAccount", "mabangTmsPassword"],
  yacang: ["yacangMobile", "yacangPassword"],
  shangman: ["shangmanTenantId", "shangmanUsername", "shangmanPassword"],
  mabang: ["mabangAccount", "mabangPassword"],
  feishu: ["feishuAppId", "feishuAppSecret"],
  logging: ["logProfile", "logRetentionDays"],
};

export const desktopSettingsSectionIsDirty = (
  section: DesktopSettingsSection | ErpIntegrationName,
  form: DesktopSettingsFormValue,
  baseline: DesktopSettingsFormValue,
): boolean => section !== "status" && section !== "cloud"
  && section !== "appearance"
  && (section === "erp"
    ? ERP_INTEGRATIONS.some((name) => desktopSettingsSectionIsDirty(name, form, baseline))
    : SECTION_FIELDS[section].some((field) => form[field] !== baseline[field]));

export const desktopSettingsSectionStatus = (
  text: UiText["desktop"],
  section: EditableDesktopSettingsSection | ErpIntegrationName,
  setup: DesktopSetupState,
): string => {
  if (section === "erp") return text.erpConfiguredCount(ERP_INTEGRATIONS.filter((name) => setup[name].configured).length, ERP_INTEGRATIONS.length);
  if (section === "base") return setup.complete ? text.sectionStatus.complete : text.sectionStatus.required;
  if (section === "logging") return text.logProfiles[setup.logging.profile];
  const integration = setup[section];
  return integration.configured
    ? text.sectionStatus.configured
    : integration.managed
      ? text.sectionStatus.incomplete
      : text.sectionStatus.optional;
};

// Clearing a platform must leave every other draft (including secrets) untouched.
export const desktopSettingsFormAfterClear = (
  current: DesktopSettingsFormValue,
  next: DesktopSetupState,
  integration: DesktopIntegrationName,
): DesktopSettingsFormValue => {
  const saved = desktopSettingsForm(next);
  return { ...current, ...Object.fromEntries(SECTION_FIELDS[integration].map((field) => [field, saved[field]])) };
};

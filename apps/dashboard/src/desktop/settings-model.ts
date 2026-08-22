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

export type DesktopSettingsSection =
  | "status"
  | "appearance"
  | "cloud"
  | "base"
  | "ziniao"
  | "mabang"
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
  mabangAccount: state.mabang.account,
  mabangPassword: "",
  feishuAppId: state.feishu.app_id,
  feishuAppSecret: "",
  logProfile: state.logging.profile,
  logRetentionDays: state.logging.retention_days,
});

const SECTION_FIELDS: Record<EditableDesktopSettingsSection, readonly (keyof DesktopSettingsFormValue)[]> = {
  base: ["workspaceRoot"],
  ziniao: [
    "ziniaoCompany",
    "ziniaoUsername",
    "ziniaoPassword",
    "ziniaoVersion",
    "ziniaoAppPath",
    "ziniaoWebDriverPath",
  ],
  mabang: ["mabangAccount", "mabangPassword"],
  feishu: ["feishuAppId", "feishuAppSecret"],
  logging: ["logProfile", "logRetentionDays"],
};

export const desktopSettingsSectionIsDirty = (
  section: DesktopSettingsSection,
  form: DesktopSettingsFormValue,
  baseline: DesktopSettingsFormValue,
): boolean => section !== "status" && section !== "cloud"
  && section !== "appearance"
  && SECTION_FIELDS[section].some((field) => form[field] !== baseline[field]);

export const desktopSettingsSectionStatus = (
  text: UiText["desktop"],
  section: EditableDesktopSettingsSection,
  setup: DesktopSetupState,
): string => {
  if (section === "base") return setup.complete ? text.sectionStatus.complete : text.sectionStatus.required;
  if (section === "logging") return text.logProfiles[setup.logging.profile];
  const integration = setup[section];
  return integration.configured
    ? text.sectionStatus.configured
    : integration.managed
      ? text.sectionStatus.incomplete
      : text.sectionStatus.optional;
};

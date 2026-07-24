import type {
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopLoggingSinkStatus,
  DesktopSetupInput,
  DesktopSetupState,
  DesktopZiniaoVersion,
} from "@lxe/desktop-protocol";

export interface DesktopLoggingSinkView {
  label: "写入中" | "已关闭" | "配置缺失" | "写入失败" | "未启动";
  tone: "ready" | "neutral" | "warning" | "error";
}

export const desktopLoggingSinkView = (
  status: DesktopLoggingSinkStatus | undefined,
): DesktopLoggingSinkView => {
  if (!status) return { label: "未启动", tone: "neutral" };
  if (status.local_file_enabled) return { label: "写入中", tone: "ready" };
  if (status.disabled_reason === "sink_failed") return { label: "写入失败", tone: "error" };
  if (status.disabled_reason === "missing_log_file") return { label: "配置缺失", tone: "warning" };
  return { label: "已关闭", tone: "neutral" };
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
  provider: DesktopSetupInput["provider"];
  apiKey: string;
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
  provider: state.provider as DesktopSetupInput["provider"],
  apiKey: "",
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
  base: ["provider", "apiKey", "workspaceRoot"],
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
  section: EditableDesktopSettingsSection,
  setup: DesktopSetupState,
): string => {
  if (section === "base") return setup.complete ? "已完成" : "必填";
  if (section === "logging") {
    return ({ off: "关闭", standard: "标准", diagnostic: "排障" } as const)[setup.logging.profile];
  }
  const integration = setup[section];
  return integration.configured ? "已配置" : integration.managed ? "待补全" : "可选";
};

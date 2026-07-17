import type {
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopSetupInput,
  DesktopSetupState,
  DesktopZiniaoVersion,
} from "@lxe/desktop-protocol";

export type DesktopSettingsSection =
  | "status"
  | "base"
  | "ziniao"
  | "mabang"
  | "feishu"
  | "logging";

export type EditableDesktopSettingsSection = Exclude<DesktopSettingsSection, "status">;

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
): boolean => section !== "status" && SECTION_FIELDS[section].some((field) => form[field] !== baseline[field]);

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

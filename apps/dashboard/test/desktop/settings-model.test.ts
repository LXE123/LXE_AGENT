import { describe, expect, test } from "bun:test";
import type { DesktopCloudState, DesktopSetupState } from "@lxe/desktop-protocol";
import {
  desktopCloudBindingSwitchAvailable,
  desktopCloudShortcutAvailable,
  desktopSettingsForm,
  desktopLoggingSinkView,
  desktopSettingsSectionIsDirty,
  desktopSettingsSectionStatus,
} from "../../src/desktop/settings-model";
import { ZH_TEXT } from "../../src/shared/i18n";

const text = ZH_TEXT.desktop;

const cloudState = (patch: Partial<DesktopCloudState> = {}): DesktopCloudState => ({
  configured: true,
  is_admin: false,
  device_name: "Finance-PC-01",
  device_id: "0123456789abcdef0123456789abcdef",
  vpn_ip: "10.88.0.8",
  connection: "connected",
  last_error: "",
  last_checked_at: 0,
  permission_status: "verified",
  permission_profile: "fba",
  permission_version: 1,
  profile_revision: 1,
  profile_labels: { "zh-CN": "FBA", "en-US": "FBA" },
  desktop_features: ["erp_dashboard"],
  permission_verified_at: 0,
  ...patch,
});

const setupState = (patch: Partial<DesktopSetupState> = {}): DesktopSetupState => ({
  complete: true,
  provider: "kimi_coding",
  credential_source: "local",
  managed_model_configured: false,
  local_model_credentials: { kimi_coding: true, deepseek: false },
  local_auth_path: "/data/var/config/auth.json",
  local_auth_error: "",
  workspace_root: "/workspace",
  ziniao: {
    managed: false,
    configured: false,
    issues: [],
    company: "",
    username: "",
    password_configured: false,
    app_version: "v6",
    app_path: "",
    webdriver_path: "",
  },
  mabang: {
    managed: true,
    configured: false,
    issues: ["缺少马帮密码"],
    account: "seller",
    password_configured: false,
  },
  feishu: {
    managed: true,
    configured: true,
    issues: [],
    app_id: "cli_test",
    app_secret_configured: true,
  },
  logging: {
    profile: "standard",
    retention_days: 7,
    directory: "/data/var/logs",
  },
  ...patch,
});

describe("desktop settings navigation model", () => {
  test("shows the FBA ERP shortcut only when granted by the server", () => {
    expect(desktopCloudShortcutAvailable("erp_dashboard", cloudState({
      desktop_features: ["erp_dashboard"],
    }))).toBe(true);
    expect(desktopCloudShortcutAvailable("erp_dashboard", cloudState({
      permission_profile: "shopee",
      desktop_features: [],
    }))).toBe(false);
    expect(desktopCloudShortcutAvailable("erp_dashboard", cloudState({
      desktop_features: ["*"],
    }))).toBe(true);
  });

  test("keeps Agent access general and Admin access tied to the admin role", () => {
    expect(desktopCloudShortcutAvailable("agent_dashboard", cloudState({
      permission_profile: null,
    }))).toBe(true);
    expect(desktopCloudShortcutAvailable("admin_dashboard", cloudState({
      is_admin: true,
      permission_profile: "replenishment",
      desktop_features: [],
    }))).toBe(true);
    expect(desktopCloudShortcutAvailable("admin_dashboard", cloudState({
      is_admin: false,
      permission_profile: "full_access",
      desktop_features: ["erp_dashboard"],
    }))).toBe(false);
  });

  test("offers binding switches only for configured managed devices", () => {
    expect(desktopCloudBindingSwitchAvailable(cloudState())).toBe(true);
    expect(desktopCloudBindingSwitchAvailable(cloudState({ connection: "offline" }))).toBe(true);
    expect(desktopCloudBindingSwitchAvailable(cloudState({ connection: "error" }))).toBe(true);
    expect(desktopCloudBindingSwitchAvailable(cloudState({ configured: false }))).toBe(false);
    expect(desktopCloudBindingSwitchAvailable(cloudState({ device_id: "" }))).toBe(false);
    expect(desktopCloudBindingSwitchAvailable(cloudState({ connection: "unsupported" }))).toBe(false);
  });

  test("projects saved state without returning secrets", () => {
    const form = desktopSettingsForm(setupState());

    expect(form.localProvider).toBe("kimi_coding");
    expect(form.workspaceRoot).toBe("/workspace");
    expect(form.localApiKey).toBe("");
    expect(form.mabangPassword).toBe("");
    expect(form.feishuAppSecret).toBe("");
  });

  test("reports persisted status for every editable menu section", () => {
    const setup = setupState();

    expect(desktopSettingsSectionStatus(text, "base", setup)).toBe(text.sectionStatus.complete);
    expect(desktopSettingsSectionStatus(text, "ziniao", setup)).toBe(text.sectionStatus.optional);
    expect(desktopSettingsSectionStatus(text, "mabang", setup)).toBe(text.sectionStatus.incomplete);
    expect(desktopSettingsSectionStatus(text, "feishu", setup)).toBe(text.sectionStatus.configured);
    expect(desktopSettingsSectionStatus(text, "logging", setup)).toBe(text.logProfiles.standard);
  });

  test("marks only the section containing an unsaved change", () => {
    const baseline = desktopSettingsForm(setupState());
    const form = { ...baseline, mabangPassword: "new-secret" };

    expect(desktopSettingsSectionIsDirty("status", form, baseline)).toBe(false);
    expect(desktopSettingsSectionIsDirty("appearance", form, baseline)).toBe(false);
    expect(desktopSettingsSectionIsDirty("base", form, baseline)).toBe(false);
    expect(desktopSettingsSectionIsDirty("mabang", form, baseline)).toBe(true);
    expect(desktopSettingsSectionIsDirty("feishu", form, baseline)).toBe(false);
  });

  test("keeps dirty state independent from persisted status", () => {
    const setup = setupState();
    const baseline = desktopSettingsForm(setup);
    const form = { ...baseline, feishuAppId: "cli_edited" };

    expect(desktopSettingsSectionStatus(text, "feishu", setup)).toBe(text.sectionStatus.configured);
    expect(desktopSettingsSectionIsDirty("feishu", form, baseline)).toBe(true);
  });

  test("presents logging sinks without promoting disabled logging to an error", () => {
    expect(desktopLoggingSinkView(text, undefined)).toEqual({ label: text.sinkStates.notStarted, tone: "neutral" });
    expect(desktopLoggingSinkView(text, {
      local_file_enabled: true,
      file_path: "/data/var/logs/runtime.log",
      disabled_reason: "",
      last_error: "",
      console_level: "info",
      file_level: "info",
    })).toEqual({ label: text.sinkStates.writing, tone: "ready" });
    expect(desktopLoggingSinkView(text, {
      local_file_enabled: false,
      file_path: "",
      disabled_reason: "disabled_by_config",
      last_error: "",
      console_level: "info",
      file_level: "info",
    })).toEqual({ label: text.sinkStates.disabled, tone: "neutral" });
    expect(desktopLoggingSinkView(text, {
      local_file_enabled: false,
      file_path: "",
      disabled_reason: "missing_log_file",
      last_error: "",
      console_level: "info",
      file_level: "info",
    })).toEqual({ label: text.sinkStates.missingConfig, tone: "warning" });
    expect(desktopLoggingSinkView(text, {
      local_file_enabled: false,
      file_path: "/data/var/logs/runtime.log",
      disabled_reason: "sink_failed",
      last_error: "disk full",
      console_level: "info",
      file_level: "debug",
    })).toEqual({ label: text.sinkStates.failed, tone: "error" });
  });
});

import { describe, expect, test } from "bun:test";
import type { DesktopSetupState } from "@lxe/desktop-protocol";
import {
  desktopSettingsForm,
  desktopLoggingSinkView,
  desktopSettingsSectionIsDirty,
  desktopSettingsSectionStatus,
} from "../../src/desktop/settings-model";

const setupState = (patch: Partial<DesktopSetupState> = {}): DesktopSetupState => ({
  complete: true,
  provider: "kimi_coding",
  provider_key_configured: true,
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
  legacy_environment_imported: true,
  ...patch,
});

describe("desktop settings navigation model", () => {
  test("projects saved state without returning secrets", () => {
    const form = desktopSettingsForm(setupState());

    expect(form.provider).toBe("kimi_coding");
    expect(form.workspaceRoot).toBe("/workspace");
    expect(form.apiKey).toBe("");
    expect(form.mabangPassword).toBe("");
    expect(form.feishuAppSecret).toBe("");
  });

  test("reports persisted status for every editable menu section", () => {
    const setup = setupState();

    expect(desktopSettingsSectionStatus("base", setup)).toBe("已完成");
    expect(desktopSettingsSectionStatus("ziniao", setup)).toBe("可选");
    expect(desktopSettingsSectionStatus("mabang", setup)).toBe("待补全");
    expect(desktopSettingsSectionStatus("feishu", setup)).toBe("已配置");
    expect(desktopSettingsSectionStatus("logging", setup)).toBe("标准");
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

    expect(desktopSettingsSectionStatus("feishu", setup)).toBe("已配置");
    expect(desktopSettingsSectionIsDirty("feishu", form, baseline)).toBe(true);
  });

  test("presents logging sinks without promoting disabled logging to an error", () => {
    expect(desktopLoggingSinkView(undefined)).toEqual({ label: "未启动", tone: "neutral" });
    expect(desktopLoggingSinkView({
      local_file_enabled: true,
      file_path: "/data/var/logs/runtime.log",
      disabled_reason: "",
      last_error: "",
      console_level: "info",
      file_level: "info",
    })).toEqual({ label: "写入中", tone: "ready" });
    expect(desktopLoggingSinkView({
      local_file_enabled: false,
      file_path: "",
      disabled_reason: "disabled_by_config",
      last_error: "",
      console_level: "info",
      file_level: "info",
    })).toEqual({ label: "已关闭", tone: "neutral" });
    expect(desktopLoggingSinkView({
      local_file_enabled: false,
      file_path: "",
      disabled_reason: "missing_log_file",
      last_error: "",
      console_level: "info",
      file_level: "info",
    })).toEqual({ label: "配置缺失", tone: "warning" });
    expect(desktopLoggingSinkView({
      local_file_enabled: false,
      file_path: "/data/var/logs/runtime.log",
      disabled_reason: "sink_failed",
      last_error: "disk full",
      console_level: "info",
      file_level: "debug",
    })).toEqual({ label: "写入失败", tone: "error" });
  });
});

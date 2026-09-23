import { describe, expect, test } from "bun:test";
import { setupState, cloudState } from "./settings-fixture-data";
import {
  desktopCloudBindingSwitchAvailable,
  desktopCloudShortcutAvailable,
  desktopSettingsForm,
  desktopSettingsFormAfterClear,
  ERP_INTEGRATIONS,
  desktopLoggingSinkView,
  desktopSettingsSectionIsDirty,
  desktopSettingsSectionStatus,
} from "../../src/desktop/settings-model";
import { ZH_TEXT } from "../../src/shared/i18n";

const text = ZH_TEXT.desktop;

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


test("ERP navigation aggregates configured platforms and drafts independently", () => {
  const setup = setupState();
  for (const name of ERP_INTEGRATIONS.slice(0, 3)) setup[name].configured = true;
  const baseline = desktopSettingsForm(setup);
  expect(desktopSettingsSectionStatus(text, "erp", setup)).toBe("已配置 3/4");
  expect(desktopSettingsSectionIsDirty("erp", baseline, baseline)).toBe(false);
  for (const field of ["mabangTmsAccount", "yacangPassword", "shangmanTenantId", "mabangPassword"] as const) {
    expect(desktopSettingsSectionIsDirty("erp", { ...baseline, [field]: "draft" }, baseline)).toBe(true);
  }
});

test("clearing one platform preserves all other unsaved credentials and settings", () => {
  const next = setupState();
  const current = { ...desktopSettingsForm(next), mabangTmsAccount: "draft-tms", mabangTmsPassword: "secret-tms",
    yacangPassword: "secret-yacang", shangmanTenantId: "draft-id", mabangPassword: "secret-mabang",
    localApiKey: "draft-key", workspaceRoot: "/draft-workspace" };
  const result = desktopSettingsFormAfterClear(current, next, "mabangTms");
  expect(result).toEqual({ ...current, mabangTmsAccount: "", mabangTmsPassword: "" });
  expect(current.mabangTmsPassword).toBe("secret-tms");
});

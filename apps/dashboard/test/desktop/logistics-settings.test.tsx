import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopLogisticsProfile, DesktopLogisticsSettingsState } from "@lxe/desktop-protocol";
import { LogisticsSettingsPanel } from "../../src/desktop/logistics-settings-panel";
import type { LogisticsSettingsController } from "../../src/desktop/use-logistics-settings";
import { logisticsProfileInput } from "../../src/desktop/logistics-settings-model";
import { I18nContext, UI_TEXT } from "../../src/shared/i18n";

const profile: DesktopLogisticsProfile = { profile_id: "00000000-0000-0000-0000-000000000001", display_name: "天泰 A", provider_id: "tiantai", enabled: true, account_name: "公司 A", login_username: "actual-login-123", password_configured: true, created_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" };
const providers: DesktopLogisticsSettingsState["providers"] = ["wesa", "feiwo", "yuntuo", "tiantai", "jiufang"].map(id => ({ provider_id: id as DesktopLogisticsProfile["provider_id"], label: id, transport: id === "jiufang" ? "public_http" : "ziniao_browser", requires_store: id !== "jiufang", requires_account_name: ["wesa", "tiantai"].includes(id) }));
const state: DesktopLogisticsSettingsState = { schema_version: 3, revision: 1, profiles: [profile], providers };
function controller(overrides: Partial<LogisticsSettingsController> = {}): LogisticsSettingsController {
  return { state, draft: null, error: "", busy: false, mutating: false, dirty: false, edit() {}, change() {}, discard() {}, reload() {}, save() {}, remove() {}, ...overrides };
}
function render(c: LogisticsSettingsController, language: "zh" | "en" = "zh") {
  return renderToStaticMarkup(<I18nContext.Provider value={UI_TEXT[language]}><LogisticsSettingsPanel controller={c} headingRef={{ current: null }} /></I18nContext.Provider>);
}
test("editing account metadata does not copy secrets, store bindings or server-owned fields", () => {
  expect(logisticsProfileInput({ ...profile, store_binding: { store_id: "legacy", store_name: "old" } } as DesktopLogisticsProfile)).not.toHaveProperty("store_binding");
  expect(logisticsProfileInput(profile)).not.toHaveProperty("updated_at");
  expect(logisticsProfileInput(profile)).not.toHaveProperty("password_configured");
  expect(logisticsProfileInput(profile)).not.toHaveProperty("password");
  expect(logisticsProfileInput(profile)).not.toHaveProperty("account_name");
});
test.each(["zh", "en"] as const)("panel renders saved profiles with explicit buttons and no nested form (%s)", language => {
  const html = render(controller(), language);
  expect(html).toContain("天泰 A"); expect(html).toContain(UI_TEXT[language].desktop.logistics.active);
  expect(html).not.toContain('name="logistics-store"');
  expect(html).not.toContain("<form");
  const buttons = html.match(/<button[^>]*>/g)!;
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every(button => button.includes('type="button"'))).toBe(true);
});
test.each(providers)("editor follows provider field requirements: $provider_id", spec => {
  const input = { ...logisticsProfileInput(profile), provider_id: spec.provider_id, account_name: spec.requires_account_name ? "公司 A" : null };
  const html = render(controller({ state: { ...state, profiles: [] }, draft: { input, revision: 1, original: JSON.stringify(input) } }));
  expect(html.includes('name="logistics-account"')).toBe(false);
  expect(html).not.toContain('name="logistics-store"');
  expect(html.includes('name="logistics-username"')).toBe(spec.requires_store);
  expect(html.includes('name="logistics-password"')).toBe(spec.requires_store);
  expect(html).not.toContain("<form");
});

test("legacy company metadata is absent from the UI and saved passwords never populate the editor", () => {
  const input = logisticsProfileInput(profile);
  const html = render(controller({ draft: { input, revision: 1, original: JSON.stringify(input) } }));
  expect(html).toContain('name="logistics-username"');
  expect(html).toContain('value="actual-login-123"');
  expect(html).not.toContain("公司 A");
  expect(html).not.toContain('name="logistics-account"');
  const passwordInput = html.match(/<input\b[^>]*name="logistics-password"[^>]*>/)![0];
  expect(passwordInput).toContain('type="password"'); expect(passwordInput).toContain('value=""');
  expect(html).toContain(UI_TEXT.zh.desktop.logistics.clearPassword);
  const changed = { ...input, login_username: "other-login" };
  expect(render(controller({ draft: { input: changed, revision: 1, original: "" } }))).toContain(UI_TEXT.zh.desktop.logistics.changedLogin);
});
test("account configuration is independent of browser status and real errors are escaped", () => {
  const input = logisticsProfileInput(profile);
  const html = render(controller({ draft: { input, revision: 1, original: "" }, error: "<script>fixture</script>" }));
  expect(html).not.toContain("绑定店铺"); expect(html).not.toContain("店铺未运行");
  expect(html.match(/<button\b[^>]*>保存配置<\/button>/)?.[0]).not.toContain("disabled");
  const disabled = render(controller({ state: { ...state, profiles: [{ ...profile, enabled: false }] } }));
  expect(disabled).toContain(UI_TEXT.zh.desktop.logistics.disabled);
  expect(html).toContain("&lt;script&gt;fixture&lt;/script&gt;"); expect(html).not.toContain("<script>");
  expect(render(controller({ state: null, error: "JSONDecodeError fixture" }))).not.toContain(UI_TEXT.zh.desktop.logistics.empty);
  expect(render(controller({ state: { ...state, profiles: [] } }))).toContain(UI_TEXT.zh.desktop.logistics.empty);
});

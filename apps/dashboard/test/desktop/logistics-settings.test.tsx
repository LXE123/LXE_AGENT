import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopLogisticsProfile, DesktopLogisticsSettingsState } from "@lxe/desktop-protocol";
import { LogisticsSettingsPanel } from "../../src/desktop/logistics-settings-panel";
import type { LogisticsSettingsController } from "../../src/desktop/use-logistics-settings";
import { logisticsBindingStatus, logisticsProfileInput } from "../../src/desktop/logistics-settings-model";
import { I18nContext, UI_TEXT } from "../../src/shared/i18n";

const profile: DesktopLogisticsProfile = { profile_id: "00000000-0000-0000-0000-000000000001", display_name: "天泰 A", provider_id: "tiantai", enabled: true, account_name: "公司 A", login_username: "actual-login-123", password_configured: true, store_binding: { store_id: "store==", store_name: "店铺 A" }, created_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" };
const providers: DesktopLogisticsSettingsState["providers"] = ["wesa", "feiwo", "yuntuo", "tiantai", "jiufang"].map(id => ({ provider_id: id as DesktopLogisticsProfile["provider_id"], label: id, transport: id === "jiufang" ? "public_http" : "ziniao_browser", requires_store: id !== "jiufang", requires_account_name: ["wesa", "tiantai"].includes(id) }));
const state: DesktopLogisticsSettingsState = { schema_version: 2, revision: 1, profiles: [profile], providers, stores: [{ store_id: "store==", store_name: "店铺 A", running: true }], stores_error: null };
function controller(overrides: Partial<LogisticsSettingsController> = {}): LogisticsSettingsController {
  return { state, draft: null, error: "", busy: false, mutating: false, dirty: false, edit() {}, change() {}, discard() {}, reload() {}, save() {}, remove() {}, ...overrides };
}
function render(c: LogisticsSettingsController, language: "zh" | "en" = "zh") {
  return renderToStaticMarkup(<I18nContext.Provider value={UI_TEXT[language]}><LogisticsSettingsPanel controller={c} headingRef={{ current: null }} /></I18nContext.Provider>);
}
test("binding states distinguish current running, absent, renamed, ambiguous and failed discovery", () => {
  expect(logisticsBindingStatus(profile, state)).toBe("ready");
  expect(logisticsBindingStatus({ ...profile, enabled: false }, state)).toBe("disabled");
  expect(logisticsBindingStatus({ ...profile, store_binding: null }, state)).toBe("public");
  expect(logisticsBindingStatus(profile, { ...state, stores_error: "fixture error" })).toBe("unavailable");
  expect(logisticsBindingStatus(profile, { ...state, stores: [] })).toBe("missing");
  expect(logisticsBindingStatus(profile, { ...state, stores: [...state.stores, ...state.stores] })).toBe("ambiguous");
  expect(logisticsBindingStatus(profile, { ...state, stores: [{ ...state.stores[0]!, store_name: "renamed" }] })).toBe("renamed");
  expect(logisticsBindingStatus(profile, { ...state, stores: [{ ...state.stores[0]!, running: false }] })).toBe("stopped");
  expect(logisticsProfileInput(profile)).not.toHaveProperty("updated_at");
  expect(logisticsProfileInput(profile)).not.toHaveProperty("password_configured");
  expect(logisticsProfileInput(profile)).not.toHaveProperty("password");
});
test.each(["zh", "en"] as const)("panel renders saved profiles with explicit buttons and no nested form (%s)", language => {
  const html = render(controller(), language);
  expect(html).toContain("天泰 A"); expect(html).toContain(UI_TEXT[language].desktop.logistics.status.ready);
  expect(html).not.toContain("<form");
  const buttons = html.match(/<button[^>]*>/g)!;
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every(button => button.includes('type="button"'))).toBe(true);
});
test.each(providers)("editor follows provider field requirements: $provider_id", spec => {
  const input = { ...logisticsProfileInput(profile), provider_id: spec.provider_id, account_name: spec.requires_account_name ? "公司 A" : null, store_binding: spec.requires_store ? profile.store_binding : null };
  const html = render(controller({ state: { ...state, profiles: [] }, draft: { input, revision: 1, original: JSON.stringify(input) } }));
  const t = UI_TEXT.zh.desktop.logistics;
  expect(html.includes('name="logistics-account"')).toBe(spec.requires_account_name);
  expect(html.includes(t.chooseStore)).toBe(spec.requires_store);
  expect(html.includes('name="logistics-username"')).toBe(spec.requires_store);
  expect(html.includes('name="logistics-password"')).toBe(spec.requires_store);
  expect(html).not.toContain("<form");
});

test("login and page company remain independent, saved passwords never populate the editor", () => {
  const input = logisticsProfileInput(profile);
  const html = render(controller({ draft: { input, revision: 1, original: JSON.stringify(input) } }));
  expect(html).toContain('name="logistics-username"');
  expect(html).toContain('value="actual-login-123"');
  expect(html).toContain('value="公司 A"');
  const passwordInput = html.match(/<input\b[^>]*name="logistics-password"[^>]*>/)![0];
  expect(passwordInput).toContain('type="password"'); expect(passwordInput).toContain('value=""');
  expect(html).toContain(UI_TEXT.zh.desktop.logistics.clearPassword);
  const changed = { ...input, login_username: "other-login" };
  expect(render(controller({ draft: { input: changed, revision: 1, original: "" } }))).toContain(UI_TEXT.zh.desktop.logistics.changedLogin);
});
test("missing stores preserve saved binding, error text is escaped and failures differ from empty state", () => {
  const input = logisticsProfileInput(profile);
  const html = render(controller({ state: { ...state, stores: [] }, draft: { input, revision: 1, original: "" }, error: "<script>fixture</script>" }));
  expect(html).toContain("店铺 A"); expect(html).toContain("当前未发现");
  expect(html).toContain("&lt;script&gt;fixture&lt;/script&gt;"); expect(html).not.toContain("<script>");
  expect(render(controller({ state: null, error: "JSONDecodeError fixture" }))).not.toContain(UI_TEXT.zh.desktop.logistics.empty);
  expect(render(controller({ state: { ...state, profiles: [] } }))).toContain(UI_TEXT.zh.desktop.logistics.empty);
});

// Mock-only renderer for the native ERP settings smoke test. No real credentials or IPC.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DesktopShell } from "../../src/desktop/shell";
import { I18nContext, UI_TEXT, type Language } from "../../src/shared/i18n";
import { ERP_INTEGRATIONS } from "../../src/desktop/settings-model";
import { setupState, cloudState } from "./settings-fixture-data";
import { ONBOARDING_DISMISSED_STORAGE_KEY } from "../../src/desktop/onboarding-preference";
import type { DesktopSetupInput } from "@lxe/desktop-protocol";
import "../../src/styles.css";

const onboarding = new URLSearchParams(location.search).has("onboarding");
localStorage.removeItem(ONBOARDING_DISMISSED_STORAGE_KEY);
const initial = setupState({ complete: !onboarding });
let saved = structuredClone(initial);
for (const name of ERP_INTEGRATIONS.slice(0, 3)) {
  Object.assign(saved[name], { managed: true, configured: true, password_configured: true, issues: [] });
}
Object.assign(saved.mabangTms, { account: "mock-tms" });
Object.assign(saved.yacang, { mobile: "mock-mobile" });
Object.assign(saved.shangman, { tenant_id: "mock-id", username: "mock-user" });
const fixture = { failSave: false, calls: [] as DesktopSetupInput[] };
Object.assign(window, { erpFixture: fixture, lxe: { desktop: {
  platform: "darwin",
  getSetupState: async () => structuredClone(saved),
  getHealth: async () => ({ gateway: "ready", agent_cli: "ready", lxeskill: "ready", message: "", logging: {} }),
  getCloudState: async () => cloudState(),
  onStatusChanged: () => () => {},
  onCloudStateChanged: () => () => {},
  saveSetup: async (input: DesktopSetupInput) => {
    fixture.calls.push(structuredClone(input));
    if (fixture.failSave) throw new Error("Mock ERP storage failure: EACCES");
    for (const name of ERP_INTEGRATIONS) {
      const change = input[name];
      if (!change) continue;
      if (change.action === "clear") {
        saved[name] = { ...initial[name], managed: false, configured: false, issues: [] } as never;
      } else {
        const { password, ...fields } = change;
        Object.assign(saved[name], fields, { managed: true, configured: true, issues: [],
          password_configured: Boolean(password) || saved[name].password_configured });
      }
    }
    return structuredClone(saved);
  },
} } });

function Fixture() {
  const [language, setLanguage] = useState<Language>("zh");
  Object.assign(window, { fixtureLanguage: setLanguage });
  return <I18nContext.Provider value={UI_TEXT[language]}>
    <DesktopShell language={language} onLanguageChange={setLanguage} theme="light" fontSize="large"
      onThemeChange={() => {}} onFontSizeChange={() => {}}>
      {({ openSettings }) => <button id="open-settings" onClick={() => openSettings("erp")}>Open ERP settings</button>}
    </DesktopShell>
  </I18nContext.Provider>;
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>,
);

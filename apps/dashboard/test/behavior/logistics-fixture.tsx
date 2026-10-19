import { useState } from "react";
import type { DesktopLogisticsProfileInput, DesktopLogisticsSettingsState } from "@lxe/desktop-protocol";
import { DesktopShell } from "../../src/desktop/shell";
import { I18nContext, UI_TEXT, type Language } from "../../src/shared/i18n";

const providers: DesktopLogisticsSettingsState["providers"] = ["wesa", "feiwo", "yuntuo", "tiantai", "jiufang"].map(id => ({
  provider_id: id as DesktopLogisticsProfileInput["provider_id"], label: ({wesa:"威飒",feiwo:"飞沃",yuntuo:"云驼",tiantai:"天泰供应链",jiufang:"九方"})[id]!,
  transport: id === "jiufang" ? "public_http" : "ziniao_browser", requires_store: id !== "jiufang", requires_account_name: ["wesa", "tiantai"].includes(id),
}));
let state: DesktopLogisticsSettingsState = { schema_version: 1, revision: 0, profiles: [], providers,
  stores: [{store_id:"one==",store_name:"Amazon 店铺一 深圳市公司 A",running:true}, {store_id:"two==",store_name:"Amazon 店铺二 深圳市公司 B",running:false}], stores_error:null };
let readFailure = false;
let holdSave = false;
let releaseSave: (() => void) | undefined;
const calls: {operation: string; input?: unknown; revision?: number}[] = [];
export const logisticsMock = {
  state: () => structuredClone(state), calls: () => structuredClone(calls),
  failRead(value: boolean) { readFailure = value; },
  patch(value: Partial<DesktopLogisticsSettingsState>) { Object.assign(state, value); },
  holdSave(value: boolean) { holdSave = value; }, releaseSave() { releaseSave?.(); },
};
export const logisticsDesktop = {
  async getLogisticsSettings() { calls.push({operation:"read"}); if(readFailure) throw new Error("JSONDecodeError: fixture broken profiles"); return structuredClone(state); },
  async refreshLogisticsStores() { calls.push({operation:"refresh"}); return logisticsDesktop.getLogisticsSettings(); },
  async saveLogisticsProfile(input: DesktopLogisticsProfileInput, revision: number) {
    calls.push({operation:"save",input:structuredClone(input),revision});
    if(holdSave) await new Promise<void>(resolve=>{releaseSave=resolve;});
    if(revision !== state.revision) throw new Error("Revision conflict: reload logistics settings before saving");
    const old = state.profiles.find(p=>p.profile_id===input.profile_id);
    const now = new Date().toISOString();
    state.profiles = [...state.profiles.filter(p=>p.profile_id!==input.profile_id), {...input,profile_id:input.profile_id??crypto.randomUUID(),created_at:old?.created_at??now,updated_at:now}];
    state.revision++;
    return structuredClone(state);
  },
  async deleteLogisticsProfile(id: string, revision: number) {
    calls.push({operation:"delete",input:id,revision});
    if(revision !== state.revision) throw new Error("Revision conflict: reload logistics settings before deleting");
    state.profiles=state.profiles.filter(p=>p.profile_id!==id); state.revision++; return structuredClone(state);
  },
};
export function LogisticsFixture() {
  const [language, setLanguage] = useState<Language>("zh");
  return <I18nContext.Provider value={UI_TEXT[language]}><DesktopShell language={language} onLanguageChange={setLanguage}
    theme="light" fontSize="large" onThemeChange={()=>{}} onFontSizeChange={()=>{}}>
    {({openSettings}) => <button id="open-logistics" onClick={()=>openSettings("logistics")}>Open logistics</button>}
  </DesktopShell></I18nContext.Provider>;
}

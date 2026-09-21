import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setDashboardTransportForTests } from "../../../src/api/client";
import { SkillsCatalogView, type SkillConversationAction } from "../../../src/features/skills/user-view";
import { AddSkillMenu } from "../../../src/features/skills/add-menu";
import { useSkillsQuery } from "../../../src/api/queries";
import type { SkillPayload } from "@lxe/desktop-protocol";
import { DetailModal } from "../../../src/features/details/view";
import type { DetailTarget } from "../../../src/shared/ui/detail-target";
import { ConversationComposer } from "../../../src/features/sessions/view";
import { appendComposerDraftPrompt } from "../../../src/features/sessions/composer-draft";
import { I18nContext, UI_TEXT, useUiText, type Language } from "../../../src/shared/i18n";
import "../../../src/styles.css";
const calls: string[] = [];
setDashboardTransportForTests({ async call(call) {
  calls.push(call.operation);
  const response = await fetch("/__skills", { method: "POST", body: JSON.stringify(call) });
  if (!response.ok) throw new Error(await response.text()); return response.json();
} });
const client = new QueryClient();
const noop = async () => {};
function Fixture() {
  const [conversation, showConversation] = useState(false), [sent, setSent] = useState(0);
  const t = useUiText();
  const skills = useSkillsQuery(true);
  const [detail, setDetail] = useState<DetailTarget>(null);
  const onConversation = (action: SkillConversationAction, skill?: SkillPayload) => {
    const prompt = action === "create" ? t.userSkills.createPrompt : t.userSkills.usePrompt(skill!.name);
    appendComposerDraftPrompt(sessionStorage, "skill-acceptance-draft", prompt); showConversation(true);
  };
  return <main style={{ padding: 24, maxWidth: 1150, margin: "auto" }}>
    <nav><button onClick={() => showConversation(false)}>技能管理</button><button onClick={() => showConversation(true)}>新对话草稿</button>
      <button onClick={() => { void client.invalidateQueries({ queryKey: ["skills"] }); }}>刷新目录</button></nav>
    <p role="status">已发送消息：{sent}</p>
    {conversation ? <ConversationComposer contextDetail={null} activity={null} conversationKey="skill-acceptance-draft" currentModel={null}
      modelLoading={false} models={[]} modelSaving={false} thinkingSaving={false} runtimeReady runtimeUnavailableMessage=""
      onModelChange={() => {}} onThinkingLevelChange={() => {}} onSend={async () => { setSent(n => n + 1); }} onStop={noop} />
      : <section className="workspace-view"><header className="workspace-view-header">
        <div className="workspace-header-actions"><nav aria-label={t.nav.capabilities} className="workspace-subnav">
          {[t.nav.skills, t.nav.tools, t.nav.connections, t.nav.models].map(label =>
            <button key={label} className={label === t.nav.skills ? "workspace-subnav-item active" : "workspace-subnav-item"}>{label}</button>)}
        </nav>
          <AddSkillMenu onAdd={() => onConversation("create")} /></div></header>
        <SkillsCatalogView skills={skills.data?.items ?? []} commands={[]} onOpen={setDetail} onConversation={onConversation} /></section>}
    <DetailModal enabled target={detail} onClose={() => setDetail(null)} />
    <details><summary>调用记录</summary><pre>{calls.join("\n")}</pre></details>
  </main>;
}
function LocalizedFixture() {
  const [language, setLanguage] = useState<Language>("zh");
  return <I18nContext.Provider value={UI_TEXT[language]}>
    <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>中文 / English</button><Fixture />
  </I18nContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><LocalizedFixture /></QueryClientProvider>);

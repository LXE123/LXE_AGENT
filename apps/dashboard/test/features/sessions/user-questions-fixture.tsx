import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUserQuestionsQuery } from "../../../src/api/queries";
import { callDashboard } from "../../../src/api/client";
import { ConversationComposer, SessionsIndex, UnifiedConversationRow } from "../../../src/features/sessions/view";
import { toolOperations } from "../../../src/features/sessions/conversation";
import { conversationRows } from "../../../src/features/sessions/presentation";
import { isRecord } from "../../../src/shared/content";
import type { SessionDetailPayload, SessionPayload } from "../../../src/api/payloads";
import type { SessionRunSummary } from "@lxe/protocol/session-status";
import "../../../src/styles.css";
const noop = async () => {};
const sessions: SessionPayload[] = (await callDashboard({ operation: "sessions.list", input: {} })).items.map(session => ({
  ...session, title: session.session_id === "a" ? "店铺资料整理 · 一段很长的会话标题也应该保持单行显示" : `会话 ${session.session_id.toUpperCase()}`,
}));
function Fixture() {
  const [id, select] = useState("a");
  const [statusOverride, setStatus] = useState<SessionRunSummary["state"]>("running");
  const [unavailable, setUnavailable] = useState(false);
  const questions = useUserQuestionsQuery(true, id);
  const [detail, setDetail] = useState<SessionDetailPayload>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => { setExpanded({}); setDetail(undefined); }, [id]);
  useEffect(() => {
    let active = true;
    void callDashboard({ operation: "sessions.detail", input: { session_id: id } })
      .then(value => { if (active) setDetail(value); }).catch(() => { if (active) setDetail(undefined); });
    return () => { active = false; };
  }, [id, questions.data]);
  Object.assign(window, { questionFixture: { select, setStatus, setUnavailable, refetch: questions.refetch, pending: () => questions.data?.items,
    messages: () => detail?.messages, operations: () => detail && toolOperations(detail.messages) } });
  return <div style={{ display: "flex", height: "100vh" }}>
    <aside className="app-sidebar sidebar-session-section" style={{ width: 240, minWidth: 240, maxWidth: 240, flexShrink: 0 }}>
      <SessionsIndex sessions={sessions} query="" searchOpen={false} initialLoading={false} loadingMore={false} error="" hasMore={false} loadMoreError="" selectedSessionId={id}
        onQueryChange={() => {}} onSearchClose={() => {}} onLoadMore={() => {}} onNew={() => select("c")} onOpen={session => select(session.session_id)} onPin={noop} onDelete={noop}
        waitingSessionIds={new Set(questions.data?.items.map(q => q.session_id))} statusUnavailable={unavailable}
        statuses={new Map(sessions.map(session => [session.session_id, { session_id: session.session_id, version: 1, state: statusOverride }]))} />
    </aside>
    <main style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", padding: 24, gap: 20 }}>
    <p>当前会话：{id.toUpperCase()}</p>
    <div data-testid="tool-history" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      {detail && conversationRows(detail.messages, [], []).map(row => (
        <div key={row.id} data-row-kind={row.kind} data-tool-call-id={isRecord(row.operation?.call) ? String(row.operation.call.id) : undefined}>
          <UnifiedConversationRow row={row} expanded={!!expanded[row.id]} onToggle={key => setExpanded(value => ({ ...value, [key]: !value[key] }))}
            onOpenFile={noop} onRevealFile={noop} onOpenAttachment={noop} />
        </div>
      ))}
    </div>
    <ConversationComposer question={questions.data?.items.find(q => q.session_id === id)} onQuestionAnswered={() => { void questions.refetch(); }}
      contextDetail={null} activity={null} conversationKey={id} currentModel={null} modelLoading={false} models={[]}
      modelSaving={false} thinkingSaving={false} runtimeReady runtimeUnavailableMessage="" onModelChange={() => {}} onThinkingLevelChange={() => {}}
      onSend={noop} onStop={async () => { await callDashboard({ operation: "sessions.stop", input: { session_id: id } }); }} />
  </main></div>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>);

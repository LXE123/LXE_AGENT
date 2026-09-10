import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUserQuestionsQuery } from "../../../src/api/queries";
import { callDashboard } from "../../../src/api/client";
import { ConversationComposer } from "../../../src/features/sessions/view";
import { toolOperations } from "../../../src/features/sessions/conversation";
import { UserQuestionHistory } from "../../../src/features/sessions/user-questions";
import type { SessionDetailPayload } from "../../../src/api/payloads";
import "../../../src/styles.css";
const noop = async () => {};
function Fixture() {
  const [id, select] = useState("a");
  const questions = useUserQuestionsQuery(true, id);
  const [detail, setDetail] = useState<SessionDetailPayload>();
  useEffect(() => { void callDashboard({ operation: "sessions.detail", input: { session_id: id } }).then(setDetail).catch(() => setDetail(undefined)); }, [id, questions.data]);
  Object.assign(window, { questionFixture: { select, refetch: questions.refetch, pending: () => questions.data?.items } });
  return <main style={{ maxWidth: 760, margin: "25px auto", padding: 15 }}>
    <nav><button onClick={() => select("a")}>会话 A</button><button onClick={() => select("b")}>会话 B</button></nav>
    <p>当前会话：{id} · {questions.data?.items.map(q => `${q.session_id} 等待回答`).join(" · ")}</p>
    <div style={{ maxHeight: 180, overflow: "auto" }}>{detail && toolOperations(detail.messages).map(operation => operation.name === "ask_user_question"
      ? <UserQuestionHistory key={operation.key} operation={operation} pending={questions.data?.items.some(q => q.tool_call_id === operation.key)} /> : null)}</div>
    <ConversationComposer question={questions.data?.items.find(q => q.session_id === id)} onQuestionAnswered={() => { void questions.refetch(); }}
      contextDetail={null} activity={null} conversationKey={id} currentModel={null} modelLoading={false} models={[]}
      modelSaving={false} thinkingSaving={false} runtimeReady runtimeUnavailableMessage="" onModelChange={() => {}} onThinkingLevelChange={() => {}}
      onSend={noop} onStop={async () => { await callDashboard({ operation: "sessions.stop", input: { session_id: id } }); }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>);

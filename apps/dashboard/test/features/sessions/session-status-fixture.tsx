import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setDashboardTransportForTests } from "../../../src/api/client";
import { useSessionConversationQuery, useConversationActivityQuery } from "../../../src/api/queries";
import { ConversationDisplayController } from "../../../src/features/sessions/display-controller";
import { useSessionStatus } from "../../../src/api/queries";
import { SessionsIndex, SessionDetailView } from "../../../src/features/sessions/view";
import type { SessionPayload } from "../../../src/api/payloads";
import "../../../src/styles.css";

const request = async (operation: string, input = {}) => {
  const response = await fetch("/__session_status_fixture", { method: "POST", body: JSON.stringify({ operation, input }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
setDashboardTransportForTests({ call: call => request(call.operation, call.input) });
// Production hook uses the same subscription shape as Electron preload.
window.lxe = { desktop: { onSessionStatus: listener => {
  const source = new EventSource("/__session_status_fixture/events");
  source.onmessage = event => listener(JSON.parse(event.data));
  return () => source.close();
} } } as typeof window.lxe;
const sessions: SessionPayload[] = await request("fixture.sessions");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const noop = async () => {};
function Fixture() {
  const [controller] = useState(() => new ConversationDisplayController());
  const [id, select] = useState("idle"), [visible, show] = useState(true), [ready, connect] = useState(true);
  const query = useSessionConversationQuery(id, visible, controller); useConversationActivityQuery(id, visible);
  const status = useSessionStatus(sessions.map(s => s.session_id), ready, query.display, visible);
  Object.assign(window, { statusFixture: { request, select, show, connect, display: () => query.display, statuses: () => [...status.items.values()], focus: () => document.hasFocus() } });
  return <div style={{ display: "flex", height: "100vh" }}>
    <aside className="app-sidebar sidebar-session-section" style={{ width: 320, minWidth: 320, maxWidth: 320, flexShrink: 0 }}>
      <SessionsIndex sessions={sessions} query="" searchOpen={false} initialLoading={false} loadingMore={false} error="" hasMore={false} loadMoreError="" selectedSessionId={id}
        onQueryChange={() => {}} onSearchClose={() => {}} onLoadMore={() => {}} onNew={() => select("idle")} onOpen={session => select(session.session_id)} onPin={noop} onDelete={noop}
        statuses={status.items} statusUnavailable={!ready} statusError={status.error} />
    </aside>
    <main style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column" }}>
      <nav><button onClick={() => show(!visible)}>Toggle chat/home</button><button onClick={() => connect(!ready)}>Toggle connection</button></nav>
      <output id="status-state">{JSON.stringify({ id, visible, ready, focused: document.hasFocus(), load: query.display.loadState })}</output>
      {visible && <SessionDetailView fallbackSession={sessions.find(s => s.session_id === id)!} detail={query.data ?? null} activity={query.display.activity ?? null} display={query.display} pendingMessages={query.display.pending}
        currentModel={null} models={[]} modelLoading={false} modelSaving={false} thinkingSaving={false} newConversation={false} runtimeReady={ready} runtimeUnavailableMessage="Fixture disconnected"
        loading={query.isPending} error={query.display.error} hasOlder={query.hasPreviousPage} hasNewer={query.hasNextPage} loadingOlder={query.isFetchingPreviousPage}
        loadOlderError="" onLoadOlder={query.fetchPreviousPage} onLoadNewer={query.fetchNextPage} onJumpToLatest={query.jumpToLatest}
        onVisibleGroups={query.setVisibleGroups} onFollowingChange={query.setFollowing} onModelChange={() => {}} onThinkingLevelChange={() => {}} onSend={noop} onStop={noop} onOpenFile={noop} onRevealFile={noop} onOpenAttachment={noop} />}
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>);

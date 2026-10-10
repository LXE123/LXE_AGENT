import { useLayoutEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionWorkspace, type SessionWorkspace } from "../../src/features/sessions/use-session-workspace";
import { useDashboardNavigation } from "../../src/shared/use-dashboard-navigation";
import { appendComposerDraftPrompt } from "../../src/features/sessions/composer-draft";
import { conversationAttachments } from "../../src/features/sessions/attachment-draft";
import { readingState } from "../../src/features/file-preview/reading-state";
import { dashboardQueryKeys } from "../../src/api/query-keys";

const discarded: string[] = [];
const callbacks = { changed() {}, error(message: string) { throw Error(message); },
  async discard(ids: string[]) { discarded.push(...ids); }, tooMany: () => "Fixture screenshot limit" };
export const sessionFixture = {
  current: null as SessionWorkspace | null,
  navigation: null as ReturnType<typeof useDashboardNavigation> | null,
  ready: (_value: boolean) => {},
  draft(key: string, text: string, screenshots = 0) {
    appendComposerDraftPrompt(sessionStorage, key, text);
    conversationAttachments(key, callbacks).items = Array.from({length: screenshots}, (_, i) => ({
      attachment_id: `${key}-${i}`, name: `image-${i}.png`, size_bytes: 1, media_type: "image/png", preview_data_url: "data:image/png;base64,AA==",
    }));
  },
  attachments(key: string) { return conversationAttachments(key, callbacks).items.map(item => item.attachment_id); },
  discarded,
  seedCleanup: (_id: string) => {},
  cleaned: (_id: string): unknown => null,
};

// Keep the workflow mounted while routes and readiness change, exactly as App does.
export function SessionWorkspaceFixture() {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(true);
  const [error, setError] = useState("");
  const navigation = useDashboardNavigation();
  const workspace = useSessionWorkspace({ activeSection: navigation.activeSection, runtimeReady: ready,
    defaultDirectory: "/fixture/default", onEnterSessions: () => navigation.openDashboardSection("sessions"),
    onOpenSearch() {}, onError: setError });
  useLayoutEffect(() => {
    sessionFixture.current = workspace;
    sessionFixture.navigation = navigation;
    sessionFixture.ready = setReady;
    sessionFixture.seedCleanup = id => {
      readingState(id, "file").zoom = 7;
      localStorage.setItem(`lxe.file-preview.v1.${id}`, "fixture");
      queryClient.setQueryData(dashboardQueryKeys.sessions.detailSession(id).concat("fixture"), {});
      queryClient.setQueryData(dashboardQueryKeys.sessions.activity(id), { session_id: id, active: null, latest: null, queued: [] });
    };
    sessionFixture.cleaned = id => ({
      history: queryClient.getQueriesData({queryKey: dashboardQueryKeys.sessions.detailSession(id)}).length,
      activity: queryClient.getQueryData(dashboardQueryKeys.sessions.activity(id)) ?? null,
      preview: localStorage.getItem(`lxe.file-preview.v1.${id}`), zoom: readingState(id, "file").zoom,
      attachments: sessionFixture.attachments(id),
    });
  });
  return <output id="session-state">{JSON.stringify({ selection: workspace.selection, error,
    section: navigation.activeSection, capabilityView: navigation.capabilityView, viewKey: workspace.conversation.display.viewKey,
    pending: workspace.conversation.pendingMessages })}</output>;
}

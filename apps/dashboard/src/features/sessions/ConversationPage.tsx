import type { ComponentProps } from "react";
import { FilePreviewLayout } from "../file-preview/Sidebar";
import { useUiText } from "../../shared/i18n";
import { EmptyState } from "../../shared/components";
import { SessionDetailView } from "./view";
import { WorkspaceControl } from "./workspaces";
import type { SessionWorkspace } from "./use-session-workspace";

type Props = Readonly<{
  selection: SessionWorkspace["selection"];
  conversation: SessionWorkspace["conversation"];
  workspace: Pick<SessionWorkspace["sidebar"], "defaultDirectory" | "workspaces">;
  actions: Pick<SessionWorkspace["actions"],
    "switchConversationWorkspace" | "chooseConversationWorkspace" | "questionAnswered" | "approvalChanged" |
    "loadOlder" | "loadNewer" | "visibleGroupsChanged" | "jumpToLatest" | "followingChanged" |
    "sendConversation" | "stopConversation" | "openConversationFile" | "revealConversationFile" | "openConversationAttachment">;
  model: Readonly<Pick<ComponentProps<typeof SessionDetailView>,
    "currentModel" | "models" | "modelLoading" | "modelSaving" | "thinkingSaving" | "onModelChange" | "onThinkingLevelChange">>;
  setupComplete: boolean;
}>;

export function ConversationPage({ selection, conversation, workspace, actions, model, setupComplete }: Props) {
  const t = useUiText();
  const { selectedSessionId, newConversation, selectedSession } = selection;
  const dashboardRuntimeReady = conversation.runtimeReady;
  return (
    <section className="sessions-conversation-shell">
      <FilePreviewLayout sessionId={selectedSessionId ?? ""}>
        {selectedSessionId || newConversation ? (
          <SessionDetailView
            workspaceControl={<WorkspaceControl
              directory={selectedSession?.workspace.directory ?? workspace.defaultDirectory}
              defaultDirectory={workspace.defaultDirectory}
              workspaces={workspace.workspaces}
              editable={newConversation}
              disabled={!dashboardRuntimeReady || conversation.pendingMessages.some(item => !item.error)}
              onChange={actions.switchConversationWorkspace}
              onChoose={actions.chooseConversationWorkspace}
            />}
            {...conversation}
            onQuestionAnswered={actions.questionAnswered}
            onApprovalChanged={actions.approvalChanged}
            {...model}
            newConversation={newConversation}
            runtimeReady={dashboardRuntimeReady}
            runtimeUnavailableMessage={setupComplete
              ? t.conversation.unavailable
              : t.conversation.modelUnavailable}
            onLoadOlder={actions.loadOlder}
            onLoadNewer={actions.loadNewer}
            onVisibleGroups={actions.visibleGroupsChanged}
            onJumpToLatest={actions.jumpToLatest}
            onSend={actions.sendConversation}
            onStop={actions.stopConversation}
            onOpenFile={actions.openConversationFile}
            onRevealFile={actions.revealConversationFile}
            onOpenAttachment={actions.openConversationAttachment}
            onFollowingChange={actions.followingChanged}
          />
        ) : (
          <EmptyState label={selectedSessionId ? t.sessionDetail.loading : t.sessions.selectPrompt} />
        )}
      </FilePreviewLayout>
    </section>
  );
}

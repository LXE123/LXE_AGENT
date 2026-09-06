// Real composer with a local submission sink; used by the native Electron paste smoke.
import React from "react";
import { createRoot } from "react-dom/client";
import { ConversationComposer } from "../../../src/features/sessions/view";
import "../../../src/styles.css";
createRoot(document.getElementById("root")!).render(<ConversationComposer
  contextDetail={null} activity={null} conversationKey="paste-fixture" currentModel={null}
  modelLoading={false} models={[]} modelSaving={false} thinkingSaving={false}
  runtimeReady runtimeUnavailableMessage="" onModelChange={() => {}} onThinkingLevelChange={() => {}}
  onSend={async () => {}} onStop={async () => {}}
/>);

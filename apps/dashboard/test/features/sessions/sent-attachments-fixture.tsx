import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UnifiedConversationRow } from "../../../src/features/sessions/view";
import type { ConversationRow } from "../../../src/features/sessions/presentation";
import "../../../src/styles.css";
const images = ["image-one", "image-two", "image-3", "image-4", "image-5", "image-6"].map((id) => ({
  attachment_id: id, name: `${id}.png`, media_type: "image/png", size_bytes: 100,
}));
const files = ["为全人类.S02E05.mp4", "为全人类.S02E03.mp4", "为全人类.S02E01.mp4", "DEV-mac-1-2f50da62.lxe-enroll", "report.zip", "notes.txt"]
  .map((name, index) => ({ attachment_id: `file-${index}`, name, media_type: "application/octet-stream", size_bytes: 100 }));
function Fixture() {
  const [session, setSession] = useState("fixture");
  const [text, setText] = useState("test");
  const [imageCount, setImageCount] = useState(2);
  Object.assign(window, { fixtureSession: setSession, fixtureText: setText, fixtureImageCount: setImageCount });
  const row: ConversationRow = { id: "row", groupId: "group", turnId: "turn", kind: "message", status: "completed", createdAt: 1,
    message: { role: "user", display_group_id: "group", content: text, attachments: [...files, ...images.slice(0, imageCount)] } };
  return <main className="conversation-feed" style={{ paddingTop: 60 }}>
    <UnifiedConversationRow row={row} expanded={false} onToggle={() => {}} onOpenFile={async () => {}}
      onRevealFile={async () => {}} onOpenAttachment={async (id) => { Object.assign(window, { openedAttachment: id }); }} attachmentSessionId={session} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>);

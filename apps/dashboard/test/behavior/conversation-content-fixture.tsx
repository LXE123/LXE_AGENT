import { useState } from "react";
import { UnifiedConversationRow } from "../../src/features/sessions/view";
import type { ConversationRow } from "../../src/features/sessions/presentation";
import { sessionActions } from "../../src/api/session-actions";

const content = "A **complete** answer\n\n```typescript\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Report | " + "long-cell-".repeat(80) + " |";
const base = { groupId: "group", turnId: "turn", createdAt: 1, status: "completed" as const };
const rows: ConversationRow[] = [
  { ...base, id: "answer", kind: "message", message: { display_group_id: "group", role: "assistant", content } },
  { ...base, id: "files", kind: "artifacts", artifacts: [{ artifact_id: "artifact-handle", name: "report.xlsx", turn_id: "turn", tool_call_id: "tool" }] },
  { ...base, id: "attachment", kind: "message", message: { display_group_id: "group", role: "user", content: "Read this file", attachments: [
    { attachment_id: "attachment-handle", name: "input.txt", media_type: "text/plain", size_bytes: 20 },
  ] } },
];
const openFile = async (id: string) => { await sessionActions.openFile("content-session", id); };
const revealFile = async (id: string) => { await sessionActions.revealFile("content-session", id); };
const openAttachment = async (id: string) => { await sessionActions.openAttachment("content-session", id); };
export function ConversationContentFixture() {
  const [expanded, setExpanded] = useState(false);
  const [toolDone, setToolDone] = useState(false);
  const [startedAt] = useState(() => Date.now() - 5_000);
  return <main className="conversation-feed" style={{ maxWidth: "100%", padding: 24 }}>
    <section data-fixture-row="live-codemode">
      <UnifiedConversationRow row={{ ...base, id: "script", kind: "tool", liveTool: {
        id: "call", name: "codemode", title: "Codemode", detail: "", icon_token: "tool", duration_ms: 0,
        status: toolDone ? "success" : "running", input_block: { language: "text", content: "return await tools.read({path:'orders.csv'})" },
        ...(toolDone ? { result_block: { language: "text" as const, content: "order-123" } } : {}),
      } }} expanded={expanded} onToggle={() => setExpanded(value => !value)} onOpenFile={openFile} onRevealFile={revealFile} onOpenAttachment={openAttachment} />
      <button onClick={() => setToolDone(true)}>Finish fixture tool</button>
    </section>
    {[...rows, { ...base, id: "process", kind: "process" as const, status: "running" as const, startedAt, phase: "thinking" }].map(row =>
      <section key={row.id} data-fixture-row={row.id}>
        <UnifiedConversationRow row={row} expanded={expanded} onToggle={() => setExpanded(value => !value)}
          onOpenFile={openFile} onRevealFile={revealFile} onOpenAttachment={openAttachment} />
      </section>)}
  </main>;
}

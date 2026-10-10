import { UnifiedConversationRow } from "../../src/features/sessions/view";
import { SkillDetailDialog } from "../../src/shared/ui/skill-detail-dialog";

export type MarkdownSurface = "conversation" | "skill";
const noop = () => {};
const unusedFileAction = async () => { throw new Error("Markdown fixture has no files to open"); };

// Exercise both production Markdown consumers, including their real wrappers.
// Use an attached document: SKILL.md intentionally omits its opening H1 and
// already has dedicated coverage in shared/skill-preview.test.tsx.
export function MarkdownFixture({ surface, content }: { surface: MarkdownSurface; content: string }) {
  if (surface === "skill") return <SkillDetailDialog
    title="Markdown preview" skill={{ name: "markdown-fixture", type: "default", description: "",
      location: "/skills/markdown-fixture/SKILL.md", commands: [], references: [] }}
    close={noop} files={["reference.md"]} selectedFile="reference.md" onSelectFile={noop} content={content}
  />;
  return <main className="conversation-feed" aria-label="Conversation preview">
    <UnifiedConversationRow row={{ id: "markdown-message", groupId: "markdown-group", turnId: "markdown-turn",
      kind: "message", presentation: "final", createdAt: 1, status: "completed",
      message: { role: "assistant", display_group_id: "markdown-group", content } }}
      expanded={false} onToggle={noop} onOpenFile={unusedFileAction}
      onRevealFile={unusedFileAction} onOpenAttachment={unusedFileAction} />
  </main>;
}

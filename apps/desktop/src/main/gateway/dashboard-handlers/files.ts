import type { SessionFileRef } from "@lxe/desktop-protocol";
import { previewConversationAttachment, previewConversationImageView } from "../../conversations/conversation-artifacts";
import type { DashboardHandlerContext, DashboardHandlers } from "./context";

/** Opens a conversation file; a failure is reported to the caller as text instead of an RPC error. */
async function openFile(context: DashboardHandlerContext, ref: SessionFileRef, reveal = false): Promise<{ ok: boolean; error: string }> {
  try {
    await context.fileCall({ operation: "open", input: { ref, ...(reveal ? { reveal: true } : {}) } });
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const fileHandlers: DashboardHandlers = {
  "sessions.file.open": async (call, context) => {
    const { ok, error } = await openFile(context, { session_id: call.input.session_id, kind: "artifact", id: call.input.artifact_id });
    return { opened: ok, error };
  },

  "sessions.file.reveal": async (call, context) => {
    const { ok, error } = await openFile(context, { session_id: call.input.session_id, kind: "artifact", id: call.input.artifact_id }, true);
    return { revealed: ok, error };
  },

  "sessions.attachment.open": async (call, context) => {
    const { ok, error } = await openFile(context, { session_id: call.input.session_id, kind: "attachment", id: call.input.attachment_id });
    return { opened: ok, error };
  },

  "sessions.image_view.preview": async (call, { runtime, thumbnails }) => previewConversationImageView({
    resolvePreview: (sessionId, viewId) => runtime.resolveImagePreview(sessionId, "image_view", viewId),
    ...thumbnails,
  }, call.input.session_id, call.input.view_id, call.input.variant),

  "sessions.attachment.preview": async (call, { runtime, parts, thumbnails }) => previewConversationAttachment({
    resolvePreview: async (sessionId, attachmentId) => {
      const stored = await runtime.resolveImagePreview(sessionId, "attachment", attachmentId);
      if (stored?.source === "history") return stored;
      const image = parts.conversations.resolveAttachmentPreviewImage(sessionId, attachmentId);
      if (image) return { source: "history", image };
      if (stored) return stored;
      const path = parts.conversations.resolveAttachmentPreview(sessionId, attachmentId);
      return path ? { source: "current_file", path } : undefined;
    },
    ...thumbnails,
  }, call.input.session_id, call.input.attachment_id, call.input.variant),
};

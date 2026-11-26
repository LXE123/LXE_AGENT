import { readFileSync } from "node:fs";
import type { LocalConversationAttachment } from "@lxe/gateway/desktop";
import type { JsonObject } from "@lxe/protocol";
import type { StagedConversationAttachment } from "./conversation-attachments";

/** External files, including images, are references; only screenshots supply immediate visual input. */
export function prepareConversationAttachments(
  staged: readonly StagedConversationAttachment[],
  prepareImage: (bytes: Uint8Array, mediaType: string) => JsonObject,
): LocalConversationAttachment[] {
  return staged.map((attachment) => ({
    attachment_id: attachment.attachment_id,
    name: attachment.name,
    size_bytes: attachment.size_bytes,
    media_type: attachment.media_type,
    path: attachment.path,
    ...(attachment.origin === "screenshot" ? {
      image_block: prepareImage(readFileSync(attachment.path), attachment.media_type),
    } : {}),
  }));
}

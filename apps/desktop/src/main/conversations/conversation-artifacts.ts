import { DashboardRpcError, type ConversationImagePreviewSource } from "@lxe/desktop-protocol";

export interface ConversationImagePreviewDependencies {
  resolvePreview(sessionId: string, id: string): Promise<ConversationImagePreviewSource | undefined>;
  thumbnail(path: string, edge: number): Promise<string>;
  imageThumbnail(bytes: Uint8Array, edge: number): string;
}

/** Resolution is session-scoped. Corrupt historical images never fall back to a mutable file. */
async function previewImage(dependencies: ConversationImagePreviewDependencies, sessionId: string, id: string,
  variant: "thumbnail" | "expanded", missing: string): Promise<{ data_url: string; source: "history" | "current_file" }> {
  const preview = await dependencies.resolvePreview(sessionId, id);
  if (!preview) throw new DashboardRpcError("not_found", missing);
  const edge = variant === "expanded" ? 1600 : 320;
  if (preview.source === "current_file") return { data_url: await dependencies.thumbnail(preview.path, edge), source: preview.source };
  const source = preview.image.source as { type?: unknown; data?: unknown } | undefined;
  const data = source?.data;
  if (source?.type !== "base64" || typeof data !== "string" || !data.length
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) throw new Error("Historical image contains invalid Base64 data");
  if (data.length > 4 * Math.ceil(20 * 1024 * 1024 / 3)) throw new Error("Image preview source exceeds 20 MiB");
  return { data_url: dependencies.imageThumbnail(Buffer.from(data, "base64"), edge), source: preview.source };
}

export function previewConversationAttachment(dependencies: ConversationImagePreviewDependencies,
  sessionId: string, attachmentId: string, variant: "thumbnail" | "expanded" = "thumbnail") {
  return previewImage(dependencies, sessionId, attachmentId, variant, "attachment is not part of this conversation");
}

export function previewConversationImageView(dependencies: ConversationImagePreviewDependencies,
  sessionId: string, viewId: string, variant: "thumbnail" | "expanded" = "thumbnail") {
  return previewImage(dependencies, sessionId, viewId, variant, "image view is not part of this conversation");
}

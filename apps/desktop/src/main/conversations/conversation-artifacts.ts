import {
  DashboardRpcError,
  type ConversationImagePreviewSource,
  type DesktopConversationFileOpenPayload,
  type DesktopConversationFileRevealPayload,
} from "@lxe/desktop-protocol";

export interface ConversationArtifactOpenDependencies {
  resolveArtifact(sessionId: string, artifactId: string): Promise<string | undefined>;
  openPath(path: string): Promise<string>;
}

export interface ConversationArtifactRevealDependencies {
  resolveArtifact(sessionId: string, artifactId: string): Promise<string | undefined>;
  /** Rejects with the filesystem's own error when the file is gone. */
  assertExists(path: string): Promise<void>;
  revealPath(path: string): void;
}

/**
 * shell.showItemInFolder returns nothing - no success flag, no error text - so
 * the only failures this can report truthfully are the ones that happen before
 * it: an artifact that is not part of the conversation, and a file that has
 * since been moved or deleted. That second check is what makes the common
 * failure visible instead of silently opening a folder without the file in it.
 * Beyond that point there is no signal, and none is invented.
 */
export async function revealConversationArtifact(
  dependencies: ConversationArtifactRevealDependencies,
  sessionId: string,
  artifactId: string,
): Promise<DesktopConversationFileRevealPayload> {
  const path = await dependencies.resolveArtifact(sessionId, artifactId);
  if (!path) throw new DashboardRpcError("not_found", "artifact is not part of this conversation");
  try {
    await dependencies.assertExists(path);
  } catch (cause) {
    return { revealed: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  dependencies.revealPath(path);
  return { revealed: true, error: "" };
}

export async function openConversationArtifact(
  dependencies: ConversationArtifactOpenDependencies,
  sessionId: string,
  artifactId: string,
): Promise<DesktopConversationFileOpenPayload> {
  const path = await dependencies.resolveArtifact(sessionId, artifactId);
  if (!path) throw new DashboardRpcError("not_found", "artifact is not part of this conversation");
  const error = await dependencies.openPath(path);
  return { opened: !error, error };
}

export async function openConversationAttachment(
  dependencies: {
    resolveAttachment(sessionId: string, attachmentId: string): Promise<string | undefined>;
    openPath(path: string): Promise<string>;
  },
  sessionId: string,
  attachmentId: string,
): Promise<DesktopConversationFileOpenPayload> {
  const path = await dependencies.resolveAttachment(sessionId, attachmentId);
  if (!path) throw new DashboardRpcError("not_found", "attachment is not part of this conversation");
  const error = await dependencies.openPath(path);
  return { opened: !error, error };
}

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

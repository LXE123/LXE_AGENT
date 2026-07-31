import {
  DashboardRpcError,
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

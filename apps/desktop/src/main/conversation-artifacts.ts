import { DashboardRpcError, type DesktopConversationFileOpenPayload } from "@lxe/desktop-protocol";

export interface ConversationArtifactOpenDependencies {
  resolveArtifact(sessionId: string, artifactId: string): Promise<string | undefined>;
  openPath(path: string): Promise<string>;
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

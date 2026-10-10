import type { DashboardRpcCall } from "@lxe/desktop-protocol";
import { callDashboard } from "./client";

// Protocol requests only. Selection, drafts and cache coordination belong to the session workflow.
export const sessionActions = {
  create: (directory: string) => callDashboard({ operation: "sessions.create", input: { directory } }),
  registerWorkspace: (directory: string) => callDashboard({ operation: "workspaces.register", input: { directory } }),
  renameWorkspace: (directory: string, display_name: string) => callDashboard({ operation: "workspaces.rename", input: { directory, display_name } }),
  send: (input: DashboardRpcCall<"sessions.send">["input"]) => callDashboard({ operation: "sessions.send", input }),
  stop: (session_id: string) => callDashboard({ operation: "sessions.stop", input: { session_id } }),
  pin: (session_id: string, pinned: boolean) => callDashboard({ operation: "sessions.pin", input: { session_id, pinned } }),
  delete: (session_id: string) => callDashboard({ operation: "sessions.delete", input: { session_id } }),
  openFile: (session_id: string, artifactId: string) => callDashboard({ operation: "sessions.file.open", input: { session_id, artifact_id: artifactId } }),
  revealFile: (session_id: string, artifactId: string) => callDashboard({ operation: "sessions.file.reveal", input: { session_id, artifact_id: artifactId } }),
  openAttachment: (session_id: string, attachmentId: string) => callDashboard({ operation: "sessions.attachment.open", input: { session_id, attachment_id: attachmentId } }),
} as const;

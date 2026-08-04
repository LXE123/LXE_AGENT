import type { JsonObject } from "@lxe/protocol";
import type { ExecShellAdapter } from "../exec-shell";
import type { LxeSkillRuntimeStatus } from "../../operations/lxeskill-runtime";

export interface LxeSkillRecoveryCommand {
  command: string;
  module?: string;
  ownerSkills: readonly string[];
  attributionSkill?: string;
}

export type ProcessStatus = "running" | "completed" | "failed" | "timeout" | "killed";

export type ProcessCompletionConsumeReason =
  | "process.poll"
  | "process.kill";

export interface ProcessCompletionConsumeRequest {
  session_id: string;
  task_id: string;
  status: Exclude<ProcessStatus, "running">;
  reason: ProcessCompletionConsumeReason;
}

export interface CodingToolOptions {
  repositorySkillsRoot?: string;
  userSkillsRoot?: string;
  artifactRoot?: string;
  attachmentPaths?: (sessionId: string) => Promise<readonly string[]>;
  homeDirectory?: string;
  /** Bytes of process output kept in memory and shown to the model at once. */
  maxOutputBytes?: number;
  /** Poll wait window in milliseconds; defaults to the exec yield window. */
  processPollWindowMs?: number;
  onProcessComplete?: (snapshot: JsonObject) => Promise<void> | void;
  onProcessConsume?: (request: ProcessCompletionConsumeRequest) => Promise<void> | void;
  ripgrepPath?: string | null;
  businessCommands?: ReadonlyMap<string, readonly string[]>;
  businessCommandCatalog?: readonly LxeSkillRecoveryCommand[];
  execShell?: ExecShellAdapter;
  execEnv?: (context: { skillNames: readonly string[] }) => Record<string, string>;
  lxeSkillStatus?: () => LxeSkillRuntimeStatus;
}

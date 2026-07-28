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
  | "process.log"
  | "process.kill"
  | "process.remove";

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
  maxOutputChars?: number;
  sendFile?: (request: { path: string; session_id: string; response_route_id: string }) => Promise<void>;
  onProcessComplete?: (snapshot: JsonObject) => Promise<void> | void;
  onProcessConsume?: (request: ProcessCompletionConsumeRequest) => Promise<void> | void;
  ripgrepPath?: string | null;
  businessCommands?: ReadonlyMap<string, readonly string[]>;
  businessCommandCatalog?: readonly LxeSkillRecoveryCommand[];
  execShell?: ExecShellAdapter;
  execEnv?: (context: { skillNames: readonly string[] }) => Record<string, string>;
  lxeSkillStatus?: () => LxeSkillRuntimeStatus;
}

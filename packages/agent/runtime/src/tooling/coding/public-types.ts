import type { ExecutionPaths } from "../../permissions/execution-paths";
import type { PermissionApprovalService } from "../../permissions/approvals";
import type { JsonObject } from "@lxe/protocol";
import type { ExecShellAdapter } from "../exec-shell";

export type ProcessStatus = "running" | "completed" | "failed" | "killed";

export interface CodingToolOptions {
  executionPaths?: ExecutionPaths;
  approvals?: PermissionApprovalService;
  repositorySkillsRoot?: string;
  userSkillsRoot?: string;
  homeDirectory?: string;
  /** Bytes of process output kept in memory and shown to the model at once. */
  maxOutputBytes?: number;
  /** Called once when an exec that already yielded reaches a terminal state. */
  onExecComplete?: (snapshot: JsonObject) => Promise<void> | void;
  /** Bounded live previews, including foreground executions and their final state. */
  onExecUpdate?: (snapshot: JsonObject) => Promise<void> | void;
  ripgrepPath?: string | null;
  fdPath?: string | null;
  execShell?: ExecShellAdapter;
  execEnv?: (context: { skillNames: readonly string[] }) => Record<string, string>;
}

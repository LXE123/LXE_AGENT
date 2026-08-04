import type { JsonObject } from "@lxe/protocol";
import {
  DEFAULT_EXEC_YIELD_MS,
  DEFAULT_WAIT_YIELD_MS,
  type ExecShellAdapter,
  MAX_EXEC_YIELD_MS,
  MAX_WAIT_YIELD_MS,
  MIN_EXEC_YIELD_MS,
  MIN_WAIT_YIELD_MS,
} from "../exec-shell";
import { classifyLxeSkillInput, matchLxeSkillInvocation } from "../lxeskill-command";
import { formatCommandPayload } from "../process-output";
import {
  execCommandParameterDescription,
  execToolDescription,
  type ExecPromptLimits,
} from "./exec-prompt";
import {
  ToolExecutionError,
  type LxeSkillInvocationErrorDetails,
  type LxeSkillInvocationViolation,
  type ToolDefinition,
} from "../registry";
import type { CodingPathPolicy } from "./path-policy";
import type { CodingProcessManager } from "./process-manager";
import type { CodingToolOptions, LxeSkillRecoveryCommand } from "./public-types";

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const commandResult = (payload: JsonObject, displayStatus?: "running" | "error") => ({
  content: textBlock(formatCommandPayload(payload)),
  ...(displayStatus ? { display_status: displayStatus } : {}),
});
const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

const BUSINESS_MODULE_PATTERN = /\b(?:services\.agent_cli(?:\.[A-Za-z_]\w*)+|browser_auth_service\.main)\b/giu;
const LXESKILL_TOKEN_PATTERN = /\blxeskill(?:\.cmd)?\b/iu;
const LXESKILL_MODULE_WRAPPER_PATTERN = /-m\s+lxeskill\b/iu;
const SHELL_COMPOSITION_PATTERN = /[\r\n]|&&|\|\||[;|`<>]|\$\(/u;

const lxeSkillInvocationError = (
  rawCommand: string,
  knownCommands: ReadonlyMap<string, readonly string[]>,
  commandCatalog: readonly LxeSkillRecoveryCommand[],
): ToolExecutionError | undefined => {
  const violations: LxeSkillInvocationViolation[] = [];
  const modules = [...rawCommand.matchAll(BUSINESS_MODULE_PATTERN)].map((match) => String(match[0] ?? ""));
  const hasBusinessModule = modules.length > 0;
  const hasPythonModuleWrapper = LXESKILL_MODULE_WRAPPER_PATTERN.test(rawCommand);
  const hasLxeSkillToken = LXESKILL_TOKEN_PATTERN.test(rawCommand);
  const directLxeSkill = /^lxeskill(?:\.cmd)?(?:\s|$)/iu.test(rawCommand.trim());
  const concernsLxeSkill = hasBusinessModule || hasPythonModuleWrapper || hasLxeSkillToken;

  if (hasBusinessModule) violations.push("direct_business_module");
  if (hasPythonModuleWrapper) violations.push("python_module_wrapper");
  if (hasLxeSkillToken && !directLxeSkill) violations.push("not_standalone");
  if (concernsLxeSkill && SHELL_COMPOSITION_PATTERN.test(rawCommand)) violations.push("shell_composition");
  if (violations.length === 0) return undefined;

  const embeddedCommand = rawCommand.match(/\blxeskill(?:\.cmd)?\b[\s\S]*/iu)?.[0];
  const invocation = embeddedCommand
    ? matchLxeSkillInvocation(embeddedCommand, knownCommands)
    : undefined;
  const moduleEntry = modules
    .map((module) => commandCatalog.find((entry) => entry.module?.toLowerCase() === module.toLowerCase()))
    .find((entry): entry is LxeSkillRecoveryCommand => Boolean(entry));
  const catalogEntry = invocation
    ? commandCatalog.find((entry) => entry.command.toLowerCase() === invocation.command.toLowerCase())
    : moduleEntry;
  const canonicalCommand = invocation?.command ?? catalogEntry?.command;
  const ownerSkills = invocation?.ownerSkills?.length
    ? invocation.ownerSkills
    : catalogEntry?.ownerSkills.length ? [...catalogEntry.ownerSkills] : undefined;
  const details: LxeSkillInvocationErrorDetails = {
    type: "lxeskill_invocation_error",
    violations,
    required_command_shape: "lxeskill <command> [options]",
    use_exec_cwd: true,
    ...(canonicalCommand ? {
      canonical_command_path: canonicalCommand,
      describe_command: canonicalCommand.replace(/^lxeskill\s+/iu, "lxeskill describe "),
    } : { discovery_command: "lxeskill list" }),
    ...(ownerSkills?.length ? { owner_skills: [...ownerSkills] } : {}),
  };
  const code = hasBusinessModule || hasPythonModuleWrapper
    ? "permission_denied"
    : "unsupported_invocation";
  return new ToolExecutionError(
    code,
    "Invalid lxeskill invocation: exec.command must contain exactly one standalone lxeskill command; use exec.cwd for the working directory and do not use uv, python -m, cd, pipes, redirects, or shell operators.",
    details,
    "lxeskill_invocation",
  );
};

export interface ExecToolDependencies {
  paths: CodingPathPolicy;
  processes: CodingProcessManager;
  execShell: ExecShellAdapter;
  /** Inline output budget, quoted in the description so the model stops self-truncating. */
  maxOutputBytes: number;
  options: Pick<
    CodingToolOptions,
    "businessCommands" | "businessCommandCatalog" | "execEnv" | "lxeSkillStatus"
  >;
}

export function createExecTools(dependencies: ExecToolDependencies): ToolDefinition[] {
  const { paths, processes, execShell, options } = dependencies;
  // Resolved once here so the model is told this host's shell rules rather than a
  // description that has to cover every platform at the same time.
  const shellProfile = execShell.shellProfile();
  const promptLimits: ExecPromptLimits = {
    maxOutputBytes: dependencies.maxOutputBytes,
  };
  const commandCatalog = options.businessCommandCatalog ?? [];
  const businessCommands = options.businessCommands ?? new Map(
    commandCatalog.map((entry) => [entry.command, [...entry.ownerSkills]] as const),
  );
  const businessAttributions = new Map(
    commandCatalog
      .filter((entry) => Boolean(entry.attributionSkill))
      .map((entry) => [entry.command, entry.attributionSkill!] as const),
  );

  return [
    {
      name: "exec",
      supportsParallelCalls: true,
      description: execToolDescription(shellProfile, promptLimits),
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: execCommandParameterDescription(shellProfile),
          },
          cwd: { type: "string", description: "Working directory inside the Git worktree; defaults to the session working directory." },
          "yield-time-ms": {
            type: "number", minimum: MIN_EXEC_YIELD_MS, maximum: MAX_EXEC_YIELD_MS, default: DEFAULT_EXEC_YIELD_MS,
            description: "Milliseconds to observe before returning a still-running command with an exec_id.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
      classifyInvocation: (input) => {
        const invocation = classifyLxeSkillInput(input, businessCommands, businessAttributions);
        if (!invocation) return undefined;
        return {
          usageName: `lxeskill:${invocation.commandId}`,
          commandId: invocation.commandId,
          ...(invocation.ownerSkills?.length ? { ownerSkills: invocation.ownerSkills } : {}),
          ...(invocation.attributionSkill ? { attributionSkill: invocation.attributionSkill } : {}),
        };
      },
      execute: async (input, context) => {
        const rawCommand = inputText(input, "command");
        if (!rawCommand.trim()) throw new Error("command 不能为空");
        // The standalone/composition rules keep lxeskill invocations parseable for
        // usage attribution and card display; command authorization itself belongs
        // to the CLI, which rejects unknown or out-of-scope commands with a
        // structured error.
        const ownerIsVisible = (ownerSkills: readonly string[]): boolean =>
          ownerSkills.length === 0
          || !context.exposureState
          || ownerSkills.some((owner) => context.exposureState?.allowsSkill(owner));
        const recoveryCommands = new Map(
          [...businessCommands].filter(([, ownerSkills]) => ownerIsVisible(ownerSkills)),
        );
        const recoveryCatalog = commandCatalog.filter((entry) => ownerIsVisible(entry.ownerSkills));
        const invocationError = lxeSkillInvocationError(rawCommand, recoveryCommands, recoveryCatalog);
        if (invocationError) throw invocationError;
        if (/^lxeskill(?:\.cmd)?(?:\s|$)/iu.test(rawCommand.trim())) {
          const status = options.lxeSkillStatus?.();
          if (status && !status.available) {
            throw new ToolExecutionError(
              "environment_unavailable",
              status.message || "LXE Skill CLI is unavailable",
              {
                type: "lxeskill_runtime_unavailable",
                retryable: false,
                next_action: "report_environment_failure_without_retrying_shell_variations",
                operator_recovery: status.recovery,
              },
            );
          }
        }
        const yieldMs = Number(input["yield-time-ms"] ?? DEFAULT_EXEC_YIELD_MS);
        if (!Number.isFinite(yieldMs) || yieldMs < MIN_EXEC_YIELD_MS || yieldMs > MAX_EXEC_YIELD_MS) {
          throw new Error(`yield-time-ms must be between ${MIN_EXEC_YIELD_MS} and ${MAX_EXEC_YIELD_MS} milliseconds`);
        }
        const command = execShell.normalizeCommand(context.workspace.worktree, rawCommand);
        const payload = await processes.execute({
          command,
          cwd: paths.resolveExecutableCwd(context.workspace, input.cwd ?? "."),
          sessionId: context.session_id,
          responseRouteId: context.response_route_id ?? "",
          workspace: context.workspace,
          yieldMs,
          signal: context.handle.signal,
          toolCallId: context.tool_call_id ?? "",
          ...(context.turn_id === undefined ? {} : { turnId: context.turn_id }),
          ...(options.execEnv ? { env: options.execEnv({ skillNames: context.skill_names ?? [] }) } : {}),
        });
        return commandResult(
          payload,
          payload.status === "running" ? "running" : payload.status === "completed" ? undefined : "error",
        );
      },
    },
    {
      name: "wait",
      supportsParallelCalls: true,
      description: "Wait for a running exec, returning only output produced since the previous observation. Set terminate=true to stop its complete process tree. Different exec ids can be waited concurrently; a completed result closes that exec id for the model.",
      input_schema: {
        type: "object",
        properties: {
          exec_id: { type: "string", description: "Exec id returned by exec." },
          "yield-time-ms": {
            type: "number", minimum: MIN_WAIT_YIELD_MS, maximum: MAX_WAIT_YIELD_MS, default: DEFAULT_WAIT_YIELD_MS,
            description: "Milliseconds to wait for completion before returning currently available new output.",
          },
          terminate: { type: "boolean", default: false, description: "Terminate the complete process tree before returning." },
        },
        required: ["exec_id"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const execId = inputText(input, "exec_id").trim();
        if (!execId) throw new Error("exec_id 不能为空");
        const yieldMs = Number(input["yield-time-ms"] ?? DEFAULT_WAIT_YIELD_MS);
        if (!Number.isFinite(yieldMs) || yieldMs < MIN_WAIT_YIELD_MS || yieldMs > MAX_WAIT_YIELD_MS) {
          throw new Error(`yield-time-ms must be between ${MIN_WAIT_YIELD_MS} and ${MAX_WAIT_YIELD_MS} milliseconds`);
        }
        return commandResult(await processes.wait({
          execId,
          sessionId: context.session_id,
          yieldMs,
          terminate: input.terminate === true,
          signal: context.handle.signal,
        }));
      },
    },
  ];
}

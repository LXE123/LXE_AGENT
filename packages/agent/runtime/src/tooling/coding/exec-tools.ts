import type { JsonObject } from "@lxe/protocol";
import {
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  DEFAULT_EXEC_YIELD_MS,
  type ExecShellAdapter,
  MAX_EXEC_TIMEOUT_SECONDS,
} from "../exec-shell";
import { classifyLxeSkillInput, matchLxeSkillInvocation } from "../lxeskill-command";
import { formatCommandPayload } from "../process-output";
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
const commandResult = (payload: JsonObject) => ({ content: textBlock(formatCommandPayload(payload)) });
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
  options: Pick<
    CodingToolOptions,
    "businessCommands" | "businessCommandCatalog" | "execEnv" | "lxeSkillStatus"
  >;
}

export function createExecTools(dependencies: ExecToolDependencies): ToolDefinition[] {
  const { paths, processes, execShell, options } = dependencies;
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
      description: "Execute shell commands with background continuation. Windows uses PowerShell; macOS/Linux use /bin/sh without loading user profiles. Python and pip use this project's .venv; lxeskill prefers the precompiled project runtime and falls back to .venv in development. A lxeskill invocation must be the only command in command; use cwd instead of cd and do not wrap it with uv, python -m, pipes, redirects, or shell operators.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command string. For lxeskill, provide exactly one standalone `lxeskill <command> [options]`; do not use uv, python -m, cd, newlines, pipes, redirects, &&, ||, semicolons, backticks, or $(). Use cwd for the working directory. Help/list/describe commands follow the same rule.",
          },
          cwd: { type: "string", description: "Working directory inside the Git worktree; defaults to the session working directory." },
          timeout: {
            type: "number", minimum: 1, maximum: MAX_EXEC_TIMEOUT_SECONDS, default: DEFAULT_EXEC_TIMEOUT_SECONDS,
            description: "Foreground timeout in seconds (default 120, maximum 3600). Ignored when background=true.",
          },
          background: { type: "boolean", default: false, description: "Start in the background immediately." },
          yield_ms: {
            type: "number", minimum: 1, default: DEFAULT_EXEC_YIELD_MS,
            description: "Milliseconds to wait before a still-running foreground command moves to the background.",
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
        const background = input.background === true;
        const timeoutSeconds = Number(input.timeout ?? DEFAULT_EXEC_TIMEOUT_SECONDS);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_EXEC_TIMEOUT_SECONDS) {
          throw new Error(`timeout must be between 1 and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
        }
        const yieldMs = Number(input.yield_ms ?? DEFAULT_EXEC_YIELD_MS);
        if (!Number.isFinite(yieldMs) || yieldMs < 1) throw new Error("yield_ms must be a positive number of milliseconds");
        const command = execShell.normalizeCommand(context.workspace.worktree, rawCommand);
        const payload = await processes.execute({
          command,
          cwd: paths.resolveExecutableCwd(context.workspace, input.cwd ?? "."),
          sessionId: context.session_id,
          responseRouteId: context.response_route_id ?? "",
          workspace: context.workspace,
          background,
          yieldMs,
          ...(!background ? { timeoutMs: timeoutSeconds * 1_000 } : {}),
          handle: context.handle,
          ...(context.turn_id === undefined ? {} : { turnId: context.turn_id }),
          ...(options.execEnv ? { env: options.execEnv({ skillNames: context.skill_names ?? [] }) } : {}),
        });
        return commandResult(payload);
      },
    },
    {
      name: "process",
      description: "Inspect or stop background exec sessions: list them, poll one for new output, or kill one. Completed sessions notify you on their own, so poll only when you need progress before then. Output past the size limit is not in these results; read the output_path file with grep or read instead.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "poll", "kill"],
            description: "list: sessions in this chat. poll: new output since your last poll. kill: terminate a running session.",
          },
          session: { type: "string", description: "Session id from exec, required by poll and kill." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input, context) => commandResult(await processes.process(input, context.session_id)),
    },
  ];
}

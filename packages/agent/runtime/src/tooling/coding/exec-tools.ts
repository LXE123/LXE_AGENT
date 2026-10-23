import { approveIfNeeded, requestedPolicy, permissionInputProperties, permissionToolDescription } from "../../permissions/approvals";
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
import {
  DEFAULT_COMMAND_OUTPUT_TOKENS,
  formatCommandPayloadWithBudget,
} from "../process-output";
import {
  execCommandParameterDescription,
  execToolDescription,
  type ExecPromptLimits,
} from "./exec-prompt";
import {
  ToolExecutionError,
  type ToolDefinition,
} from "../registry";
import type { CodingPathPolicy } from "./path-policy";
import type { CodingProcessManager } from "./process-manager";
import type { CodingToolOptions } from "./public-types";

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const MIN_COMMAND_OUTPUT_TOKENS = 1;
const MAX_COMMAND_OUTPUT_TOKENS = 10_000;

const outputTokenBudget = (input: JsonObject): number => {
  const value = Number(input["max-output-tokens"] ?? DEFAULT_COMMAND_OUTPUT_TOKENS);
  if (
    !Number.isInteger(value)
    || value < MIN_COMMAND_OUTPUT_TOKENS
    || value > MAX_COMMAND_OUTPUT_TOKENS
  ) {
    throw new Error(
      `max-output-tokens must be an integer between ${MIN_COMMAND_OUTPUT_TOKENS} and ${MAX_COMMAND_OUTPUT_TOKENS}`,
    );
  }
  return value;
};

const commandResult = async (
  payload: JsonObject,
  processes: CodingProcessManager,
  sessionId: string,
  maxOutputTokens: number,
  displayStatus?: "running" | "error",
) => {
  let formatted = formatCommandPayloadWithBudget(payload, maxOutputTokens);
  if (formatted.observationTruncated) {
    const execId = String(payload.exec_id ?? "").trim();
    if (execId) Object.assign(payload, await processes.ensureOutputFile(execId, sessionId));
    formatted = formatCommandPayloadWithBudget(payload, maxOutputTokens);
  }
  return {
    content: textBlock(formatted.text),
    ...(displayStatus ? { display_status: displayStatus } : {}),
  };
};
const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

export interface ExecToolDependencies {
  paths: CodingPathPolicy;
  processes: CodingProcessManager;
  execShell: ExecShellAdapter;
  /** Inline output budget, quoted in the description so the model stops self-truncating. */
  maxOutputBytes: number;
  options: Pick<
    CodingToolOptions,
    "execEnv" | "approvals"
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
  return [
    {
      name: "exec",
      supportsParallelCalls: true,
      description: execToolDescription(shellProfile, promptLimits) + permissionToolDescription,
      input_schema: {
        type: "object",
        properties: {
          ...permissionInputProperties,
          command: {
            type: "string",
            description: execCommandParameterDescription(shellProfile),
          },
          cwd: { type: "string", description: "Any working directory accessible to the local LXE Agent process; defaults to the session working directory." },
          "yield-time-ms": {
            type: "number", minimum: MIN_EXEC_YIELD_MS, maximum: MAX_EXEC_YIELD_MS, default: DEFAULT_EXEC_YIELD_MS,
            description: "Milliseconds to observe before returning a still-running command with an exec_id.",
          },
          "max-output-tokens": {
            type: "integer",
            minimum: MIN_COMMAND_OUTPUT_TOKENS,
            maximum: MAX_COMMAND_OUTPUT_TOKENS,
            default: DEFAULT_COMMAND_OUTPUT_TOKENS,
            description: "Maximum model-visible output budget for this observation. Control metadata is always preserved.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        if (!context.executionPolicy) throw new ToolExecutionError("failed_precondition", "exec requires a runtime execution policy");
        input = structuredClone(input);
        const policy = requestedPolicy(input, context.executionPolicy);
        const rawCommand = inputText(input, "command");
        if (!rawCommand.trim()) throw new Error("command 不能为空");
        const yieldMs = Number(input["yield-time-ms"] ?? DEFAULT_EXEC_YIELD_MS);
        if (!Number.isFinite(yieldMs) || yieldMs < MIN_EXEC_YIELD_MS || yieldMs > MAX_EXEC_YIELD_MS) {
          throw new Error(`yield-time-ms must be between ${MIN_EXEC_YIELD_MS} and ${MAX_EXEC_YIELD_MS} milliseconds`);
        }
        const maxOutputTokens = outputTokenBudget(input);
        const command = execShell.normalizeCommand(context.workspace.worktree, rawCommand);
        const cwd = paths.resolveExecutableCwd(context.workspace, input.cwd ?? ".");
        const boundary = processes.boundary(policy);
        if (policy.mode !== context.executionPolicy.mode) await approveIfNeeded(options.approvals, "exec", input, context, policy, { command, cwd, ...(command === rawCommand ? {} : { requested_command: rawCommand }) });
        const payload = await processes.execute({
          executionPolicy: policy, boundary,
          command,
          cwd,
          sessionId: context.session_id,
          responseRouteId: context.response_route_id ?? "",
          workspace: context.workspace,
          yieldMs,
          signal: context.handle.signal,
          toolCallId: context.tool_call_id ?? "",
          ...(context.turn_id === undefined ? {} : { turnId: context.turn_id }),
          ...(options.execEnv ? { env: options.execEnv({ skillNames: context.skill_names ?? [] }) } : {}),
        });
        return await commandResult(
          payload,
          processes,
          context.session_id,
          maxOutputTokens,
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
          "max-output-tokens": {
            type: "integer",
            minimum: MIN_COMMAND_OUTPUT_TOKENS,
            maximum: MAX_COMMAND_OUTPUT_TOKENS,
            default: DEFAULT_COMMAND_OUTPUT_TOKENS,
            description: "Maximum model-visible new-output budget for this observation. Control metadata is always preserved.",
          },
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
        const maxOutputTokens = outputTokenBudget(input);
        return await commandResult(await processes.wait({
          execId,
          sessionId: context.session_id,
          yieldMs,
          terminate: input.terminate === true,
          signal: context.handle.signal,
        }), processes, context.session_id, maxOutputTokens);
      },
    },
  ];
}

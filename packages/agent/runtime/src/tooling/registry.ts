import type { JsonObject, WorkspaceContext } from "@lxe/protocol";
import type { RuntimeHandle, ToolExecutionResult, ToolSchema } from "../engine/types";
import type { WorkspaceSearchService } from "./workspace-search";

export interface ToolDefinition extends ToolSchema {
  source?: "native" | "mcp";
  exposure?: "direct" | "deferred";
  ownerSkills?: string[];
  connectorName?: string;
  rawName?: string;
  classifyInvocation?: (input: JsonObject) => {
    usageName?: string;
    commandId?: string;
    ownerSkills?: string[];
    attributionSkill?: string;
  } | undefined;
  execute(input: JsonObject, context: {
    handle: RuntimeHandle;
    session_id: string;
    response_route_id?: string;
    turn_id?: string;
    tool_call_id?: string;
    exposureState?: ToolExposureState;
    skill_names?: readonly string[];
    workspace: WorkspaceContext;
    workspaceSearch?: WorkspaceSearchService;
  }): Promise<ToolExecutionResult>;
}

export interface ToolExposureOptions {
  allowedSkills?: ReadonlySet<string>;
  disabledConnectors?: ReadonlySet<string>;
  onSkillActivated?: (skillName: string) => Promise<void> | void;
}

export type LxeSkillInvocationViolation =
  | "direct_business_module"
  | "python_module_wrapper"
  | "not_standalone"
  | "shell_composition";

export interface LxeSkillInvocationErrorDetails extends JsonObject {
  type: "lxeskill_invocation_error";
  violations: LxeSkillInvocationViolation[];
  required_command_shape: "lxeskill <command> [options]";
  use_exec_cwd: true;
  canonical_command_path?: string;
  owner_skills?: string[];
  describe_command?: string;
  discovery_command?: "lxeskill list";
}

export type ToolExecutionErrorCode =
  | "environment_unavailable"
  | "permission_denied"
  | "unsupported_invocation"
  | "unclassified"
  | "invalid_argument"
  | "failed_precondition"
  | "not_found"
  | "unavailable"
  | "external_api_error";

export interface ToolFailureDetails extends JsonObject {
  type: "tool_failure";
  operation: string;
  cause_known: boolean;
  observed_message: string;
  verified_reason?: string;
  mapping_id?: string;
  provider?: string;
  http_status?: number;
  provider_code?: number | string;
  provider_subcode?: number | string;
  log_id?: string;
  retryability: "retryable" | "not_retryable" | "unknown";
  next_action: string;
  inference_policy: "verified_reason_only";
}

export interface UnclassifiedToolFailureDetails extends ToolFailureDetails {
  code: "unclassified";
}

const TOOL_ERROR_SECRET = /(token|secret|password|api[-_]?key|authorization|cookie)\s*[=:]\s*[^\s,;]+/giu;

export const safeToolFailureObservation = (value: unknown): string =>
  String(value ?? "")
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/-]+=*/giu, "$1 [redacted]")
    .replace(TOOL_ERROR_SECRET, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500) || "Tool execution failed without an error message";

export function unknownToolFailureDetails(operation: string, error: unknown): UnclassifiedToolFailureDetails {
  return {
    type: "tool_failure",
    code: "unclassified",
    operation: operation.trim() || "unknown_tool",
    cause_known: false,
    observed_message: safeToolFailureObservation(error instanceof Error ? error.message : error),
    retryability: "unknown",
    next_action: "Report only the observed failure. Do not infer a cause or retry unless another verified input supports it.",
    inference_policy: "verified_reason_only",
  };
}

export class ToolExecutionError extends Error {
  constructor(
    readonly code: ToolExecutionErrorCode,
    message: string,
    readonly details?: JsonObject,
    readonly recoveryGroup?: string,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }

  modelContent(attempt?: number): string {
    if (!this.details) return this.message;
    const retryable = attempt === undefined || attempt <= 1;
    return JSON.stringify({
      ...structuredClone(this.details),
      code: this.code,
      message: this.message,
      ...(attempt === undefined ? {} : {
        attempt,
        retryable,
        next_action: retryable
          ? "read_owner_skill_or_run_standalone_describe_then_retry_once"
          : "stop_retrying_shell_variations_and_report",
      }),
    }, null, 2);
  }
}

const schemaOf = ({ name, description, input_schema }: ToolDefinition): ToolSchema => ({
  name,
  description,
  input_schema: structuredClone(input_schema),
});

export class ToolExposureState {
  private readonly exposed = new Set<string>();
  private readonly activatedSkills = new Set<string>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: ToolExposureOptions = {},
  ) {
    for (const definition of registry.definitionsSnapshot()) {
      if (definition.exposure === "direct" && this.allowed(definition)) this.exposed.add(definition.name);
    }
  }

  schemas(): ToolSchema[] {
    return this.registry.definitionsSnapshot()
      .filter((definition) => this.exposed.has(definition.name) && this.allowed(definition))
      .map(schemaOf);
  }

  search(query: string, limit = 8): ToolSchema[] {
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
    if (terms.length === 0) throw new Error("tool_search query must contain a specific capability");
    const matches = this.registry.definitionsSnapshot().filter((definition) =>
      definition.name !== "tool_search" && this.allowed(definition)
    ).map((definition) => {
      const haystack = `${definition.name} ${definition.rawName ?? ""} ${definition.description} ${JSON.stringify(definition.input_schema)}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { definition, score };
    }).filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.definition.name.localeCompare(right.definition.name))
      .slice(0, Math.max(1, Math.min(Math.trunc(limit), 20)));
    for (const { definition } of matches) this.exposed.add(definition.name);
    return matches.map(({ definition }) => schemaOf(definition));
  }

  async activateSkill(skillName: string): Promise<void> {
    const name = skillName.trim();
    if (!name || this.activatedSkills.has(name)) return;
    if (this.options.allowedSkills && !this.options.allowedSkills.has(name)) {
      throw new Error(`skill is not allowed for this bot or connector: ${name}`);
    }
    this.activatedSkills.add(name);
    for (const definition of this.registry.definitionsSnapshot()) {
      if (definition.ownerSkills.includes(name) && this.allowed(definition)) this.exposed.add(definition.name);
    }
    await this.options.onSkillActivated?.(name);
  }

  isExposed(name: string): boolean {
    const definition = this.registry.definition(name);
    return Boolean(definition && this.exposed.has(definition.name) && this.allowed(definition));
  }

  allowsSkill(name: string): boolean {
    const skillName = name.trim();
    return Boolean(skillName) && (!this.options.allowedSkills || this.options.allowedSkills.has(skillName));
  }

  private allowed(definition: NormalizedToolDefinition): boolean {
    if (definition.connectorName && this.options.disabledConnectors?.has(definition.connectorName)) return false;
    if (definition.ownerSkills.length > 0 && this.options.allowedSkills) {
      return definition.ownerSkills.some((skill) => this.options.allowedSkills?.has(skill));
    }
    return true;
  }
}

export interface NormalizedToolDefinition extends ToolDefinition {
  source: "native" | "mcp";
  exposure: "direct" | "deferred";
  ownerSkills: string[];
}

export class ToolRegistry {
  private readonly definitions = new Map<string, NormalizedToolDefinition>();

  register(definition: ToolDefinition): void {
    const name = definition.name.trim();
    if (!name) throw new Error("tool name is required");
    if (this.definitions.has(name)) throw new Error(`duplicate tool name: ${name}`);
    const source = definition.source ?? "native";
    this.definitions.set(name, {
      ...definition,
      name,
      source,
      exposure: definition.exposure ?? (source === "native" ? "direct" : "deferred"),
      ownerSkills: [...new Set((definition.ownerSkills ?? []).map((item) => item.trim()).filter(Boolean))],
    });
  }

  schemas(): ToolSchema[] {
    return [...this.definitions.values()].map(schemaOf);
  }

  definitionsSnapshot(): NormalizedToolDefinition[] {
    return [...this.definitions.values()];
  }

  definition(name: string): NormalizedToolDefinition | undefined {
    return this.definitions.get(name.trim());
  }

  createExposureState(options: ToolExposureOptions = {}): ToolExposureState {
    return new ToolExposureState(this, options);
  }

  unregisterWhere(predicate: (name: string) => boolean): void {
    for (const name of this.definitions.keys()) {
      if (predicate(name)) this.definitions.delete(name);
    }
  }

  async execute(
    name: string,
    input: JsonObject,
    context: {
      handle: RuntimeHandle;
      session_id: string;
      response_route_id?: string;
      turn_id?: string;
      tool_call_id?: string;
      exposureState?: ToolExposureState;
      skill_names?: readonly string[];
      workspace: WorkspaceContext;
      workspaceSearch?: WorkspaceSearchService;
    },
  ): Promise<ToolExecutionResult> {
    const definition = this.definitions.get(name.trim());
    if (!definition) throw new Error(`unknown tool: ${name}`);
    if (context.exposureState && !context.exposureState.isExposed(name)) {
      throw new Error(`tool is not exposed for this turn: ${name}`);
    }
    // Classified invocations (lxeskill commands) are not authorized here:
    // the CLI is the single authority and rejects out-of-scope commands with
    // a structured skill_not_in_scope error. The registry only gates tool
    // exposure; classifyInvocation stays an attribution concern.
    if (context.handle.signal.aborted) throw new DOMException("Turn cancelled", "AbortError");
    return definition.execute(input, context);
  }
}

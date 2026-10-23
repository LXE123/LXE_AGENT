/** Desktop-owned schedules. Agent execution state is queried through Agent RPC. */
export type AutomationSchedule =
  | { kind: "once"; at: number }
  | { kind: "interval"; minutes: number }
  | { kind: "rrule"; rule: string; start_at: number };

export type AutomationTarget =
  | { mode: "reuse"; session_id: string }
  | { mode: "new"; workspace_id: string; model?: { provider: string; model: string; credential_source: "local" | "cloud" } };

export interface AutomationDefinition {
  name: string;
  prompt: string;
  timezone: string;
  schedule: AutomationSchedule;
  target: AutomationTarget;
}

export interface Automation extends AutomationDefinition {
  id: string;
  version: number;
  status: "active" | "paused" | "finished" | "deleted";
  schedule_anchor_at: number;
  next_nominal_at: number | null;
  next_run_at: number | null;
  recheck_at: number | null;
  last_triggered_at: number | null;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  automation_version: number;
  definition: AutomationDefinition;
  trigger: "scheduled" | "manual";
  nominal_at: number;
  session_id: string;
  turn_id: string;
  dispatch_state: "prepared" | "accepted" | "failed" | "unknown";
  error: string | null;
  created_at: number;
  accepted_at: number | null;
}

export interface AutomationRunView extends AutomationRun {
  execution_state: "queued" | "running" | "stopping" | "waiting_input" | "waiting_approval" | "completed" | "cancelled" | "error" | "unknown";
  execution_error?: string;
}

export interface AutomationRpcSpec {
  "automations.list": { input: Record<string, never>; result: { items: Automation[] } };
  "automations.save": { input: { definition: AutomationDefinition; id?: string; version?: number }; result: Automation };
  "automations.status": { input: { id: string; version: number; status: "active" | "paused" }; result: Automation };
  "automations.delete": { input: { id: string; version: number }; result: { deleted: true } };
  "automations.run": { input: { id: string }; result: AutomationRun };
  "automations.runs": { input: { id: string; limit?: number }; result: { items: AutomationRunView[] } };
  "automations.preview": { input: { definition: AutomationDefinition }; result: { times: number[]; jitter_seconds: number } };
  "automations.editing": { input: { session_id: string; editing: boolean }; result: { accepted: true } };
}

export type AutomationOperation = keyof AutomationRpcSpec;
export const AUTOMATION_OPERATIONS: readonly AutomationOperation[] = [
  "automations.list", "automations.save", "automations.status", "automations.delete",
  "automations.run", "automations.runs", "automations.preview", "automations.editing",
];

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unsupported fields: ${unknown.join(", ")}`);
};
const text = (value: unknown, name: string, limit = 8192): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${name} must be nonempty text (at most ${limit} characters)`);
  return value.trim();
};
const integer = (value: unknown, name: string, min = 0, max = 8_640_000_000_000_000): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
};

export function parseAutomationDefinition(value: unknown): AutomationDefinition {
  const input = object(value);
  keys(input, ["name", "prompt", "timezone", "schedule", "target"]);
  const timezone = text(input.timezone, "timezone", 100);
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  const scheduleInput = object(input.schedule);
  let schedule: AutomationSchedule;
  switch (scheduleInput.kind) {
    case "once":
      keys(scheduleInput, ["kind", "at"]);
      schedule = { kind: "once", at: integer(scheduleInput.at, "at") };
      break;
    case "interval":
      keys(scheduleInput, ["kind", "minutes"]);
      schedule = { kind: "interval", minutes: integer(scheduleInput.minutes, "minutes", 1, 525600) };
      break;
    case "rrule":
      keys(scheduleInput, ["kind", "rule", "start_at"]);
      schedule = { kind: "rrule", rule: text(scheduleInput.rule, "rule", 2048), start_at: integer(scheduleInput.start_at, "start_at") };
      break;
    default: throw new Error("schedule.kind must be once, interval or rrule");
  }
  const targetInput = object(input.target);
  let target: AutomationTarget;
  if (targetInput.mode === "reuse") {
    keys(targetInput, ["mode", "session_id"]);
    target = { mode: "reuse", session_id: text(targetInput.session_id, "session_id", 128) };
  } else if (targetInput.mode === "new") {
    keys(targetInput, ["mode", "workspace_id", "model"]);
    target = { mode: "new", workspace_id: text(targetInput.workspace_id, "workspace_id", 128) };
    if (targetInput.model !== undefined) {
      const model = object(targetInput.model);
      keys(model, ["provider", "model", "credential_source"]);
      if (model.credential_source !== "local" && model.credential_source !== "cloud") throw new Error("Invalid credential_source");
      target.model = { provider: text(model.provider, "provider", 128), model: text(model.model, "model", 256), credential_source: model.credential_source };
    }
  } else throw new Error("target.mode must be new or reuse");
  return { name: text(input.name, "name", 120), prompt: text(input.prompt, "prompt", 32768), timezone, schedule, target };
}

export function parseAutomationCall(operation: string, value: unknown): { [K in AutomationOperation]: { operation: K; input: AutomationRpcSpec[K]["input"] } }[AutomationOperation] {
  const input = object(value);
  switch (operation) {
    case "automations.list": keys(input, []); return { operation, input: {} };
    case "automations.save": {
      keys(input, ["definition", "id", "version"]);
      if ((input.id === undefined) !== (input.version === undefined)) throw new Error("Updating a task requires id and version");
      return { operation, input: { definition: parseAutomationDefinition(input.definition), ...(input.id === undefined ? {} : { id: text(input.id, "id", 128), version: integer(input.version, "version", 1) }) } };
    }
    case "automations.status":
      keys(input, ["id", "version", "status"]);
      if (input.status !== "active" && input.status !== "paused") throw new Error("Invalid task status");
      return { operation, input: { id: text(input.id, "id", 128), version: integer(input.version, "version", 1), status: input.status } };
    case "automations.delete":
      keys(input, ["id", "version"]);
      return { operation, input: { id: text(input.id, "id", 128), version: integer(input.version, "version", 1) } };
    case "automations.run":
      keys(input, ["id"]); return { operation, input: { id: text(input.id, "id", 128) } };
    case "automations.runs":
      keys(input, ["id", "limit"]); return { operation, input: { id: text(input.id, "id", 128), limit: input.limit === undefined ? 50 : integer(input.limit, "limit", 1, 200) } };
    case "automations.preview":
      keys(input, ["definition"]); return { operation, input: { definition: parseAutomationDefinition(input.definition) } };
    case "automations.editing":
      keys(input, ["session_id", "editing"]);
      if (typeof input.editing !== "boolean") throw new Error("editing must be boolean");
      return { operation, input: { session_id: text(input.session_id, "session_id", 128), editing: input.editing } };
    default: throw new Error(`Unknown automation operation: ${operation}`);
  }
}

export const DESKTOP_MCP_NAME = "lxe_desktop";
export const DESKTOP_MCP_META = "lxe.desktop/caller";
export const DESKTOP_MCP_PIPE_VERSION = 1;
export interface DesktopMcpCaller { session_id: string; turn_id: string; tool_call_id: string; platform: "desktop" }

export const AUTOMATION_DEFINITION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["prompt", "timezone", "schedule", "target"],
  properties: {
    name: { type: "string", maxLength: 120, description: "Optional task name; omit or leave blank to generate from prompt" }, prompt: { type: "string", maxLength: 32768 }, timezone: { type: "string", description: "IANA timezone, for example Asia/Shanghai" },
    schedule: { oneOf: [
      { type: "object", additionalProperties: false, required: ["kind", "at"], properties: { kind: { const: "once" }, at: { type: "integer", description: "UTC Unix milliseconds" } } },
      { type: "object", additionalProperties: false, required: ["kind", "minutes"], properties: { kind: { const: "interval" }, minutes: { type: "integer", minimum: 1, maximum: 525600 } } },
      { type: "object", additionalProperties: false, required: ["kind", "rule", "start_at"], properties: { kind: { const: "rrule" }, rule: { type: "string", description: "Single RRULE, without DTSTART or TZID" }, start_at: { type: "integer", description: "UTC Unix milliseconds of schedule start" } } },
    ] },
    target: { oneOf: [
      { type: "object", additionalProperties: false, required: ["mode", "session_id"], properties: { mode: { const: "reuse" }, session_id: { type: "string", description: "Use current to bind the calling chat" } } },
      { type: "object", additionalProperties: false, required: ["mode", "workspace_id"], properties: { mode: { const: "new" }, workspace_id: { type: "string", description: "Workspace ID returned by automation_list" }, model: {
        type: "object", additionalProperties: false, required: ["provider", "model", "credential_source"], properties: { provider: { type: "string" }, model: { type: "string" }, credential_source: { enum: ["local", "cloud"] } },
      }, effort: { type: "string", maxLength: 64, description: "Optional thinking level supported by the selected model; omit to inherit the model setting" } } },
    ] },
  },
};
